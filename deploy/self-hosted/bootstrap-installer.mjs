#!/usr/bin/env node
import { getAsset, isSea } from 'node:sea'
import { constants } from 'node:fs'
import { chmod, chown, lstat, mkdir, open, readlink, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import { activateRelease, installReleaseArchive } from './openlinkctl.mjs'
import { createProductionConfiguration } from './runtime/configuration.mjs'
import { canonicalJson, normalizeTarget, parseReleaseTrustPolicy } from './runtime/release-contract.mjs'
import { readEnvironmentFile, runPreflight } from './runtime/preflight.mjs'
import { installNativeService } from './runtime/native-service.mjs'
import { durableWriteFile } from './runtime/durable-fs.mjs'
import { selectProjectRuntime, terminalProjectRuntimePrompt, terminalVirtualizationHelp } from './runtime/runtime-selection.mjs'

function parseArguments(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith('--') || value === undefined) throw new Error(`Invalid installer argument near ${key ?? '<end>'}`)
    values.set(key.slice(2), value)
  }
  return values
}

function paths(values) {
  if (process.platform === 'linux') {
    const configPath = resolve(values.get('config') || '/etc/openlink/openlink.env')
    return {
      installRoot: resolve(values.get('root') || '/opt/openlink'),
      configPath,
      trustPath: resolve(values.get('trust-destination') || join(dirname(configPath), 'release-keys.json')),
      secretsPath: resolve(values.get('secrets') || join(dirname(configPath), 'secrets.env')),
      stateRoot: resolve(values.get('state-root') || '/var/lib/openlink'),
      logRoot: resolve(values.get('log-root') || '/var/log/openlink'),
      backupRoot: resolve(values.get('backup-root') || '/var/backups/openlink'),
    }
  }
  if (process.platform === 'darwin') {
    const root = resolve(values.get('root') || '/Library/Application Support/OpenLink')
    const configPath = resolve(values.get('config') || join(root, 'config/openlink.env'))
    return {
      installRoot: root,
      configPath,
      trustPath: resolve(values.get('trust-destination') || join(dirname(configPath), 'release-keys.json')),
      secretsPath: resolve(values.get('secrets') || join(dirname(configPath), 'secrets.env')),
      stateRoot: resolve(values.get('state-root') || join(root, 'state')),
      logRoot: resolve(values.get('log-root') || '/Library/Logs/OpenLink'),
      backupRoot: resolve(values.get('backup-root') || join(root, 'backups')),
    }
  }
  throw new Error(`OpenLink production installer does not support ${process.platform}`)
}

async function readProtectedTrustFile(path) {
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
    return JSON.parse(await handle.readFile('utf8'))
  } finally {
    await handle.close()
  }
}

async function trustRoot(values) {
  if (isSea()) {
    const document = JSON.parse(getAsset('release-keys.json', 'utf8'))
    return { ...parseReleaseTrustPolicy(document), document }
  }
  const path = values.get('trust')
  if (!path) throw new Error('A trust file is required outside the sealed installer')
  const document = await readProtectedTrustFile(path)
  return { ...parseReleaseTrustPolicy(document), document }
}

async function installTrustPolicy(path, document) {
  const serialized = `${JSON.stringify(document, null, 2)}\n`
  const existing = await lstat(path).catch((error) => error?.code === 'ENOENT' ? undefined : Promise.reject(error))
  if (existing) {
    const expectedUid = typeof process.getuid === 'function' ? process.getuid() : undefined
    if (!existing.isFile() || (existing.mode & 0o022) !== 0 || (expectedUid !== undefined && existing.uid !== expectedUid)) throw new Error('Installed release trust policy must be a protected administrator-owned regular file')
    const current = await readProtectedTrustFile(path)
    parseReleaseTrustPolicy(current)
    if (canonicalJson(current) !== canonicalJson(document)) throw new Error('Installed release trust policy differs; rotate trust explicitly before installing this release')
    return
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o750 })
  await durableWriteFile(path, serialized, { mode: 0o644, flag: 'wx' })
  await chmod(path, 0o644)
  if (typeof process.getuid === 'function' && process.getuid() === 0) await chown(path, 0, 0)
}

async function existingConfiguration(destination, appUrl) {
  const backupKeyPath = join(dirname(destination.configPath), 'backup.key')
  const corePaths = [destination.configPath, destination.secretsPath, backupKeyPath]
  const corePresent = await Promise.all(corePaths.map((path) => lstat(path).then((stats) => stats.isFile()).catch((error) => error?.code === 'ENOENT' ? false : Promise.reject(error))))
  if (!corePresent.some(Boolean)) return undefined
  const trustPresent = await lstat(destination.trustPath).then((stats) => stats.isFile()).catch((error) => error?.code === 'ENOENT' ? false : Promise.reject(error))
  if (!corePresent.every(Boolean) || !trustPresent) throw new Error('Existing production configuration is incomplete; refusing secret rotation or partial reuse')
  const config = await readEnvironmentFile(destination.configPath)
  await readEnvironmentFile(destination.secretsPath, { secrets: true })
  const backupKey = await lstat(backupKeyPath)
  if (!backupKey.isFile() || (backupKey.mode & 0o077) !== 0) throw new Error('Existing backup key must be a protected regular file with mode 0600')
  const expectedAppUrl = new URL(appUrl).origin
  if (config.OPENLINK_APP_URL !== expectedAppUrl
    || resolve(config.OPENLINK_STATE_ROOT) !== destination.stateRoot
    || resolve(config.OPENLINK_LOG_ROOT) !== destination.logRoot
    || resolve(config.OPENLINK_BACKUP_ROOT) !== destination.backupRoot
    || resolve(config.OPENLINK_SECRETS_FILE) !== destination.secretsPath
    || resolve(config.OPENLINK_RELEASE_TRUST_FILE) !== destination.trustPath
    || resolve(config.OPENLINK_BACKUP_KEY_FILE) !== backupKeyPath) {
    throw new Error('Existing production configuration does not match this installation request')
  }
  if (process.platform === 'linux') await chmod(destination.stateRoot, 0o711)
  return { configPath: destination.configPath, secretsPath: destination.secretsPath, backupKeyPath, stateRoot: destination.stateRoot, appUrl: expectedAppUrl, reused: true }
}

async function rollbackFreshActivation(installRoot, releaseId) {
  const current = join(installRoot, 'current')
  const target = await readlink(current).catch((error) => error?.code === 'ENOENT' ? undefined : Promise.reject(error))
  if (target === undefined) return
  if (target.split('/').at(-1) !== releaseId) throw new Error(`Refusing to roll back a concurrently changed active release: ${target}`)
  await rm(current)
}

export async function runBootstrapInstaller(argv = process.argv.slice(2)) {
  if (argv.length === 1 && argv[0] === '--self-test') {
    const trust = await trustRoot(new Map())
    return { ok: true, sealedInstaller: isSea(), target: normalizeTarget({ platform: process.platform, architecture: process.arch }).triple, trustedKeyIds: Object.keys(trust.trustedKeys).sort(), minimumReleaseSequence: trust.minimumReleaseSequence }
  }
  const values = parseArguments(argv)
  const archive = values.get('archive')
  const appUrl = values.get('app-url')
  if (!archive || !appUrl) throw new Error('Usage: openlink-installer --archive <bundle.tar.gz> --app-url <https-origin> [--root <path>]')
  const parsedAppUrl = new URL(appUrl)
  if (parsedAppUrl.protocol !== 'https:' && !(values.get('allow-insecure-http') === '1' && parsedAppUrl.protocol === 'http:')) {
    throw new Error('Production deployment URL must use HTTPS')
  }
  const destination = paths(values)
  const trust = await trustRoot(values)
  const expectedTarget = normalizeTarget({ platform: process.platform, architecture: process.arch })
  const installed = await installReleaseArchive({ archive, installRoot: destination.installRoot, trustedKeys: trust.trustedKeys, minimumReleaseSequence: trust.minimumReleaseSequence, expectedTarget, activate: false })
  const activeRelease = await readlink(join(destination.installRoot, 'current'))
    .then((target) => target.split('/').at(-1))
    .catch((error) => error?.code === 'ENOENT' ? undefined : Promise.reject(error))
  if (activeRelease && activeRelease !== installed.releaseId) {
    throw new Error(`Active release ${activeRelease} must be changed with openlinkctl upgrade, not the installer`)
  }
  await activateRelease(destination.installRoot, installed.releaseId)
  const activatedFresh = activeRelease === undefined
  try {
    const existing = await existingConfiguration(destination, appUrl)
    await installTrustPolicy(destination.trustPath, trust.document)
    const releaseRoot = installed.destination
    const skipHostPreflight = values.get('skip-host-preflight') === '1'
    const requestedRuntime = values.get('project-runtime') || 'auto'
    const runtimeSelection = existing
      ? undefined
      : skipHostPreflight
        ? { runtime: requestedRuntime === 'auto' ? 'vm' : requestedRuntime, action: 'preflight-skipped' }
        : await selectProjectRuntime({
            requestedRuntime,
            platform: process.platform,
            architecture: process.arch,
            policy: values.get('on-virtualization-unavailable'),
            acknowledgeIsolationDowngrade: values.get('acknowledge-isolation-downgrade') === '1',
            interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
            prompt: terminalProjectRuntimePrompt,
            showHelp: terminalVirtualizationHelp,
          })
    const configuration = existing ?? await createProductionConfiguration({
      releaseRoot,
      configPath: destination.configPath,
      secretsPath: destination.secretsPath,
      trustPath: destination.trustPath,
      stateRoot: destination.stateRoot,
      logRoot: destination.logRoot,
      backupRoot: destination.backupRoot,
      appUrl,
      gatewayUrl: values.get('gateway-url'),
      deploymentProfile: values.get('profile'),
      projectRuntime: runtimeSelection.runtime,
      allowInsecure: values.get('allow-insecure-http') === '1',
    })
    if (!skipHostPreflight) {
      const config = await readEnvironmentFile(destination.configPath)
      const secrets = await readEnvironmentFile(destination.secretsPath, { secrets: true })
      await runPreflight({
        releaseRoot,
        stateRoot: destination.stateRoot,
        platform: process.platform,
        architecture: process.arch,
        dockerCommand: values.get('docker-command') || 'docker',
        environment: { ...config, ...secrets },
      })
    }
    const service = values.get('skip-service-install') === '1' ? { skipped: true } : await installNativeService({
      releaseRoot,
      installRoot: destination.installRoot,
      configPath: destination.configPath,
      secretsPath: destination.secretsPath,
      backupKeyPath: configuration.backupKeyPath,
      stateRoot: destination.stateRoot,
      logRoot: destination.logRoot,
      backupRoot: destination.backupRoot,
    })
    return {
      ok: true,
      installed,
      service,
      configuration: { ...configuration, secretsPath: '<protected>', backupKeyPath: '<protected>' },
      ...(runtimeSelection ? { projectRuntime: runtimeSelection.runtime, runtimeSelection: runtimeSelection.action } : {}),
    }
  } catch (error) {
    if (activatedFresh) {
      await rollbackFreshActivation(destination.installRoot, installed.releaseId).catch((rollbackError) => {
        throw new AggregateError([error, rollbackError], 'Installation failed and the fresh release activation could not be rolled back')
      })
    }
    throw error
  }
}

if (import.meta.url === `file://${process.argv[1]}` || isSea()) {
  runBootstrapInstaller().then((result) => process.stdout.write(`${JSON.stringify(result)}\n`)).catch((error) => {
    process.stderr.write(`openlink-installer: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
