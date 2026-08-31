import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { cp, mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, posix, relative, resolve, sep, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
  PROJECT_SUPABASE_ARCHITECTURES,
  PROJECT_SUPABASE_REQUIRED_SERVICES,
  hashConfigurationTree,
  latestSelfHostedTag,
  normalizeUpgradeGates,
  readProjectSupabaseLock,
  validateProjectSupabaseLock,
} from './lib/project-supabase-lock.mjs'
import { ensureDockerEngine } from './lib/docker-runtime.mjs'

const execFileAsync = promisify(execFile)
const root = resolve(fileURLToPath(new URL('../', import.meta.url)))
const repository = 'https://github.com/supabase/supabase.git'
// A transport mirror may be selected in restricted networks, but it cannot
// change the reviewed source identity: annotated tag object, peeled commit,
// configuration tree and runtime contract hashes are all checked below.
const fetchRepository = process.env.OPENLINK_SUPABASE_FETCH_REPOSITORY?.trim() || repository
const lockPath = resolve(root, 'services/project-supabase/runtime.lock.json')
const outputRoot = resolve(root, '.openlink-runtime/project-supabase')
const argumentsSet = new Set(process.argv.slice(2))
const updateLock = argumentsSet.has('--update-lock')
const refreshRuntimeSpec = argumentsSet.has('--refresh-runtime-spec')
const offline = argumentsSet.has('--offline')
const tagArgument = process.argv.find((value) => value.startsWith('--tag='))?.slice('--tag='.length)
let docker

export function parseLsRemoteTags(output) {
  const refs = new Map()
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue
    const match = line.match(/^([a-f0-9]{40})\s+refs\/tags\/(self-hosted\/v[^\s^]+)(\^\{\})?$/)
    if (!match) continue
    const [, object, tag, peeled] = match
    const value = refs.get(tag) ?? {}
    if (peeled) value.commit = object
    else value.tagObject = object
    refs.set(tag, value)
  }
  return refs
}

export function parseComposeServices(compose) {
  if (!compose || typeof compose !== 'object' || !compose.services || typeof compose.services !== 'object') throw new Error('Supabase Compose JSON is invalid')
  const services = []
  for (const name of PROJECT_SUPABASE_REQUIRED_SERVICES) {
    const service = compose.services[name]
    if (!service || typeof service !== 'object') throw new Error(`Upstream Supabase Compose is missing required service ${name}`)
    if (typeof service.image !== 'string' || !service.image.includes(':')) throw new Error(`Upstream Supabase service ${name} has no tagged image`)
    const aliases = []
    for (const network of Object.values(service.networks ?? {})) {
      if (!network || typeof network !== 'object' || !Array.isArray(network.aliases)) continue
      for (const alias of network.aliases) if (alias !== name && !aliases.includes(alias)) aliases.push(alias)
    }
    services.push({ name, image: service.image, aliases: aliases.sort() })
  }
  const unexpected = Object.keys(compose.services).filter((name) => !PROJECT_SUPABASE_REQUIRED_SERVICES.includes(name))
  if (unexpected.length) throw new Error(`Upstream default Supabase Compose contains unreviewed services: ${unexpected.sort().join(', ')}`)
  return services
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key])]))
}

export function normalizeRuntimeSpec(compose, configurationRoot) {
  if (!compose || typeof compose !== 'object' || !compose.services || typeof compose.services !== 'object') throw new Error('Supabase Compose JSON is invalid')
  const spec = structuredClone(compose)
  delete spec.name
  for (const service of Object.values(spec.services)) {
    delete service.container_name
    if (Array.isArray(service.volumes)) {
      for (const volume of service.volumes) {
        if (volume?.type !== 'bind' || typeof volume.source !== 'string') continue
        const pathApi = configurationRoot.startsWith('/') && volume.source.startsWith('/')
          ? posix
          : /^[A-Za-z]:[\\/]/.test(configurationRoot) || /^[A-Za-z]:[\\/]/.test(volume.source)
            ? win32
            : { resolve, relative, isAbsolute, sep }
        const lockedRoot = pathApi.resolve(configurationRoot)
        const source = pathApi.resolve(volume.source)
        const relativeSource = pathApi.relative(lockedRoot, source)
        if (!relativeSource || relativeSource === '..' || relativeSource.startsWith(`..${pathApi.sep}`) || pathApi.isAbsolute(relativeSource)) {
          throw new Error(`Supabase runtime bind mount escapes the locked configuration root: ${source}`)
        }
        volume.source = `configuration/${relativeSource.split(pathApi.sep).join('/')}`
        if (volume.bind && typeof volume.bind === 'object') delete volume.bind.create_host_path
      }
    }
  }
  // Docker Compose prefixes named volumes with the project name in its
  // rendered JSON. The guest controller owns project-local naming and needs
  // the logical keys declared in `compose.volumes` so dependency references
  // remain stable across upstream project-name changes.
  const physicalToLogicalVolumes = new Map()
  for (const [logical, definition] of Object.entries(spec.volumes ?? {})) {
    physicalToLogicalVolumes.set(logical, logical)
    physicalToLogicalVolumes.set(definition?.name || logical, logical)
  }
  for (const service of Object.values(spec.services)) {
    for (const volume of service.volumes ?? []) {
      if (volume?.type !== 'volume') continue
      const logical = physicalToLogicalVolumes.get(volume.source)
      if (!logical) throw new Error(`Supabase runtime references undeclared named volume ${volume.source}`)
      volume.source = logical
    }
  }
  for (const definition of Object.values(spec.volumes ?? {})) if (definition && typeof definition === 'object') delete definition.name
  // `docker compose config --no-interpolate` retains Compose's `$$` escape.
  // The runtime controller bypasses Compose and passes command strings
  // directly to the container, so translate it back to the intended single
  // shell dollar while compiling the reviewed contract.
  const unescapeComposeDollar = (value) => {
    if (typeof value === 'string') return value.replaceAll('$$', '$')
    if (Array.isArray(value)) return value.map(unescapeComposeDollar)
    return value
  }
  for (const service of Object.values(spec.services)) {
    service.command = unescapeComposeDollar(service.command)
    service.entrypoint = unescapeComposeDollar(service.entrypoint)
  }
  // Supabase's official add-new-auth-keys.sh enables these four environment
  // entries after generating the asymmetric key pair. Project VMs are
  // non-interactive, so bake that documented official transformation into the
  // reviewed runtime spec and generate independent keys on first initialize.
  spec.services.auth.environment.GOTRUE_JWT_KEYS = '${JWT_KEYS}'
  spec.services.realtime.environment.API_JWT_JWKS = '${JWT_JWKS}'
  spec.services.storage.environment.JWT_JWKS = '${JWT_JWKS}'
  spec.services.functions.environment.SUPABASE_JWKS = '${JWT_JWKS}'
  return sortJson({ schemaVersion: 1, compose: spec })
}

export function platformDescriptors(rawManifest, image) {
  const manifest = typeof rawManifest === 'string' ? JSON.parse(rawManifest) : rawManifest
  if (!manifest || typeof manifest !== 'object' || !Array.isArray(manifest.manifests)) throw new Error(`Image ${image} is not a multi-platform OCI index`)
  const platforms = {}
  for (const architecture of PROJECT_SUPABASE_ARCHITECTURES) {
    const candidates = manifest.manifests.filter((entry) => entry?.platform?.os === 'linux' && entry.platform.architecture === architecture && !entry.platform.variant)
    if (candidates.length !== 1) throw new Error(`Image ${image} must contain exactly one linux/${architecture} platform manifest`)
    const descriptor = candidates[0]
    if (!/^sha256:[a-f0-9]{64}$/.test(descriptor.digest) || !Number.isSafeInteger(descriptor.size) || descriptor.size <= 0) throw new Error(`Image ${image} returned an invalid linux/${architecture} descriptor`)
    platforms[architecture] = { digest: descriptor.digest, size: descriptor.size }
  }
  return platforms
}

async function command(command, args, options = {}) {
  const { stdout } = await execFileAsync(command, args, { maxBuffer: 32 * 1024 * 1024, ...options })
  return stdout
}

async function retryCommand(commandName, args, { attempts = 6, baseDelayMs = 1_000, ...options } = {}) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await command(commandName, args, options)
    } catch (error) {
      lastError = error
      if (attempt === attempts) break
      const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), 15_000)
      process.stderr.write(`Retrying ${commandName} after attempt ${attempt}/${attempts}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}\n`)
      await new Promise((resolveDelay) => setTimeout(resolveDelay, delay))
    }
  }
  throw lastError
}

async function remoteTags() {
  const output = await retryCommand('git', ['ls-remote', fetchRepository, 'refs/tags/self-hosted/v*', 'refs/tags/self-hosted/v*^{}'])
  return parseLsRemoteTags(output)
}

async function checkout(tag, destination) {
  // Source bytes are part of the release authority. Never inherit a Windows
  // user's core.autocrlf setting for this controlled artifact checkout.
  await command('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'clone', '--quiet', '--depth', '1', '--branch', tag, '--filter=blob:none', '--sparse', fetchRepository, destination])
  await command('git', ['-C', destination, 'config', 'core.autocrlf', 'false'])
  await command('git', ['-C', destination, 'config', 'core.eol', 'lf'])
  await command('git', ['-C', destination, 'sparse-checkout', 'set', 'docker'])
  return (await command('git', ['-C', destination, 'rev-parse', 'HEAD'])).trim()
}

async function composeDefinition(configurationRoot) {
  const stdout = await command(docker, [
    'compose',
    '--env-file', resolve(configurationRoot, '.env.example'),
    '--file', resolve(configurationRoot, 'docker-compose.yml'),
    // Keep variable expressions in the compiled contract. Expanding the
    // example .env here would freeze upstream demo passwords, JWTs and URLs
    // into every Project VM and bypass per-project secret generation.
    'config', '--format', 'json', '--no-interpolate',
  ], { cwd: configurationRoot })
  return JSON.parse(stdout)
}

async function resolvePlatforms(image) {
  const raw = await retryCommand(docker, ['buildx', 'imagetools', 'inspect', '--raw', image])
  return platformDescriptors(raw, image)
}

async function atomicJson(path, value) {
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, path)
}

async function atomicConfiguration(source, destination) {
  const temporary = `${destination}.${process.pid}.tmp`
  await rm(temporary, { recursive: true, force: true })
  await cp(source, temporary, { recursive: true, preserveTimestamps: true })
  await rm(destination, { recursive: true, force: true })
  await rename(temporary, destination)
}

async function main() {
  docker = await ensureDockerEngine()
  await mkdir(outputRoot, { recursive: true, mode: 0o700 })
  const existingLock = await readProjectSupabaseLock(lockPath).catch((error) => {
    if (!updateLock) throw error
    return undefined
  })
  if (refreshRuntimeSpec && updateLock) throw new Error('--refresh-runtime-spec cannot be combined with --update-lock')
  if (refreshRuntimeSpec && !offline) throw new Error('--refresh-runtime-spec requires --offline')
  if (offline && updateLock) throw new Error('--offline cannot be combined with --update-lock')

  const refs = offline ? undefined : await remoteTags()
  const tag = tagArgument || (updateLock ? latestSelfHostedTag([...refs.keys()]) : existingLock.release.tag)
  const ref = refs?.get(tag)
  if (!offline && (!ref?.tagObject || !ref?.commit)) throw new Error(`Supabase ${tag} must be an annotated tag with a peeled commit`)
  if (!updateLock && !offline && (ref.tagObject !== existingLock.release.tagObject || ref.commit !== existingLock.release.commit)) throw new Error(`Supabase ${tag} Git identity does not match the reviewed lock`)

  const checkoutRoot = await mkdtemp(resolve(tmpdir(), 'openlink-project-supabase-'))
  try {
    if (offline) {
      const cached = resolve(outputRoot, 'configuration')
      await cp(cached, resolve(checkoutRoot, 'docker'), { recursive: true, preserveTimestamps: true })
    } else {
      const commit = await checkout(tag, checkoutRoot)
      if (commit !== ref.commit) throw new Error(`Supabase checkout ${commit} does not match peeled commit ${ref.commit}`)
    }
    const configurationRoot = resolve(checkoutRoot, 'docker')
    const treeSha256 = await hashConfigurationTree(configurationRoot)
    const upgradesBytes = await readFile(resolve(configurationRoot, 'upgrades.json'))
    const upgradesSha256 = createHash('sha256').update(upgradesBytes).digest('hex')
    const compose = await composeDefinition(configurationRoot)
    const contract = parseComposeServices(compose)
    const runtimeSpec = normalizeRuntimeSpec(compose, configurationRoot)
    const runtimeSpecBytes = Buffer.from(`${JSON.stringify(runtimeSpec, null, 2)}\n`)
    const runtimeSpecSha256 = createHash('sha256').update(runtimeSpecBytes).digest('hex')

    let lock = existingLock
    if (updateLock) {
      const services = []
      for (const service of contract) {
        process.stderr.write(`Resolving ${service.image}\n`)
        services.push({ ...service, platforms: await resolvePlatforms(service.image) })
      }
      const version = tag.slice('self-hosted/v'.length)
      lock = validateProjectSupabaseLock({
        schemaVersion: 1,
        release: { tag, version, tagObject: ref.tagObject, commit: ref.commit, repository },
        configuration: { root: 'docker', treeSha256, upgradesSha256, runtimeSpecSha256 },
        services,
        upgradeGates: normalizeUpgradeGates(JSON.parse(upgradesBytes.toString('utf8'))),
      })
      await atomicJson(lockPath, lock)
    } else {
      if (treeSha256 !== lock.configuration.treeSha256) throw new Error(`Supabase configuration tree hash mismatch: ${treeSha256}`)
      if (upgradesSha256 !== lock.configuration.upgradesSha256) throw new Error('Supabase upgrades.json hash mismatch')
      const expected = lock.services.map(({ name, image, aliases }) => ({ name, image, aliases }))
      if (JSON.stringify(contract) !== JSON.stringify(expected)) throw new Error('Supabase Compose service contract differs from the reviewed lock')
      if (refreshRuntimeSpec) {
        lock = validateProjectSupabaseLock({
          ...lock,
          configuration: { ...lock.configuration, runtimeSpecSha256 },
        })
        await atomicJson(lockPath, lock)
      } else if (runtimeSpecSha256 !== lock.configuration.runtimeSpecSha256) {
        throw new Error('Supabase runtime spec hash mismatch')
      }
    }

    await atomicConfiguration(configurationRoot, resolve(outputRoot, 'configuration'))
    await writeFile(resolve(outputRoot, 'runtime.spec.json'), runtimeSpecBytes, { mode: 0o600 })
    const attestation = {
      schemaVersion: 1,
      release: lock.release,
      configuration: lock.configuration,
      serviceCount: lock.services.length,
      lockSha256: createHash('sha256').update(await readFile(lockPath)).digest('hex'),
      synchronizedAt: new Date().toISOString(),
    }
    await atomicJson(resolve(outputRoot, 'manifest.json'), attestation)
    process.stdout.write(`${JSON.stringify({ tag, commit: lock.release.commit, treeSha256, output: outputRoot, lockUpdated: updateLock })}\n`)
  } finally {
    await rm(checkoutRoot, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
