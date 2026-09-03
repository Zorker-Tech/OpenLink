#!/usr/bin/env node
import { cp, lstat, mkdir, mkdtemp, readFile, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  canonicalJson,
  normalizeTarget,
  safeReleasePath,
  verifyReleaseInventory,
  verifyReleaseManifest,
} from './runtime/release-contract.mjs'
import { readEnvironmentFile, runPreflight } from './runtime/preflight.mjs'
import { extractVerifiedTarGzip } from './runtime/safe-archive.mjs'

const releaseRootFromScript = resolve(fileURLToPath(new URL('.', import.meta.url)))

async function pathExists(path) {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

function contained(root, relative) {
  const destination = resolve(root, ...safeReleasePath(relative).split('/'))
  if (destination !== root && !destination.startsWith(`${root}${sep}`)) throw new Error(`Release path escapes destination: ${relative}`)
  return destination
}

async function readSignedManifest(root) {
  const path = join(resolve(root), 'release.json')
  const stats = await lstat(path)
  if (!stats.isFile() || (stats.mode & 0o022) !== 0) throw new Error('Release manifest must be a protected regular file')
  return JSON.parse(await readFile(path, 'utf8'))
}

async function verifyInstalledRelease(directory, trustedKeys, expectedTarget) {
  const signed = await readSignedManifest(directory)
  const manifest = verifyReleaseManifest(signed, { trustedKeys, expectedTarget })
  await verifyReleaseInventory(directory, manifest.inventory)
  return { signed, manifest }
}

async function copyInventory(source, destination, inventory) {
  for (const entry of inventory) {
    const input = contained(source, entry.path)
    const output = contained(destination, entry.path)
    await mkdir(dirname(output), { recursive: true, mode: 0o755 })
    await cp(input, output, { dereference: false, errorOnExist: true, force: false, preserveTimestamps: false })
    await (await import('node:fs/promises')).chmod(output, Number.parseInt(entry.mode, 8))
  }
}

async function activateRelease(installRoot, releaseId) {
  const link = join(installRoot, 'current')
  const stagedLink = join(installRoot, `.current-${process.pid}-${Date.now()}`)
  await symlink(join('releases', releaseId), stagedLink, process.platform === 'win32' ? 'junction' : undefined)
  try {
    await rename(stagedLink, link)
  } catch (error) {
    if (error?.code !== 'EEXIST' && error?.code !== 'ENOTEMPTY') throw error
    const oldLink = join(installRoot, `.current-old-${process.pid}-${Date.now()}`)
    await rename(link, oldLink)
    try {
      await rename(stagedLink, link)
    } catch (activationError) {
      await rename(oldLink, link).catch(() => undefined)
      throw activationError
    }
    await rm(oldLink, { force: true })
  } finally {
    await rm(stagedLink, { force: true })
  }
}

export async function installReleaseDirectory(options = {}) {
  const source = resolve(options.source)
  const installRoot = resolve(options.installRoot)
  const expectedTarget = options.expectedTarget ?? { platform: process.platform, architecture: process.arch }
  const signed = await readSignedManifest(source)
  const manifest = verifyReleaseManifest(signed, { trustedKeys: options.trustedKeys, expectedTarget })
  await verifyReleaseInventory(source, manifest.inventory)

  await mkdir(join(installRoot, 'releases'), { recursive: true, mode: 0o755 })
  const destination = join(installRoot, 'releases', manifest.releaseId)
  if (await pathExists(destination)) {
    const existing = await verifyInstalledRelease(destination, options.trustedKeys, expectedTarget).catch((error) => {
      throw new Error(`Immutable release collision for ${manifest.releaseId}: ${error instanceof Error ? error.message : String(error)}`)
    })
    if (canonicalJson(existing.signed) !== canonicalJson(signed)) throw new Error(`Immutable release collision for ${manifest.releaseId}`)
    await activateRelease(installRoot, manifest.releaseId)
    return { releaseId: manifest.releaseId, destination, reused: true }
  }

  const staging = await mkdtemp(join(installRoot, 'releases', `.staging-${manifest.releaseId}-`))
  try {
    await copyInventory(source, staging, manifest.inventory)
    await writeFile(join(staging, 'release.json'), `${JSON.stringify(signed, null, 2)}\n`, { mode: 0o644, flag: 'wx' })
    await verifyInstalledRelease(staging, options.trustedKeys, expectedTarget)
    await rename(staging, destination)
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    throw error
  }
  await activateRelease(installRoot, manifest.releaseId)
  return { releaseId: manifest.releaseId, destination, reused: false }
}

export async function installReleaseArchive(options = {}) {
  const extractionRoot = await mkdtemp(join(options.temporaryRoot ? resolve(options.temporaryRoot) : tmpdir(), 'openlink-bundle-'))
  try {
    await extractVerifiedTarGzip(options.archive, extractionRoot, options.archiveLimits)
    return await installReleaseDirectory({ ...options, source: extractionRoot })
  } finally {
    await rm(extractionRoot, { recursive: true, force: true })
  }
}

function parseArguments(argv) {
  const [command, ...rest] = argv
  const values = new Map()
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index]
    const value = rest[index + 1]
    if (!key?.startsWith('--') || value === undefined) throw new Error(`Invalid argument near ${key ?? '<end>'}`)
    values.set(key.slice(2), value)
  }
  return { command, values }
}

async function trustedKeysFrom(path) {
  if (!path) throw new Error('Release trust file is required')
  const document = JSON.parse(await readFile(resolve(path), 'utf8'))
  if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error('Release trust file is invalid')
  const keys = document.keys ?? document
  if (!keys || typeof keys !== 'object' || Array.isArray(keys)) throw new Error('Release trust keys are invalid')
  return Object.fromEntries(Object.entries(keys).map(([keyId, value]) => [
    keyId,
    typeof value === 'string' ? value : value?.publicKeyPem,
  ]))
}

async function main(argv) {
  const { command, values } = parseArguments(argv)
  const expectedTarget = normalizeTarget({ platform: process.platform, architecture: process.arch })
  if (command === 'verify') {
    const source = resolve(values.get('source') || '.')
    const trustedKeys = await trustedKeysFrom(values.get('trust'))
    const signed = await readSignedManifest(source)
    const manifest = verifyReleaseManifest(signed, { trustedKeys, expectedTarget })
    await verifyReleaseInventory(source, manifest.inventory)
    process.stdout.write(`${JSON.stringify({ ok: true, releaseId: manifest.releaseId, target: manifest.target.triple })}\n`)
    return
  }
  if (command === 'install') {
    const common = {
      installRoot: values.get('root'),
      trustedKeys: await trustedKeysFrom(values.get('trust')),
      expectedTarget,
    }
    const result = values.get('archive')
      ? await installReleaseArchive({ ...common, archive: values.get('archive') })
      : await installReleaseDirectory({ ...common, source: values.get('source') })
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`)
    return
  }
  if (command === 'version') {
    const root = resolve(values.get('root'))
    const link = join(root, 'current')
    process.stdout.write(`${JSON.stringify({ releaseId: basename(await readlink(link)) })}\n`)
    return
  }
  if (command === 'preflight' || command === 'doctor') {
    const configPath = values.get('config')
    const config = configPath ? await readEnvironmentFile(resolve(configPath)) : {}
    const secrets = config.OPENLINK_SECRETS_FILE
      ? await readEnvironmentFile(resolve(config.OPENLINK_SECRETS_FILE), { secrets: true })
      : {}
    const releaseRoot = resolve(values.get('release-root') || releaseRootFromScript)
    const result = await runPreflight({
      releaseRoot,
      stateRoot: values.get('state-root') || config.OPENLINK_STATE_ROOT,
      platform: process.platform,
      architecture: process.arch,
      dockerCommand: config.OPENLINK_DOCKER_COMMAND || 'docker',
      environment: { ...config, ...secrets },
      minimumFreeBytes: config.OPENLINK_MINIMUM_FREE_BYTES,
      minimumMemoryBytes: config.OPENLINK_MINIMUM_MEMORY_BYTES,
    })
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    return
  }
  throw new Error('Usage: openlinkctl <verify|install|version|preflight|doctor> [options]')
}

if (process.argv[1] && basename(process.argv[1]) === basename(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`openlinkctl: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
