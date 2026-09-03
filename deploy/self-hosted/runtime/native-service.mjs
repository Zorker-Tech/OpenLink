import { execFile as execFileCallback } from 'node:child_process'
import { chmod, chown, copyFile, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

import { durableRename, syncDirectory, syncFile } from './durable-fs.mjs'

const execFile = promisify(execFileCallback)

async function exists(path) {
  return lstat(path).then(() => true).catch((error) => error?.code === 'ENOENT' ? false : Promise.reject(error))
}

async function command(runner, executable, args, options = {}) {
  const result = await runner(executable, args, { timeout: options.timeout ?? 30_000, encoding: 'utf8' })
  return typeof result === 'string' ? result : result?.stdout ?? ''
}

async function requireGroup(runner, name) {
  try {
    await command(runner, 'getent', ['group', name])
  } catch {
    throw new Error(`Required Linux group does not exist: ${name}`)
  }
}

async function ensureLinuxIdentity(runner, stateRoot) {
  try {
    await command(runner, 'getent', ['group', 'openlink'])
  } catch {
    await command(runner, 'groupadd', ['--system', 'openlink'])
  }
  try {
    await command(runner, 'id', ['-u', 'openlink'])
  } catch {
    await command(runner, 'useradd', ['--system', '--gid', 'openlink', '--home-dir', stateRoot, '--shell', '/usr/sbin/nologin', 'openlink'])
  }
  await requireGroup(runner, 'kvm')
  // The dedicated identity owns no supplementary group except KVM. Using a
  // replacement group list also removes legacy Docker membership from hosts
  // upgraded from an older installer.
  await command(runner, 'usermod', ['--groups', 'kvm', 'openlink'])
  const uid = Number((await command(runner, 'id', ['-u', 'openlink'])).trim())
  const groupRecord = (await command(runner, 'getent', ['group', 'openlink'])).trim().split(':')
  const gid = Number(groupRecord[2])
  if (!Number.isSafeInteger(uid) || uid < 0 || !Number.isSafeInteger(gid) || gid < 0) throw new Error('Unable to resolve the openlink service identity')
  return { uid, gid }
}

async function atomicInstallFile(source, destination, mode) {
  const staging = `${destination}.openlink-${process.pid}-${Date.now()}`
  await mkdir(dirname(destination), { recursive: true, mode: 0o755 })
  try {
    await copyFile(source, staging)
    await chmod(staging, mode)
    await syncFile(staging)
    await durableRename(staging, destination)
  } finally {
    await rm(staging, { force: true })
  }
}

async function snapshotRegularFile(path) {
  const stats = await lstat(path).catch((error) => error?.code === 'ENOENT' ? undefined : Promise.reject(error))
  if (!stats) return { exists: false }
  if (!stats.isFile()) throw new Error(`Existing systemd unit is not a regular file: ${path}`)
  return { exists: true, contents: await readFile(path), mode: stats.mode & 0o777 }
}

async function atomicRestoreFile(destination, snapshot) {
  if (!snapshot.exists) {
    await rm(destination, { force: true })
    await syncDirectory(dirname(destination))
    return
  }
  const staging = `${destination}.openlink-rollback-${process.pid}-${Date.now()}`
  try {
    await writeFile(staging, snapshot.contents, { mode: snapshot.mode, flag: 'wx' })
    await chmod(staging, snapshot.mode)
    await syncFile(staging)
    await durableRename(staging, destination)
  } finally {
    await rm(staging, { force: true })
  }
}

async function systemdState(runner, action, service) {
  return (await command(runner, 'systemctl', [action, service])).trim()
}

export async function installNativeService(options = {}) {
  const platform = options.platform ?? process.platform
  if (platform !== 'linux') {
    throw new Error('Automatic native service installation is currently supported only on Linux; macOS requires a qualified non-GUI container-engine identity before GA')
  }
  if (!options.allowUnprivilegedTest && typeof process.getuid === 'function' && process.getuid() !== 0) {
    throw new Error('Native service installation must run as root')
  }
  const releaseRoot = resolve(options.releaseRoot)
  const configPath = resolve(options.configPath)
  const secretsPath = resolve(options.secretsPath)
  const backupKeyPath = resolve(options.backupKeyPath)
  const stateRoot = resolve(options.stateRoot)
  const logRoot = resolve(options.logRoot)
  const backupRoot = resolve(options.backupRoot)
  const unitPath = resolve(options.unitPath ?? '/etc/systemd/system/openlink.service')
  const brokerUnitPath = resolve(options.brokerUnitPath ?? '/etc/systemd/system/openlink-container-broker.service')
  const expected = {
    releaseRoot: '/opt/openlink/current',
    configPath: '/etc/openlink/openlink.env',
    stateRoot: '/var/lib/openlink',
    logRoot: '/var/log/openlink',
    backupRoot: '/var/backups/openlink',
    unitPath: '/etc/systemd/system/openlink.service',
    brokerUnitPath: '/etc/systemd/system/openlink-container-broker.service',
  }
  if (!options.allowCustomPaths) {
    for (const [name, value] of Object.entries(expected)) {
      const actual = name === 'releaseRoot' ? resolve(options.installRoot, 'current') : { configPath, stateRoot, logRoot, backupRoot, unitPath, brokerUnitPath }[name]
      if (actual !== value) throw new Error(`Linux production service requires ${name}=${value}`)
    }
  }
  for (const path of [configPath, secretsPath, backupKeyPath]) {
    if (!await exists(path) || !(await lstat(path)).isFile()) throw new Error(`Service configuration is missing: ${path}`)
  }
  const runner = options.execFile ?? execFile
  const identity = options.identity ?? await ensureLinuxIdentity(runner, stateRoot)
  for (const path of [stateRoot, logRoot, backupRoot]) {
    await mkdir(path, { recursive: true, mode: 0o700 })
    await chmod(path, 0o700)
    await chown(path, identity.uid, identity.gid)
  }
  await chmod(configPath, 0o640)
  await chown(configPath, options.rootUid ?? 0, identity.gid)
  await chmod(secretsPath, 0o640)
  await chown(secretsPath, options.rootUid ?? 0, identity.gid)
  await chmod(backupKeyPath, 0o600)
  await chown(backupKeyPath, options.rootUid ?? 0, identity.gid)
  await Promise.all([syncFile(configPath), syncFile(secretsPath), syncFile(backupKeyPath)])
  const unitSource = join(releaseRoot, 'systemd/openlink.service')
  const brokerUnitSource = join(releaseRoot, 'systemd/openlink-container-broker.service')
  const unit = await readFile(unitSource, 'utf8')
  const brokerUnit = await readFile(brokerUnitSource, 'utf8')
  if (!/^ExecStart=\/opt\/openlink\/current\/bin\/openlinkctl run --config \/etc\/openlink\/openlink\.env$/m.test(unit)) {
    throw new Error('Release systemd unit does not match the production path contract')
  }
  if (!/^ExecStart=\/opt\/openlink\/current\/bin\/openlinkctl container-broker --config \/etc\/openlink\/openlink\.env$/m.test(brokerUnit)
    || !/^User=root$/m.test(brokerUnit) || !/^RestrictAddressFamilies=AF_UNIX$/m.test(brokerUnit)) {
    throw new Error('Release container broker unit does not match the privileged production contract')
  }
  const units = [
    { service: 'openlink-container-broker.service', source: brokerUnitSource, destination: brokerUnitPath },
    { service: 'openlink.service', source: unitSource, destination: unitPath },
  ]
  for (const item of units) {
    item.snapshot = await snapshotRegularFile(item.destination)
    item.wasEnabled = item.snapshot.exists && (await systemdState(runner, 'is-enabled', item.service).catch(() => 'disabled')) === 'enabled'
    item.wasActive = item.snapshot.exists && (await systemdState(runner, 'is-active', item.service).catch(() => 'inactive')) === 'active'
  }
  try {
    for (const item of units) await atomicInstallFile(item.source, item.destination, 0o644)
    await command(runner, 'systemctl', ['daemon-reload'])
    await command(runner, 'systemctl', ['enable', '--now', 'openlink-container-broker.service', 'openlink.service'], { timeout: 660_000 })
    for (const service of ['openlink-container-broker.service', 'openlink.service']) {
      const state = (await command(runner, 'systemctl', ['is-active', service])).trim()
      if (state !== 'active') throw new Error(`${service} entered unexpected state: ${state || '<empty>'}`)
    }
  } catch (error) {
    const rollbackFailures = []
    await command(runner, 'systemctl', ['disable', '--now', 'openlink.service', 'openlink-container-broker.service'], { timeout: 240_000 }).catch((failure) => rollbackFailures.push(failure))
    for (const item of units) await atomicRestoreFile(item.destination, item.snapshot).catch((failure) => rollbackFailures.push(failure))
    await command(runner, 'systemctl', ['daemon-reload']).catch((failure) => rollbackFailures.push(failure))
    for (const item of units) {
      if (item.wasEnabled) await command(runner, 'systemctl', ['enable', item.service]).catch((failure) => rollbackFailures.push(failure))
      if (item.wasActive) await command(runner, 'systemctl', ['start', item.service], { timeout: 660_000 }).catch((failure) => rollbackFailures.push(failure))
    }
    if (rollbackFailures.length) throw new AggregateError([error, ...rollbackFailures], 'Native service installation failed and rollback was incomplete')
    throw error
  }
  return { manager: 'systemd', service: 'openlink.service', brokerService: 'openlink-container-broker.service', unitPath, brokerUnitPath, identity: 'openlink', active: true }
}
