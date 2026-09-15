import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, readFile, rename, rm, stat, statfs, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { readProjectSupabaseLock } from './lib/project-supabase-lock.mjs'
import { archiveName, immutablePullReference, readImageArtifactManifest, sha256File, targetArchitecture } from './lib/project-supabase-images.mjs'
import { ensureDockerEngine } from './lib/docker-runtime.mjs'
import { retryDockerPull } from './lib/docker-pull-retry.mjs'

const execFileAsync = promisify(execFile)
const root = resolve(fileURLToPath(new URL('../', import.meta.url)))
const lockPath = resolve(root, 'services/project-supabase/runtime.lock.json')
const lock = await readProjectSupabaseLock(lockPath)
const architectureArgument = process.argv.find((value) => value.startsWith('--architecture='))?.slice('--architecture='.length)
const architecture = targetArchitecture(architectureArgument)
const outputRoot = resolve(root, '.openlink-runtime/project-supabase/images', architecture)
const manifestPath = resolve(outputRoot, 'manifest.json')
const force = process.argv.includes('--force')
const docker = await ensureDockerEngine()
const pullAttempts = Number.parseInt(process.env.OPENLINK_IMAGE_PULL_ATTEMPTS || '8', 10)
if (!Number.isSafeInteger(pullAttempts) || pullAttempts < 1 || pullAttempts > 20) {
  throw new Error('OPENLINK_IMAGE_PULL_ATTEMPTS must be an integer between 1 and 20')
}

async function command(commandName, args, options = {}) {
  const { stdout } = await execFileAsync(commandName, args, { maxBuffer: 64 * 1024 * 1024, ...options })
  return stdout
}

async function archiveImageId(path, reference) {
  const raw = await command('tar', ['-xOf', path, 'manifest.json'])
  const manifests = JSON.parse(raw)
  const entry = manifests.find((candidate) => candidate?.RepoTags?.includes(reference))
  const config = entry?.Config
  const matched = typeof config === 'string' ? config.match(/^(?:blobs\/sha256\/)?([a-f0-9]{64})$/) : undefined
  if (!matched) throw new Error(`Docker archive returned an invalid image config for ${reference}`)
  return `sha256:${matched[1]}`
}

async function availableBytes(path) {
  const filesystem = await statfs(path, { bigint: true })
  const bytes = filesystem.bavail * filesystem.bsize
  if (bytes <= 0n || bytes > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Unable to determine available disk capacity')
  return Number(bytes)
}

async function validCachedArtifact(service, verifiedPrevious) {
  const artifact = verifiedPrevious?.images?.find((candidate) => candidate.service === service.name)
  if (!artifact || artifact.platformDigest !== service.platforms[architecture].digest || artifact.image !== service.image) return undefined
  return { ...artifact, imageId: await archiveImageId(resolve(outputRoot, artifact.archive), service.image) }
}

let previous
try { previous = JSON.parse(await readFile(manifestPath, 'utf8')) } catch {}
let verifiedPrevious
if (!force && previous) verifiedPrevious = await readImageArtifactManifest(manifestPath, lock).catch(() => undefined)
await mkdir(outputRoot, { recursive: true, mode: 0o700 })

// A complete self-hosted stack is large. Keep a conservative floor so a pull
// or archive write cannot consume the last bytes of the release filesystem and
// leave unrelated artifacts corrupted. Operators can choose a larger volume;
// the builder never silently drops services to fit.
const free = await availableBytes(outputRoot)
const minimumFree = Number(process.env.OPENLINK_PROJECT_SUPABASE_MIN_FREE_BYTES || 8 * 1024 * 1024 * 1024)
if (!Number.isSafeInteger(minimumFree) || minimumFree < 2 * 1024 * 1024 * 1024) throw new Error('OPENLINK_PROJECT_SUPABASE_MIN_FREE_BYTES must be at least 2 GiB')
if (free < minimumFree) throw new Error(`Project Supabase image build requires at least ${minimumFree} free bytes; found ${free}`)

const images = []
for (const service of lock.services) {
  const archive = archiveName(service, architecture)
  const archivePath = resolve(outputRoot, archive)
  const cached = !force ? await validCachedArtifact(service, verifiedPrevious) : undefined
  if (cached) {
    process.stderr.write(`Reusing ${service.name} ${service.platforms[architecture].digest}\n`)
    images.push(cached)
    continue
  }

  const platformDigest = service.platforms[architecture].digest
  const immutable = immutablePullReference(service.image, platformDigest)
  const temporaryArchive = `${archivePath}.${process.pid}.tmp`
  process.stderr.write(`Acquiring ${service.name} ${immutable} for linux/${architecture}\n`)
  await retryDockerPull(
    () => command(docker, ['image', 'pull', '--platform', `linux/${architecture}`, immutable]),
    {
      attempts: pullAttempts,
      onRetry: (attempt, attempts) => process.stderr.write(`Retrying ${service.name} image pull after transient failure (${attempt}/${attempts})\n`),
    },
  )
  try {
    await command(docker, ['image', 'tag', immutable, service.image])
    await rm(temporaryArchive, { force: true })
    await command(docker, ['image', 'save', '--platform', `linux/${architecture}`, '--output', temporaryArchive, service.image])
    const metadata = await stat(temporaryArchive)
    if (!metadata.isFile() || metadata.size <= 1024) throw new Error(`Docker produced an invalid archive for ${service.name}`)
    const archiveSha256 = await sha256File(temporaryArchive)
    const imageId = await archiveImageId(temporaryArchive, service.image)
    await rename(temporaryArchive, archivePath)
    images.push({ service: service.name, image: service.image, platformDigest, imageId, archive, archiveSha256, archiveBytes: metadata.size })
  } finally {
    await rm(temporaryArchive, { force: true })
    // Remove only this build's tag/reference. Shared layers remain available
    // for the next image and Docker decides when unreferenced content can be
    // reclaimed; no global prune can affect user-owned images.
    await command(docker, ['image', 'rm', service.image]).catch(() => undefined)
    await command(docker, ['image', 'rm', immutable]).catch(() => undefined)
  }
}

const next = {
  schemaVersion: 1,
  release: lock.release,
  architecture,
  configurationTreeSha256: lock.configuration.treeSha256,
  lockSha256: createHash('sha256').update(await readFile(lockPath)).digest('hex'),
  images,
  builtAt: new Date().toISOString(),
}
const temporaryManifest = `${manifestPath}.${process.pid}.tmp`
await writeFile(temporaryManifest, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
await rename(temporaryManifest, manifestPath)
await readImageArtifactManifest(manifestPath, lock)
process.stdout.write(`${JSON.stringify({ architecture, manifest: manifestPath, images: images.length, bytes: images.reduce((total, image) => total + image.archiveBytes, 0) })}\n`)
