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

const LINUX_IDENTITIES = {
  supervisor: { name: 'openlink', groups: [] },
  browser: { name: 'openlink-browser', groups: [] },
  knowledge: { name: 'openlink-knowledge', groups: [] },
  agent: { name: 'openlink-agent', groups: ['kvm', 'openlink-workspace'] },
  desktop: { name: 'openlink-desktop', groups: ['openlink-workspace'] },
  web: { name: 'openlink-web', groups: [] },
  edge: { name: 'openlink-edge', groups: [] },
}

async function ensureGroup(runner, name) {
  try {
    await command(runner, 'getent', ['group', name])
  } catch {
    await command(runner, 'groupadd', ['--system', name])
  }
}

async function ensureLinuxIdentity(runner, name, stateRoot, groups) {
  await ensureGroup(runner, name)
  try {
    await command(runner, 'id', ['-u', name])
  } catch {
    await command(runner, 'useradd', ['--system', '--gid', name, '--home-dir', stateRoot, '--shell', '/usr/sbin/nologin', name])
  }
  await command(runner, 'usermod', ['--home', stateRoot, '--shell', '/usr/sbin/nologin', '--gid', name, '--groups', groups.join(','), name])
  const uid = Number((await command(runner, 'id', ['-u', name])).trim())
  const gid = Number((await command(runner, 'id', ['-g', name])).trim())
  if (!Number.isSafeInteger(uid) || uid < 0 || !Number.isSafeInteger(gid) || gid < 0) throw new Error(`Unable to resolve the ${name} service identity`)
  return { name, uid, gid, groups }
}

async function ensureLinuxIdentities(runner, stateRoot) {
  // Some container-only/minimal distributions do not pre-create this group.
  // Creating it is harmless without /dev/kvm and keeps a later explicit move
  // to VM mode possible without changing the Agent identity contract.
  await ensureGroup(runner, 'kvm')
  await ensureGroup(runner, 'openlink-workspace')
  // Account databases use a global lock; serialize mutations so first install
  // is deterministic under shadow-utils rather than racing concurrent useradd.
  const entries = []
  for (const [role, policy] of Object.entries(LINUX_IDENTITIES)) {
    entries.push([role, await ensureLinuxIdentity(runner, policy.name, stateRoot, policy.groups)])
  }
  return Object.fromEntries(entries)
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
  const projectBrokerUnitPath = resolve(options.projectBrokerUnitPath ?? '/etc/systemd/system/openlink-project-container-broker.service')
  const expected = {
    releaseRoot: '/opt/openlink/current',
    configPath: '/etc/openlink/openlink.env',
    stateRoot: '/var/lib/openlink',
    logRoot: '/var/log/openlink',
    backupRoot: '/var/backups/openlink',
    unitPath: '/etc/systemd/system/openlink.service',
    brokerUnitPath: '/etc/systemd/system/openlink-container-broker.service',
    projectBrokerUnitPath: '/etc/systemd/system/openlink-project-container-broker.service',
  }
  if (!options.allowCustomPaths) {
    for (const [name, value] of Object.entries(expected)) {
      const actual = name === 'releaseRoot' ? resolve(options.installRoot, 'current') : { configPath, stateRoot, logRoot, backupRoot, unitPath, brokerUnitPath, projectBrokerUnitPath }[name]
      if (actual !== value) throw new Error(`Linux production service requires ${name}=${value}`)
    }
  }
  for (const path of [configPath, secretsPath, backupKeyPath]) {
    if (!await exists(path) || !(await lstat(path)).isFile()) throw new Error(`Service configuration is missing: ${path}`)
  }
  const configurationSource = await readFile(configPath, 'utf8')
  const configuredForContainers = /^OPENLINK_PROJECT_RUNTIME=container$/m.test(configurationSource)
  const runner = options.execFile ?? execFile
  const identities = options.identities ?? (options.identity
    ? Object.fromEntries(Object.keys(LINUX_IDENTITIES).map((role) => [role, { ...options.identity, name: LINUX_IDENTITIES[role].name }]))
    : await ensureLinuxIdentities(runner, stateRoot))
  const identity = identities.supervisor
  for (const path of [stateRoot, logRoot, backupRoot]) {
    await mkdir(path, { recursive: true, mode: 0o700 })
    await chmod(path, path === stateRoot ? 0o711 : 0o700)
    await chown(path, identity.uid, identity.gid)
  }
  await chmod(configPath, 0o640)
  await chown(configPath, options.rootUid ?? 0, identity.gid)
  await chmod(secretsPath, 0o600)
  await chown(secretsPath, options.rootUid ?? 0, options.rootGid ?? 0)
  await chmod(backupKeyPath, 0o600)
  await chown(backupKeyPath, options.rootUid ?? 0, identity.gid)
  await Promise.all([syncFile(configPath), syncFile(secretsPath), syncFile(backupKeyPath)])
  const privateState = [
    [identities.browser, ['browser']],
    [identities.knowledge, ['knowledge']],
    [identities.agent, ['agents', 'project-vms', 'podman', 'podman/config', 'podman/data']],
    [identities.desktop, ['desktop-agents']],
    [identities.web, ['web']],
    [identities.edge, ['edge', 'edge/config', 'edge/data']],
  ]
  for (const [owner, directories] of privateState) {
    for (const relative of directories) {
      const path = join(stateRoot, relative)
      await mkdir(path, { recursive: true, mode: 0o700 })
      await chmod(path, 0o700)
      await chown(path, owner.uid, owner.gid)
    }
  }
  const workspaceGroup = options.workspaceGroup ?? (options.identity ? identity : {
    gid: Number((await command(runner, 'getent', ['group', 'openlink-workspace'])).trim().split(':')[2]),
  })
  if (!Number.isSafeInteger(workspaceGroup.gid) || workspaceGroup.gid < 0) throw new Error('Unable to resolve the openlink-workspace group')
  const workspaceRoot = join(stateRoot, 'workspaces')
  await mkdir(workspaceRoot, { recursive: true, mode: 0o770 })
  await chmod(workspaceRoot, 0o770)
  await chown(workspaceRoot, identity.uid, workspaceGroup.gid)
  const unitSource = join(releaseRoot, 'systemd/openlink.service')
  const brokerUnitSource = join(releaseRoot, 'systemd/openlink-container-broker.service')
  const projectBrokerUnitSource = join(releaseRoot, 'systemd/openlink-project-container-broker.service')
  const unit = await readFile(unitSource, 'utf8')
  const brokerUnit = await readFile(brokerUnitSource, 'utf8')
  const projectBrokerUnit = await readFile(projectBrokerUnitSource, 'utf8')
  if (!/^ExecStart=\/opt\/openlink\/current\/bin\/openlinkctl run --config \/etc\/openlink\/openlink\.env$/m.test(unit)
    || !/^User=root$/m.test(unit) || !/^CapabilityBoundingSet=CAP_SETUID CAP_SETGID CAP_SETPCAP CAP_NET_BIND_SERVICE$/m.test(unit)) {
    throw new Error('Release systemd unit does not match the production path contract')
  }
  if (!/^ExecStart=\/opt\/openlink\/current\/bin\/openlinkctl container-broker --config \/etc\/openlink\/openlink\.env$/m.test(brokerUnit)
    || !/^User=root$/m.test(brokerUnit) || !/^RestrictAddressFamilies=AF_UNIX$/m.test(brokerUnit)) {
    throw new Error('Release container broker unit does not match the privileged production contract')
  }
  if (!/^ExecStart=\/opt\/openlink\/current\/runtime\/node\/bin\/node \/opt\/openlink\/current\/services\/agent-host\/dist\/src\/project-container-main\.js$/m.test(projectBrokerUnit)
    || !/^User=root$/m.test(projectBrokerUnit) || !/^Group=openlink-agent$/m.test(projectBrokerUnit)
    || !/^RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6$/m.test(projectBrokerUnit)) {
    throw new Error('Release Project Container broker unit does not match the privileged production contract')
  }
  const units = [
    { service: 'openlink-container-broker.service', source: brokerUnitSource, destination: brokerUnitPath },
    { service: 'openlink-project-container-broker.service', source: projectBrokerUnitSource, destination: projectBrokerUnitPath },
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
    const enabledServices = ['openlink-container-broker.service', ...(configuredForContainers ? ['openlink-project-container-broker.service'] : []), 'openlink.service']
    await command(runner, 'systemctl', ['enable', '--now', ...enabledServices], { timeout: 660_000 })
    for (const service of enabledServices) {
      const state = (await command(runner, 'systemctl', ['is-active', service])).trim()
      if (state !== 'active') throw new Error(`${service} entered unexpected state: ${state || '<empty>'}`)
    }
  } catch (error) {
    const rollbackFailures = []
    await command(runner, 'systemctl', ['disable', '--now', 'openlink.service', 'openlink-project-container-broker.service', 'openlink-container-broker.service'], { timeout: 240_000 }).catch((failure) => rollbackFailures.push(failure))
    for (const item of units) await atomicRestoreFile(item.destination, item.snapshot).catch((failure) => rollbackFailures.push(failure))
    await command(runner, 'systemctl', ['daemon-reload']).catch((failure) => rollbackFailures.push(failure))
    for (const item of units) {
      if (item.wasEnabled) await command(runner, 'systemctl', ['enable', item.service]).catch((failure) => rollbackFailures.push(failure))
      if (item.wasActive) await command(runner, 'systemctl', ['start', item.service], { timeout: 660_000 }).catch((failure) => rollbackFailures.push(failure))
    }
    if (rollbackFailures.length) throw new AggregateError([error, ...rollbackFailures], 'Native service installation failed and rollback was incomplete')
    throw error
  }
  return { manager: 'systemd', service: 'openlink.service', brokerService: 'openlink-container-broker.service', ...(configuredForContainers ? { projectBrokerService: 'openlink-project-container-broker.service' } : {}), unitPath, brokerUnitPath, projectBrokerUnitPath, identity: 'openlink', processIdentities: Object.values(identities).map((item) => item.name), active: true }
}
