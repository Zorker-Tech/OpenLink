#!/usr/bin/env node
import { constants } from 'node:fs'
import { cp, lstat, mkdir, mkdtemp, open, readFile, readlink, rm, symlink } from 'node:fs/promises'
import { execFile as execFileCallback } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { isSea } from 'node:sea'

import {
  canonicalJson,
  normalizeReleaseId,
  normalizeTarget,
  parseReleaseTrustPolicy,
  safeReleasePath,
  verifyReleaseInventory,
  verifyReleaseManifest,
} from './runtime/release-contract.mjs'
import { readEnvironmentFile, runPreflight } from './runtime/preflight.mjs'
import { extractVerifiedTarGzip } from './runtime/safe-archive.mjs'
import { checkContainerRuntime, createRuntimePlan, ProductionSupervisor, startContainerRuntime, stopContainerRuntime, validateProductionEnvironment } from './runtime/production-runtime.mjs'
import { serveContainerBroker } from './runtime/container-broker.mjs'
import { createProductionConfiguration, updateProductionProjectRuntime } from './runtime/configuration.mjs'
import { ensureMacPlatformContainerEngine } from './runtime/platform-container-engine.mjs'
import { selectProjectRuntime, terminalProjectRuntimePrompt, terminalVirtualizationHelp } from './runtime/runtime-selection.mjs'
import { acquireRuntimeLock, runtimeLockStatus } from './runtime/lifecycle-lock.mjs'
import { createEncryptedBackup, restoreEncryptedBackup } from './runtime/backup.mjs'
import { executeRollbackTransaction, executeUpgradeTransaction } from './runtime/upgrade.mjs'
import { durableRename, durableWriteFile, syncDirectory, syncTree } from './runtime/durable-fs.mjs'

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
  const before = await lstat(path)
  if (!before.isFile() || (before.mode & 0o022) !== 0) throw new Error('Release manifest must be a protected regular file')
  if (before.size > 32 * 1024 * 1024) throw new Error('Release manifest exceeds the 32 MiB limit')
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const current = await handle.stat()
    if (!current.isFile() || current.dev !== before.dev || current.ino !== before.ino || current.size !== before.size) throw new Error('Release manifest changed while opening')
    return JSON.parse(await handle.readFile('utf8'))
  } finally {
    await handle.close()
  }
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
  await syncDirectory(installRoot)
  try {
    await durableRename(stagedLink, link)
  } catch (error) {
    if (error?.code !== 'EEXIST' && error?.code !== 'ENOTEMPTY') throw error
    const oldLink = join(installRoot, `.current-old-${process.pid}-${Date.now()}`)
    await durableRename(link, oldLink)
    try {
      await durableRename(stagedLink, link)
    } catch (activationError) {
      await durableRename(oldLink, link).catch(() => undefined)
      throw activationError
    }
    await rm(oldLink, { force: true })
    await syncDirectory(installRoot)
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
    await durableWriteFile(join(staging, 'release.json'), `${JSON.stringify(signed, null, 2)}\n`, { mode: 0o644, flag: 'wx' })
    await verifyInstalledRelease(staging, options.trustedKeys, expectedTarget, options.minimumReleaseSequence)
    await syncTree(staging)
    await durableRename(staging, destination)
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

function commandOutput(result) {
  return typeof result === 'string' ? result : result?.stdout ?? ''
}

function defaultConfigPath(platform = process.platform) {
  if (platform === 'linux') return '/etc/openlink/openlink.env'
  if (platform === 'darwin') return '/Library/Application Support/OpenLink/config/openlink.env'
  throw new Error(`Native service control is unsupported on ${platform}`)
}

function requireServiceAdministrator(platform, getuid = process.getuid?.bind(process)) {
  if (platform === 'linux' && (typeof getuid !== 'function' || getuid() !== 0)) {
    throw new Error('Linux production service control must run as root')
  }
}

export function deploymentStatus(config = {}) {
  return {
    profile: config.OPENLINK_DEPLOYMENT_PROFILE || 'standard',
    profileRevision: config.OPENLINK_DEPLOYMENT_PROFILE_REVISION || 'standard/v1',
    projectRuntime: config.OPENLINK_PROJECT_RUNTIME || 'vm',
    isolation: config.OPENLINK_PROJECT_ISOLATION || 'vm',
    knowledge: config.OPENLINK_KNOWLEDGE_ENABLED !== '0',
    zero: config.OPENLINK_ZERO_ENABLED !== '0',
  }
}

export async function serviceAction(action, stateRoot, options = {}) {
  if (!['start', 'stop', 'restart'].includes(action)) throw new Error(`Unsupported service action: ${action}`)
  const platform = options.platform ?? process.platform
  const runner = options.execFile ?? execFile
  requireServiceAdministrator(platform, options.getuid)
  if (platform === 'linux') {
    if (options.reconcileProjectBroker === true && action !== 'stop') {
      await runner('systemctl', [options.projectRuntime === 'container' ? 'enable' : 'disable', ...(options.projectRuntime === 'container' ? [] : ['--now']), 'openlink-project-container-broker.service'], { timeout: 240_000 })
    }
    const projectBroker = options.projectRuntime === 'container' ? ['openlink-project-container-broker.service'] : []
    const services = action === 'stop'
      ? ['openlink.service', ...projectBroker, 'openlink-container-broker.service']
      : ['openlink-container-broker.service', ...projectBroker, 'openlink.service']
    await runner('systemctl', [action, ...services], { timeout: action === 'stop' ? 240_000 : 660_000 })
    return
  }
  if (platform === 'darwin') {
    const args = action === 'stop'
      ? ['kill', 'SIGTERM', 'system/io.zokerbase.openlink']
      : ['kickstart', '-k', 'system/io.zokerbase.openlink']
    await runner('/bin/launchctl', args, { timeout: action === 'stop' ? 240_000 : 30_000 })
    if (action === 'stop') {
      const deadline = Date.now() + 240_000
      const lockStatus = options.runtimeLockStatus ?? runtimeLockStatus
      while ((await lockStatus(stateRoot)).running && Date.now() < deadline) await new Promise((resolveDelay) => setTimeout(resolveDelay, 250))
      if ((await lockStatus(stateRoot)).running) throw new Error('OpenLink LaunchDaemon did not stop within 240 seconds')
    }
    return
  }
  throw new Error(`Native service control is unsupported on ${platform}`)
}

function parseSystemdProperties(output) {
  return Object.fromEntries(String(output).trim().split('\n').filter(Boolean).map((line) => {
    const separator = line.indexOf('=')
    return separator < 1 ? [line, ''] : [line.slice(0, separator), line.slice(separator + 1)]
  }))
}

export async function nativeServiceStatus(options = {}) {
  const platform = options.platform ?? process.platform
  const runner = options.execFile ?? execFile
  if (platform === 'linux') {
    const inspect = async (service) => parseSystemdProperties(commandOutput(await runner('systemctl', [
      'show', service, '--property=ActiveState', '--property=SubState', '--property=UnitFileState', '--property=MainPID', '--no-pager',
    ], { timeout: 15_000 })))
    const [service, broker, projectBroker] = await Promise.all([
      inspect('openlink.service'),
      inspect('openlink-container-broker.service'),
      options.projectRuntime === 'container' ? inspect('openlink-project-container-broker.service') : undefined,
    ])
    return { manager: 'systemd', active: service.ActiveState === 'active' && broker.ActiveState === 'active' && (!projectBroker || projectBroker.ActiveState === 'active'), service, broker, ...(projectBroker ? { projectBroker } : {}) }
  }
  if (platform === 'darwin') {
    try {
      const detail = commandOutput(await runner('/bin/launchctl', ['print', 'system/io.zokerbase.openlink'], { timeout: 15_000 }))
      return { manager: 'launchd', active: /\bstate\s*=\s*running\b/.test(detail), loaded: true }
    } catch (error) {
      return { manager: 'launchd', active: false, loaded: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
  throw new Error(`Native service status is unsupported on ${platform}`)
}

async function boundedResponseText(response, maximumBytes = 64 * 1024) {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maximumBytes) throw new Error('OpenLink health response is too large')
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maximumBytes) throw new Error('OpenLink health response is too large')
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8')
}

export async function inspectApplicationHealth(url, expectedReleaseId, options = {}) {
  const healthUrl = new URL('/api/healthz', url)
  const response = await (options.fetch ?? fetch)(healthUrl, { redirect: 'manual', signal: AbortSignal.timeout(options.timeoutMs ?? 5_000) })
  const body = JSON.parse(await boundedResponseText(response, options.maximumBytes))
  if (response.status !== 200 || body?.ok !== true) throw new Error(`OpenLink health check failed with HTTP ${response.status}`)
  if (expectedReleaseId && body.releaseId !== expectedReleaseId) throw new Error(`OpenLink health reports release ${body.releaseId ?? '<missing>'}, expected ${expectedReleaseId}`)
  return { url: healthUrl.href, status: response.status, releaseId: body.releaseId, healthy: true, checks: body.checks }
}

export async function readServiceLogs(options = {}) {
  const platform = options.platform ?? process.platform
  const runner = options.execFile ?? execFile
  const lines = Number(options.lines ?? 200)
  if (!Number.isSafeInteger(lines) || lines < 1 || lines > 5_000) throw new Error('Log line count must be between 1 and 5000')
  if (platform === 'linux') {
    return commandOutput(await runner('journalctl', ['--unit=openlink.service', '--unit=openlink-container-broker.service', '--unit=openlink-project-container-broker.service', `--lines=${lines}`, '--no-pager', '--output=short-iso-precise'], { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }))
  }
  if (platform === 'darwin') {
    const output = commandOutput(await runner('/usr/bin/log', ['show', '--style', 'syslog', '--last', options.since ?? '1h', '--predicate', 'process == "openlinkctl"'], { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }))
    const records = output.split('\n')
    return records.slice(Math.max(0, records.length - lines - 1)).join('\n')
  }
  throw new Error(`Native service logs are unsupported on ${platform}`)
}

export async function waitForApplicationHealth(url, expectedReleaseId, timeoutMs = 600_000) {
  const deadline = Date.now() + timeoutMs
  const healthUrl = new URL('/api/healthz', url)
  while (Date.now() < deadline) {
    try {
      await inspectApplicationHealth(url, expectedReleaseId)
      return
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
  if (before.size > 1024 * 1024) throw new Error('Release trust file exceeds the 1 MiB limit')
  const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const current = await handle.stat()
    if (!current.isFile() || current.dev !== before.dev || current.ino !== before.ino || current.size !== before.size) throw new Error('Release trust file changed while opening')
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
    const requestedRuntime = values.get('project-runtime') || 'auto'
    const runtimeSelection = await selectProjectRuntime({
      requestedRuntime,
      platform: process.platform,
      architecture: process.arch,
      policy: values.get('on-virtualization-unavailable'),
      acknowledgeIsolationDowngrade: values.get('acknowledge-isolation-downgrade') === '1',
      interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
      prompt: terminalProjectRuntimePrompt,
      showHelp: terminalVirtualizationHelp,
    })
    const result = await createProductionConfiguration({
      releaseRoot: resolve(values.get('release-root') || releaseRootFromScript),
      configPath: values.get('config'),
      secretsPath: values.get('secrets'),
      stateRoot: values.get('state-root'),
      logRoot: values.get('log-root'),
      backupRoot: values.get('backup-root'),
      appUrl: values.get('app-url'),
      gatewayUrl: values.get('gateway-url'),
      deploymentProfile: values.get('profile'),
      projectRuntime: runtimeSelection.runtime,
      allowInsecure: values.get('allow-insecure-http') === '1',
      overwrite: values.get('overwrite') === '1',
    })
    process.stdout.write(`${JSON.stringify({ ok: true, ...result, projectRuntime: runtimeSelection.runtime, runtimeSelection: runtimeSelection.action })}\n`)
    return
  }
  if (command === 'status') {
    const config = await readEnvironmentFile(resolve(values.get('config') || defaultConfigPath()))
    const [service, runtime] = await Promise.all([nativeServiceStatus({ projectRuntime: config.OPENLINK_PROJECT_RUNTIME }), runtimeLockStatus(config.OPENLINK_STATE_ROOT)])
    const active = service.active && runtime.running
    process.stdout.write(`${JSON.stringify({
      ok: true,
      active,
      deployment: deploymentStatus(config),
      service,
      runtime,
    })}\n`)
    if (!active) process.exitCode = 3
    return
  }
  if (command === 'start' || command === 'stop' || command === 'restart') {
    const configPath = resolve(values.get('config') || defaultConfigPath())
    const config = await readEnvironmentFile(configPath)
    let runtimeSelection
    if (command !== 'stop') {
      const requestedRuntime = values.get('project-runtime') || config.OPENLINK_PROJECT_RUNTIME || 'vm'
      const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY)
      if ((config.OPENLINK_PROJECT_RUNTIME || 'vm') === 'vm' && requestedRuntime === 'container'
        && !interactive && values.get('acknowledge-isolation-downgrade') !== '1') {
        throw new Error('Unattended VM-to-Container selection requires --acknowledge-isolation-downgrade 1')
      }
      runtimeSelection = await selectProjectRuntime({
        requestedRuntime,
        platform: process.platform,
        architecture: process.arch,
        policy: values.get('on-virtualization-unavailable'),
        acknowledgeIsolationDowngrade: values.get('acknowledge-isolation-downgrade') === '1',
        interactive,
        prompt: terminalProjectRuntimePrompt,
        showHelp: terminalVirtualizationHelp,
      })
      if (runtimeSelection.runtime !== (config.OPENLINK_PROJECT_RUNTIME || 'vm')) {
        await updateProductionProjectRuntime(configPath, runtimeSelection.runtime)
      }
    }
    await serviceAction(command, config.OPENLINK_STATE_ROOT, { projectRuntime: runtimeSelection?.runtime ?? config.OPENLINK_PROJECT_RUNTIME, reconcileProjectBroker: command !== 'stop' })
    const service = await nativeServiceStatus({ projectRuntime: runtimeSelection?.runtime ?? config.OPENLINK_PROJECT_RUNTIME })
    process.stdout.write(`${JSON.stringify({ ok: true, action: command, service, ...(runtimeSelection ? { projectRuntime: runtimeSelection.runtime, runtimeSelection: runtimeSelection.action } : {}) })}\n`)
    return
  }
  if (command === 'health') {
    const config = await readEnvironmentFile(resolve(values.get('config') || defaultConfigPath()))
    const installRoot = resolve(values.get('root') || (process.platform === 'linux' ? '/opt/openlink' : '/Library/Application Support/OpenLink'))
    const expectedReleaseId = basename(await readlink(join(installRoot, 'current')))
    const result = await inspectApplicationHealth(config.OPENLINK_APP_URL, expectedReleaseId)
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`)
    return
  }
  if (command === 'logs') {
    const result = await readServiceLogs({ lines: values.get('lines'), since: values.get('since') })
    process.stdout.write(result.endsWith('\n') ? result : `${result}\n`)
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
      stopService: () => serviceAction('stop', config.OPENLINK_STATE_ROOT, { projectRuntime: config.OPENLINK_PROJECT_RUNTIME }),
      backup: async () => {
        const result = await createEncryptedBackup({ stateRoot: config.OPENLINK_STATE_ROOT, configPath, secretsPath: config.OPENLINK_SECRETS_FILE, keyFile: config.OPENLINK_BACKUP_KEY_FILE, output: backupOutput })
        return { output: result.output, manifestPath: result.manifestPath, sha256: result.manifest.payload.sha256 }
      },
      stage: () => installReleaseArchive({ archive, installRoot, trustedKeys, expectedTarget, activate: false }),
      activate: (releaseId) => activateRelease(installRoot, releaseId),
      startService: () => serviceAction('start', config.OPENLINK_STATE_ROOT, { projectRuntime: config.OPENLINK_PROJECT_RUNTIME }),
      healthCheck: (releaseId) => waitForApplicationHealth(config.OPENLINK_APP_URL, releaseId),
    })
    process.stdout.write(`${JSON.stringify({ ok: true, transaction })}\n`)
    return
  }
  if (command === 'rollback') {
    const installRoot = resolve(values.get('root') || (process.platform === 'linux' ? '/opt/openlink' : '/Library/Application Support/OpenLink'))
    const targetReleaseId = normalizeReleaseId(values.get('release'))
    const configPath = resolve(values.get('config') || defaultConfigPath())
    const config = await readEnvironmentFile(configPath)
    const trust = await trustPolicyFrom(values.get('trust'))
    const expectedTarget = normalizeTarget({ platform: process.platform, architecture: process.arch })
    const currentDirectory = resolve(installRoot, await readlink(join(installRoot, 'current')))
    const targetDirectory = join(installRoot, 'releases', targetReleaseId)
    const currentManifest = (await verifyInstalledRelease(currentDirectory, trust.trustedKeys, expectedTarget, trust.minimumReleaseSequence)).manifest
    const targetManifest = (await verifyInstalledRelease(targetDirectory, trust.trustedKeys, expectedTarget, trust.minimumReleaseSequence)).manifest
    if (targetManifest.releaseId !== targetReleaseId) throw new Error('Rollback target release identity does not match its directory')
    const backupOutput = resolve(values.get('backup-output') || join(config.OPENLINK_BACKUP_ROOT, `pre-rollback-${targetReleaseId}-${Date.now()}.olb`))
    const transaction = await executeRollbackTransaction({
      transactionId: randomUUID(),
      stateRoot: config.OPENLINK_STATE_ROOT,
      currentManifest,
      targetManifest,
      stopService: () => serviceAction('stop', config.OPENLINK_STATE_ROOT, { projectRuntime: config.OPENLINK_PROJECT_RUNTIME }),
      backup: async () => {
        const result = await createEncryptedBackup({ stateRoot: config.OPENLINK_STATE_ROOT, configPath, secretsPath: config.OPENLINK_SECRETS_FILE, keyFile: config.OPENLINK_BACKUP_KEY_FILE, output: backupOutput })
        return { output: result.output, manifestPath: result.manifestPath, sha256: result.manifest.payload.sha256 }
      },
      activate: (releaseId) => activateRelease(installRoot, releaseId),
      startService: () => serviceAction('start', config.OPENLINK_STATE_ROOT, { projectRuntime: config.OPENLINK_PROJECT_RUNTIME }),
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
      containerBrokerSocket: config.OPENLINK_CONTAINER_BROKER_SOCKET,
      environment: { ...config, ...secrets },
      minimumFreeBytes: config.OPENLINK_MINIMUM_FREE_BYTES,
      minimumMemoryBytes: config.OPENLINK_MINIMUM_MEMORY_BYTES,
    })
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    return
  }
  if (command === 'run') {
    if (process.platform === 'linux' && (typeof process.getuid !== 'function' || process.getuid() !== 0)) {
      throw new Error('Linux production runtime supervisor must start as root to create isolated service identities')
    }
    const configPath = values.get('config')
    if (!configPath) throw new Error('run requires --config')
    const config = await readEnvironmentFile(resolve(configPath))
    const secrets = config.OPENLINK_SECRETS_FILE
      ? await readEnvironmentFile(resolve(config.OPENLINK_SECRETS_FILE), { secrets: true })
      : {}
    const environment = validateProductionEnvironment({ ...config, ...secrets })
    const releaseRoot = resolve(values.get('release-root') || releaseRootFromScript)
    const trust = await trustPolicyFrom(config.OPENLINK_RELEASE_TRUST_FILE)
    const verified = await verifyInstalledRelease(releaseRoot, trust.trustedKeys, expectedTarget, trust.minimumReleaseSequence)
    const runtimeLock = await acquireRuntimeLock(environment.OPENLINK_STATE_ROOT, { releaseId: basename(releaseRoot) })
    let supervisor
    let terminate
    const termination = new Promise((resolveTermination) => { terminate = resolveTermination })
    const onSignal = (signal) => terminate({ signal })
    process.once('SIGINT', onSignal)
    process.once('SIGTERM', onSignal)
    try {
      if (process.platform === 'darwin') {
        const vmManifest = JSON.parse(await readFile(join(releaseRoot, 'project-vm/manifest.json'), 'utf8'))
        if (typeof vmManifest.disk !== 'string' || !vmManifest.disk || vmManifest.disk.includes('/') || vmManifest.disk.includes('\\')) {
          throw new Error('Signed release does not contain a valid local platform Golden Disk')
        }
        await ensureMacPlatformContainerEngine({
          env: environment,
          releaseRoot,
          stateRoot: environment.OPENLINK_STATE_ROOT,
          baseDisk: join(releaseRoot, 'project-vm', vmManifest.disk),
          podman: join(releaseRoot, 'toolchain/bin/podman'),
          helperRoot: join(releaseRoot, 'toolchain/bin'),
        })
      }
      await runPreflight({
        releaseRoot,
        stateRoot: environment.OPENLINK_STATE_ROOT,
        platform: process.platform,
        architecture: process.arch,
        dockerCommand: environment.OPENLINK_DOCKER_COMMAND || 'docker',
        containerBrokerSocket: environment.OPENLINK_CONTAINER_BROKER_SOCKET,
        environment,
        minimumFreeBytes: environment.OPENLINK_MINIMUM_FREE_BYTES,
        minimumMemoryBytes: environment.OPENLINK_MINIMUM_MEMORY_BYTES,
      })
      const plan = await createRuntimePlan({ releaseRoot, stateRoot: environment.OPENLINK_STATE_ROOT, environment })
      if (verified.manifest.releaseId !== basename(releaseRoot)) throw new Error('Active release directory does not match its signed release identity')
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
  if (command === 'container-broker') {
    if (process.platform !== 'linux' || typeof process.getuid !== 'function' || process.getuid() !== 0) throw new Error('Container broker must run as root on Linux')
    const configPath = values.get('config')
    if (!configPath) throw new Error('container-broker requires --config')
    const config = await readEnvironmentFile(resolve(configPath))
    const secrets = await readEnvironmentFile(resolve(config.OPENLINK_SECRETS_FILE), { secrets: true })
    const environment = validateProductionEnvironment({ ...config, ...secrets })
    const releaseRoot = resolve(values.get('release-root') || releaseRootFromScript)
    const plan = await createRuntimePlan({ releaseRoot, stateRoot: environment.OPENLINK_STATE_ROOT, environment })
    const socket = environment.OPENLINK_CONTAINER_BROKER_SOCKET
    if (!socket) throw new Error('Production configuration has no container broker socket')
    await checkContainerRuntime(plan)
    const broker = await serveContainerBroker(socket, async (action) => {
      if (action === 'status') return checkContainerRuntime(plan)
      if (action === 'start') return startContainerRuntime(plan)
      if (action === 'stop') return stopContainerRuntime(plan)
      throw new Error('Container broker action is not allowed')
    })
    if (process.env.NOTIFY_SOCKET) await execFile('systemd-notify', ['--ready', '--status=OpenLink container broker is ready'])
    await new Promise((resolveStop) => {
      process.once('SIGINT', resolveStop)
      process.once('SIGTERM', resolveStop)
    })
    await broker.close()
    return
  }
  throw new Error('Usage: openlinkctl <verify|install|configure|version|start|stop|restart|status|health|logs|preflight|doctor|backup|restore|upgrade|rollback|run|container-broker> [options]')
}

if (!isSea() && process.argv[1] && basename(process.argv[1]) === basename(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`openlinkctl: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
