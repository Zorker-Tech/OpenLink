#!/usr/bin/env node
/**
 * Internal release-engineering command. This command is never shipped as a
 * customer startup dependency: it signs an already prebuilt native payload.
 */
import { execFile as execFileCallback } from 'node:child_process'
import { createHash, createPrivateKey } from 'node:crypto'
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

import {
  createReleaseInventory,
  normalizeReleaseId,
  normalizeTarget,
  signReleaseManifest,
} from '../deploy/self-hosted/runtime/release-contract.mjs'

const execFile = promisify(execFileCallback)

function requiredPayloadPaths(target) {
  const disk = `project-vm/openlink-project-vm-base-${target.architecture}.${target.diskFormat}`
  return [
    'runtime/node/bin/node',
    'app/web/server.js',
    'services/agent-host/dist/src/main.js',
    'services/browser-host/dist/src/main.js',
    'services/knowledge-service/dist/src/main.js',
    'orchestration/backend/docker/docker-compose.yml',
    'orchestration/services/zero/docker-compose.standalone.yml',
    'images/runtime/manifest.json',
    'images/zokerbase/manifest.json',
    'images/zero/manifest.json',
    'toolchain/bin/podman',
    'project-vm/manifest.json',
    disk,
    'openlinkctl.mjs',
    'bin/openlinkctl',
  ]
}

async function regularFile(path) {
  try {
    return (await lstat(path)).isFile()
  } catch {
    return false
  }
}

async function copyRequired(source, destination, options = {}) {
  if (!await lstat(source).then(() => true).catch(() => false)) {
    throw new Error(`Self-hosted release build input is missing: ${source}`)
  }
  await mkdir(join(destination, '..'), { recursive: true, mode: 0o755 })
  await cp(source, destination, {
    recursive: true,
    dereference: options.dereference ?? true,
    force: false,
    preserveTimestamps: false,
    filter: options.filter,
  })
}

async function normalizePayloadModes(root) {
  async function visit(path) {
    const stats = await lstat(path)
    if (stats.isSymbolicLink()) throw new Error(`Release staging contains a symbolic link: ${path}`)
    if (stats.isDirectory()) {
      await chmod(path, 0o755)
      for (const name of (await readdir(path)).sort()) await visit(join(path, name))
      return
    }
    if (!stats.isFile()) throw new Error(`Release staging contains a non-regular file: ${path}`)
    await chmod(path, (stats.mode & 0o111) !== 0 ? 0o755 : 0o644)
  }
  await visit(root)
}

async function copyImageSet(sourceDirectory, destinationDirectory, kind) {
  const manifest = JSON.parse(await readFile(join(sourceDirectory, 'manifest.json'), 'utf8'))
  await mkdir(join(destinationDirectory, 'archives'), { recursive: true, mode: 0o755 })
  if (kind === 'runtime') {
    if (!manifest.images || Array.isArray(manifest.images)) throw new Error('Runtime image manifest is invalid')
    const images = {}
    for (const [image, item] of Object.entries(manifest.images)) {
      const archiveName = basename(item.archive)
      await copyRequired(resolve(sourceDirectory, item.archive), join(destinationDirectory, 'archives', archiveName))
      images[image] = { ...item, archive: `archives/${archiveName}` }
    }
    await writeFile(join(destinationDirectory, 'manifest.json'), `${JSON.stringify({ ...manifest, images }, null, 2)}\n`, { mode: 0o644 })
    return
  }
  if (!Array.isArray(manifest.images)) throw new Error(`${kind} image manifest is invalid`)
  for (const item of manifest.images) {
    if (typeof item.archive !== 'string' || basename(item.archive) !== item.archive) throw new Error(`${kind} image archive path is invalid`)
    await copyRequired(join(sourceDirectory, item.archive), join(destinationDirectory, 'archives', item.archive))
  }
  await writeFile(join(destinationDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 })
}

export async function stageNativeSelfHostedPayload(options = {}) {
  const sourceRoot = resolve(options.sourceRoot)
  const runtimeRoot = resolve(options.runtimeRoot ?? join(sourceRoot, '.openlink-runtime'))
  const target = normalizeTarget(options.target ?? { platform: process.platform, architecture: process.arch })
  const outputRoot = resolve(options.outputRoot)
  const nodeExecutable = resolve(options.nodeExecutable ?? process.execPath)
  await mkdir(outputRoot, { recursive: true, mode: 0o755 })

  await copyRequired(nodeExecutable, join(outputRoot, 'runtime/node/bin/node'))
  await copyRequired(join(sourceRoot, '.next/standalone'), join(outputRoot, 'app/web'))
  await copyRequired(join(sourceRoot, '.next/static'), join(outputRoot, 'app/web/.next/static'))
  if (await lstat(join(sourceRoot, 'public')).then(() => true).catch(() => false)) {
    await copyRequired(join(sourceRoot, 'public'), join(outputRoot, 'app/web/public'))
  }

  for (const service of ['agent-host', 'browser-host', 'knowledge-service']) {
    const source = join(sourceRoot, 'services', service)
    const destination = join(outputRoot, 'services', service)
    await copyRequired(join(source, 'dist'), join(destination, 'dist'))
    await copyRequired(join(source, 'node_modules'), join(destination, 'node_modules'), {
      dereference: true,
      filter(path) {
        const relative = path.slice(join(source, 'node_modules').length).replace(/^\//, '')
        return !relative.startsWith('.bin/') && !relative.includes('/test/') && !relative.includes('/tests/')
      },
    })
    await copyRequired(join(source, 'package.json'), join(destination, 'package.json'))
  }

  await copyRequired(join(sourceRoot, 'deploy/self-hosted'), outputRoot)
  await copyRequired(join(sourceRoot, 'backend/docker'), join(outputRoot, 'orchestration/backend/docker'), {
    filter(path) {
      const relative = path.slice(join(sourceRoot, 'backend/docker').length).replace(/^\//, '')
      return relative !== '.env' && !relative.startsWith('volumes/db/data') && !relative.startsWith('volumes/storage')
    },
  })
  await copyRequired(join(sourceRoot, 'services/zero/openlink'), join(outputRoot, 'orchestration/services/zero'))
  await copyRequired(join(sourceRoot, 'zorkerbase/migrations'), join(outputRoot, 'orchestration/zorkerbase/migrations'))

  await copyImageSet(join(runtimeRoot, 'images'), join(outputRoot, 'images/runtime'), 'runtime')
  await copyImageSet(join(runtimeRoot, 'zokerbase/images'), join(outputRoot, 'images/zokerbase'), 'zokerbase')
  await copyImageSet(join(runtimeRoot, 'knowledge/images'), join(outputRoot, 'images/zero'), 'zero')

  const nativeToolchain = target.platform === 'linux'
    ? join(runtimeRoot, 'toolchain/linux', target.architecture, 'podman')
    : join(runtimeRoot, 'toolchain/bin')
  if (target.platform === 'linux') await copyRequired(nativeToolchain, join(outputRoot, 'toolchain/bin/podman'))
  else await copyRequired(nativeToolchain, join(outputRoot, 'toolchain/bin'))

  const vmRoot = join(runtimeRoot, 'project-vm-base')
  const vmManifest = JSON.parse(await readFile(join(vmRoot, 'manifest.json'), 'utf8'))
  if (vmManifest?.diskPlatform?.hostPlatform !== target.platform
    || vmManifest?.diskPlatform?.architecture !== target.architecture
    || vmManifest?.diskPlatform?.provider !== target.provider
    || vmManifest?.diskPlatform?.format !== target.diskFormat) {
    throw new Error(`Project VM artifact does not match ${target.triple}`)
  }
  await copyRequired(join(vmRoot, 'manifest.json'), join(outputRoot, 'project-vm/manifest.json'))
  await copyRequired(join(vmRoot, vmManifest.disk), join(outputRoot, 'project-vm', vmManifest.disk))
  if (typeof vmManifest.archive === 'string') await copyRequired(join(vmRoot, vmManifest.archive), join(outputRoot, 'project-vm', vmManifest.archive))

  await normalizePayloadModes(outputRoot)
  return { payloadRoot: outputRoot, target }
}

async function assertCompletePayload(root, target, inventory) {
  const paths = new Set(inventory.map((entry) => entry.path))
  for (const required of requiredPayloadPaths(target)) {
    if (!paths.has(required) || !await regularFile(join(root, ...required.split('/')))) {
      throw new Error(`Self-hosted release payload is missing ${required}`)
    }
  }
  for (const entry of inventory) {
    if (/(?:^|\/)(?:.*signing.*private|private[-_.]?key|release-signing-private)(?:[/.]|$)/i.test(entry.path)
      || /\.(?:key|p12|pfx)$/i.test(entry.path)) {
      throw new Error(`Customer payload contains private signing material: ${entry.path}`)
    }
    if (entry.size <= 128 * 1024) {
      const contents = await readFile(join(root, ...entry.path.split('/')), 'utf8').catch(() => '')
      if (/-----BEGIN (?:ENCRYPTED )?PRIVATE KEY-----/.test(contents)) {
        throw new Error(`Customer payload contains a private key: ${entry.path}`)
      }
    }
  }
}

async function writeArchive(releaseDirectory, outputRoot, releaseId, target) {
  const archiveName = `openlink-self-hosted-${releaseId}-${target.triple}.tar.gz`
  const temporary = join(outputRoot, `.${archiveName}.${process.pid}.tmp`)
  const archive = join(outputRoot, archiveName)
  await execFile('tar', ['-czf', temporary, '-C', releaseDirectory, '.'], { maxBuffer: 16 * 1024 * 1024 })
  const digest = createHash('sha256').update(await readFile(temporary)).digest('hex')
  await rename(temporary, archive)
  await writeFile(`${archive}.sha256`, `${digest}  ${archiveName}\n`, { mode: 0o644 })
  return { archive, archiveSha256: digest }
}

export async function assembleSelfHostedRelease(options = {}) {
  const payloadRoot = resolve(options.payloadRoot)
  const outputRoot = resolve(options.outputRoot)
  const releaseId = normalizeReleaseId(options.releaseId)
  const target = normalizeTarget(options.target)
  const privateKey = options.privateKey?.type === 'private'
    ? options.privateKey
    : createPrivateKey(options.privateKey)
  const payloadInventory = await createReleaseInventory(payloadRoot)
  await assertCompletePayload(payloadRoot, target, payloadInventory)

  await mkdir(outputRoot, { recursive: true, mode: 0o755 })
  const releaseDirectory = join(outputRoot, `openlink-self-hosted-${releaseId}-${target.triple}`)
  if (await regularFile(releaseDirectory) || await lstat(releaseDirectory).then(() => true).catch(() => false)) {
    throw new Error(`Self-hosted release output already exists: ${releaseDirectory}`)
  }
  const staging = await mkdtemp(join(outputRoot, `.staging-${releaseId}-`))
  try {
    await cp(payloadRoot, staging, { recursive: true, dereference: false, force: false, preserveTimestamps: false })
    const inventory = await createReleaseInventory(staging)
    const signed = signReleaseManifest({
      schemaVersion: 1,
      contractVersion: 1,
      product: 'OpenLink',
      releaseId,
      target,
      createdAt: options.createdAt ?? new Date(Number(process.env.SOURCE_DATE_EPOCH || Date.now() / 1000) * 1000).toISOString(),
      compatibility: options.compatibility ?? {
        stateSchema: 1,
        minimumStateSchema: 1,
        maximumStateSchema: 1,
      },
      inventory,
    }, { privateKey, keyId: options.keyId })
    await writeFile(join(staging, 'release.json'), `${JSON.stringify(signed, null, 2)}\n`, { mode: 0o644, flag: 'wx' })
    await rename(staging, releaseDirectory)
    const archiveResult = options.createArchive === false
      ? { archive: undefined, archiveSha256: undefined }
      : await writeArchive(releaseDirectory, outputRoot, releaseId, target)
    return { releaseId, target: target.triple, releaseDirectory, ...archiveResult }
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    throw error
  }
}

function parseArguments(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith('--') || value === undefined) throw new Error(`Invalid argument near ${key ?? '<end>'}`)
    values.set(key.slice(2), value)
  }
  return values
}

async function main(argv) {
  const args = parseArguments(argv)
  const privateKeyPath = resolve(args.get('signing-key'))
  const keyStats = await lstat(privateKeyPath)
  if (!keyStats.isFile() || (keyStats.mode & 0o077) !== 0) throw new Error('Release signing key must be a protected regular file with mode 0600')
  const target = {
    platform: args.get('platform') || process.platform,
    architecture: args.get('architecture') || process.arch,
  }
  let temporaryPayload
  let payloadRoot = args.get('payload-root')
  if (!payloadRoot) {
    temporaryPayload = await mkdtemp(join(tmpdir(), 'openlink-self-hosted-payload-'))
    await stageNativeSelfHostedPayload({
      sourceRoot: resolve(fileURLToPath(new URL('../', import.meta.url))),
      runtimeRoot: args.get('runtime-root'),
      outputRoot: temporaryPayload,
      target,
      nodeExecutable: args.get('node-executable'),
    })
    payloadRoot = temporaryPayload
  }
  const result = await assembleSelfHostedRelease({
    payloadRoot,
    outputRoot: args.get('output') || '.openlink-releases/self-hosted',
    releaseId: args.get('release-id'),
    target,
    privateKey: await readFile(privateKeyPath),
    keyId: args.get('key-id'),
  })
  try {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } finally {
    if (temporaryPayload) await rm(temporaryPayload, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`self-hosted release build failed: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
