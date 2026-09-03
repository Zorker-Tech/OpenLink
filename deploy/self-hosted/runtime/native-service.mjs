import { execFile as execFileCallback } from 'node:child_process'
import { chmod, chown, copyFile, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

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
  await requireGroup(runner, 'docker')
  await requireGroup(runner, 'kvm')
  await command(runner, 'usermod', ['--append', '--groups', 'docker,kvm', 'openlink'])
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
    await rename(staging, destination)
  } finally {
    await rm(staging, { force: true })
  }
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
  const expected = {
    releaseRoot: '/opt/openlink/current',
    configPath: '/etc/openlink/openlink.env',
    stateRoot: '/var/lib/openlink',
    logRoot: '/var/log/openlink',
    backupRoot: '/var/backups/openlink',
    unitPath: '/etc/systemd/system/openlink.service',
  }
  if (!options.allowCustomPaths) {
    for (const [name, value] of Object.entries(expected)) {
      const actual = name === 'releaseRoot' ? resolve(options.installRoot, 'current') : { configPath, stateRoot, logRoot, backupRoot, unitPath }[name]
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
  for (const path of [secretsPath, backupKeyPath]) {
    await chmod(path, 0o600)
    await chown(path, identity.uid, identity.gid)
  }
  const unitSource = join(releaseRoot, 'systemd/openlink.service')
  const unit = await readFile(unitSource, 'utf8')
  if (!/^ExecStart=\/opt\/openlink\/current\/bin\/openlinkctl run --config \/etc\/openlink\/openlink\.env$/m.test(unit)) {
    throw new Error('Release systemd unit does not match the production path contract')
  }
  await atomicInstallFile(unitSource, unitPath, 0o644)
  try {
    await command(runner, 'systemctl', ['daemon-reload'])
    await command(runner, 'systemctl', ['enable', '--now', 'openlink.service'], { timeout: 660_000 })
    const state = (await command(runner, 'systemctl', ['is-active', 'openlink.service'])).trim()
    if (state !== 'active') throw new Error(`OpenLink service entered unexpected state: ${state || '<empty>'}`)
  } catch (error) {
    await command(runner, 'systemctl', ['disable', '--now', 'openlink.service'], { timeout: 240_000 }).catch(() => undefined)
    await rm(unitPath, { force: true })
    await command(runner, 'systemctl', ['daemon-reload']).catch(() => undefined)
    throw error
  }
  return { manager: 'systemd', service: 'openlink.service', unitPath, identity: 'openlink', active: true }
}
