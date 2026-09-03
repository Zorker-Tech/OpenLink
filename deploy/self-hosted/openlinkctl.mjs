#!/usr/bin/env node
import { constants } from 'node:fs'
import { cp, lstat, mkdir, mkdtemp, open, readFile, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { execFile as execFileCallback } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { isSea } from 'node:sea'

import {
  canonicalJson,
  normalizeTarget,
  parseReleaseTrustPolicy,
  safeReleasePath,
  verifyReleaseInventory,
  verifyReleaseManifest,
} from './runtime/release-contract.mjs'
import { readEnvironmentFile, runPreflight } from './runtime/preflight.mjs'
import { extractVerifiedTarGzip } from './runtime/safe-archive.mjs'
import { createRuntimePlan, ProductionSupervisor, validateProductionEnvironment } from './runtime/production-runtime.mjs'
import { createProductionConfiguration } from './runtime/configuration.mjs'
import { acquireRuntimeLock, runtimeLockStatus } from './runtime/lifecycle-lock.mjs'
import { createEncryptedBackup, restoreEncryptedBackup } from './runtime/backup.mjs'
import { executeUpgradeTransaction } from './runtime/upgrade.mjs'

const execFile = promisify(execFileCallback)

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

export async function verifyInstalledRelease(directory, trustedKeys, expectedTarget, minimumReleaseSequence) {
  const signed = await readSignedManifest(directory)
  const manifest = verifyReleaseManifest(signed, { trustedKeys, expectedTarget, minimumReleaseSequence })
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

export async function activateRelease(installRoot, releaseId) {
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
  const manifest = verifyReleaseManifest(signed, { trustedKeys: options.trustedKeys, expectedTarget, minimumReleaseSequence: options.minimumReleaseSequence })
  await verifyReleaseInventory(source, manifest.inventory)

  await mkdir(join(installRoot, 'releases'), { recursive: true, mode: 0o755 })
  const destination = join(installRoot, 'releases', manifest.releaseId)
  if (await pathExists(destination)) {
    const existing = await verifyInstalledRelease(destination, options.trustedKeys, expectedTarget, options.minimumReleaseSequence).catch((error) => {
      throw new Error(`Immutable release collision for ${manifest.releaseId}: ${error instanceof Error ? error.message : String(error)}`)
    })
    if (canonicalJson(existing.signed) !== canonicalJson(signed)) throw new Error(`Immutable release collision for ${manifest.releaseId}`)
    if (options.activate !== false) await activateRelease(installRoot, manifest.releaseId)
    return { releaseId: manifest.releaseId, destination, reused: true }
  }

  const staging = await mkdtemp(join(installRoot, 'releases', `.staging-${manifest.releaseId}-`))
  try {
    await copyInventory(source, staging, manifest.inventory)
    await writeFile(join(staging, 'release.json'), `${JSON.stringify(signed, null, 2)}\n`, { mode: 0o644, flag: 'wx' })
    await verifyInstalledRelease(staging, options.trustedKeys, expectedTarget, options.minimumReleaseSequence)
    await rename(staging, destination)
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    throw error
  }
  if (options.activate !== false) await activateRelease(installRoot, manifest.releaseId)
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

export async function verifyReleaseArchive(options = {}) {
  const extractionRoot = await mkdtemp(join(options.temporaryRoot ? resolve(options.temporaryRoot) : tmpdir(), 'openlink-verify-bundle-'))
  try {
    await extractVerifiedTarGzip(options.archive, extractionRoot, options.archiveLimits)
    return (await verifyInstalledRelease(extractionRoot, options.trustedKeys, options.expectedTarget, options.minimumReleaseSequence)).manifest
  } finally {
    await rm(extractionRoot, { recursive: true, force: true })
  }
}

async function serviceAction(action, stateRoot) {
  if (process.platform === 'linux') {
    await execFile('systemctl', [action, 'openlink.service'], { timeout: action === 'stop' ? 240_000 : 30_000 })
    return
  }
  if (process.platform === 'darwin') {
    const args = action === 'stop'
      ? ['kill', 'SIGTERM', 'system/io.zokerbase.openlink']
      : ['kickstart', '-k', 'system/io.zokerbase.openlink']
    await execFile('/bin/launchctl', args, { timeout: action === 'stop' ? 240_000 : 30_000 })
    if (action === 'stop') {
      const deadline = Date.now() + 240_000
      while ((await runtimeLockStatus(stateRoot)).running && Date.now() < deadline) await new Promise((resolveDelay) => setTimeout(resolveDelay, 250))
      if ((await runtimeLockStatus(stateRoot)).running) throw new Error('OpenLink LaunchDaemon did not stop within 240 seconds')
    }
    return
  }
  throw new Error(`Native service control is unsupported on ${process.platform}`)
}

export async function waitForApplicationHealth(url, expectedReleaseId, timeoutMs = 600_000) {
  const deadline = Date.now() + timeoutMs
  const healthUrl = new URL('/api/healthz', url)
  while (Date.now() < deadline) {
    try {
      const response = await fetch(healthUrl, { redirect: 'manual', signal: AbortSignal.timeout(5_000) })
      if (response.status === 200) {
        const body = await response.json().catch(() => undefined)
        if (body?.ok === true && body.releaseId === expectedReleaseId) return
      }
    } catch {}
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000))
  }
  throw new Error(`OpenLink did not become healthy within ${timeoutMs / 1000} seconds`)
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

async function trustPolicyFrom(path) {
  if (!path) throw new Error('Release trust file is required')
  const absolute = resolve(path)
  const before = await lstat(absolute)
  const expectedUid = typeof process.getuid === 'function' && process.getuid() === 0 ? 0 : process.getuid?.()
  if (!before.isFile() || (before.mode & 0o022) !== 0 || (expectedUid !== undefined && before.uid !== expectedUid)) {
    throw new Error('Release trust file must be a protected regular file owned by the invoking trust administrator')
  }
  const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const current = await handle.stat()
    if (!current.isFile() || current.dev !== before.dev || current.ino !== before.ino) throw new Error('Release trust file changed while opening')
    return parseReleaseTrustPolicy(JSON.parse(await handle.readFile('utf8')))
  } finally {
    await handle.close()
  }
}

async function main(argv) {
  const { command, values } = parseArguments(argv)
  const expectedTarget = normalizeTarget({ platform: process.platform, architecture: process.arch })
  if (command === 'verify') {
    const source = resolve(values.get('source') || '.')
    const trust = await trustPolicyFrom(values.get('trust'))
    const signed = await readSignedManifest(source)
    const manifest = verifyReleaseManifest(signed, { trustedKeys: trust.trustedKeys, expectedTarget, minimumReleaseSequence: trust.minimumReleaseSequence })
    await verifyReleaseInventory(source, manifest.inventory)
    process.stdout.write(`${JSON.stringify({ ok: true, releaseId: manifest.releaseId, target: manifest.target.triple })}\n`)
    return
  }
  if (command === 'install') {
    const trust = await trustPolicyFrom(values.get('trust'))
    const common = {
      installRoot: values.get('root'),
      trustedKeys: trust.trustedKeys,
      minimumReleaseSequence: trust.minimumReleaseSequence,
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
  if (command === 'configure') {
    const result = await createProductionConfiguration({
      releaseRoot: resolve(values.get('release-root') || releaseRootFromScript),
      configPath: values.get('config'),
      secretsPath: values.get('secrets'),
      stateRoot: values.get('state-root'),
      logRoot: values.get('log-root'),
      backupRoot: values.get('backup-root'),
      appUrl: values.get('app-url'),
      gatewayUrl: values.get('gateway-url'),
      allowInsecure: values.get('allow-insecure-http') === '1',
      overwrite: values.get('overwrite') === '1',
    })
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`)
    return
  }
  if (command === 'status') {
    const config = await readEnvironmentFile(resolve(values.get('config')))
    const status = await runtimeLockStatus(config.OPENLINK_STATE_ROOT)
    process.stdout.write(`${JSON.stringify({ ok: true, ...status })}\n`)
    if (!status.running) process.exitCode = 3
    return
  }
  if (command === 'backup') {
    const configPath = resolve(values.get('config'))
    const config = await readEnvironmentFile(configPath)
    const output = resolve(values.get('output') || join(config.OPENLINK_BACKUP_ROOT, `openlink-${new Date().toISOString().replaceAll(':', '').replaceAll('.', '-')}.olb`))
    const result = await createEncryptedBackup({
      stateRoot: config.OPENLINK_STATE_ROOT,
      configPath,
      secretsPath: config.OPENLINK_SECRETS_FILE,
      keyFile: config.OPENLINK_BACKUP_KEY_FILE,
      output,
    })
    process.stdout.write(`${JSON.stringify({ ok: true, output: result.output, manifestPath: result.manifestPath, sha256: result.manifest.payload.sha256 })}\n`)
    return
  }
  if (command === 'restore') {
    const result = await restoreEncryptedBackup({
      archive: values.get('archive'),
      manifest: values.get('manifest'),
      keyFile: values.get('key-file'),
      stateRoot: values.get('state-root'),
      configPath: values.get('config'),
      secretsPath: values.get('secrets'),
    })
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`)
    return
  }
  if (command === 'upgrade') {
    const installRoot = resolve(values.get('root'))
    const archive = resolve(values.get('archive'))
    const configPath = resolve(values.get('config'))
    const config = await readEnvironmentFile(configPath)
    const trust = await trustPolicyFrom(values.get('trust'))
    const trustedKeys = trust.trustedKeys
    const expectedTarget = normalizeTarget({ platform: process.platform, architecture: process.arch })
    const currentDirectory = resolve(installRoot, await readlink(join(installRoot, 'current')))
    const currentManifest = (await verifyInstalledRelease(currentDirectory, trustedKeys, expectedTarget)).manifest
    const candidateManifest = await verifyReleaseArchive({ archive, trustedKeys, expectedTarget, minimumReleaseSequence: trust.minimumReleaseSequence })
    const backupOutput = resolve(values.get('backup-output') || join(config.OPENLINK_BACKUP_ROOT, `pre-upgrade-${candidateManifest.releaseId}-${Date.now()}.olb`))
    const transaction = await executeUpgradeTransaction({
      transactionId: randomUUID(),
      stateRoot: config.OPENLINK_STATE_ROOT,
      currentManifest,
      candidateManifest,
      stopService: () => serviceAction('stop', config.OPENLINK_STATE_ROOT),
      backup: async () => {
        const result = await createEncryptedBackup({ stateRoot: config.OPENLINK_STATE_ROOT, configPath, secretsPath: config.OPENLINK_SECRETS_FILE, keyFile: config.OPENLINK_BACKUP_KEY_FILE, output: backupOutput })
        return { output: result.output, manifestPath: result.manifestPath, sha256: result.manifest.payload.sha256 }
      },
      stage: () => installReleaseArchive({ archive, installRoot, trustedKeys, expectedTarget, activate: false }),
      activate: (releaseId) => activateRelease(installRoot, releaseId),
      startService: () => serviceAction('start', config.OPENLINK_STATE_ROOT),
      healthCheck: (releaseId) => waitForApplicationHealth(config.OPENLINK_APP_URL, releaseId),
    })
    process.stdout.write(`${JSON.stringify({ ok: true, transaction })}\n`)
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
  if (command === 'run') {
    const configPath = values.get('config')
    if (!configPath) throw new Error('run requires --config')
    const config = await readEnvironmentFile(resolve(configPath))
    const secrets = config.OPENLINK_SECRETS_FILE
      ? await readEnvironmentFile(resolve(config.OPENLINK_SECRETS_FILE), { secrets: true })
      : {}
    const environment = validateProductionEnvironment({ ...config, ...secrets })
    const releaseRoot = resolve(values.get('release-root') || releaseRootFromScript)
    const runtimeLock = await acquireRuntimeLock(environment.OPENLINK_STATE_ROOT, { releaseId: basename(releaseRoot) })
    let supervisor
    let terminate
    const termination = new Promise((resolveTermination) => { terminate = resolveTermination })
    const onSignal = (signal) => terminate({ signal })
    process.once('SIGINT', onSignal)
    process.once('SIGTERM', onSignal)
    try {
      await runPreflight({
        releaseRoot,
        stateRoot: environment.OPENLINK_STATE_ROOT,
        platform: process.platform,
        architecture: process.arch,
        dockerCommand: environment.OPENLINK_DOCKER_COMMAND || 'docker',
        environment,
        minimumFreeBytes: environment.OPENLINK_MINIMUM_FREE_BYTES,
        minimumMemoryBytes: environment.OPENLINK_MINIMUM_MEMORY_BYTES,
      })
      const plan = await createRuntimePlan({ releaseRoot, stateRoot: environment.OPENLINK_STATE_ROOT, environment })
      supervisor = new ProductionSupervisor(plan)
      await supervisor.start()
      const outcome = await Promise.race([termination, supervisor.wait().then(() => ({ signal: undefined }))])
      await supervisor.stop(outcome.signal || 'SIGTERM')
    } catch (error) {
      await supervisor?.stop('SIGTERM').catch(() => undefined)
      throw error
    } finally {
      process.removeListener('SIGINT', onSignal)
      process.removeListener('SIGTERM', onSignal)
      await runtimeLock.release()
    }
    return
  }
  throw new Error('Usage: openlinkctl <verify|install|configure|version|status|preflight|doctor|backup|restore|upgrade|run> [options]')
}

if (!isSea() && process.argv[1] && basename(process.argv[1]) === basename(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`openlinkctl: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
