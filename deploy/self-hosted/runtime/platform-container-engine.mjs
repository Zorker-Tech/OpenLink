import { execFile as execFileCallback, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { access, chmod, lstat, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)
const PLACEHOLDER_BYTES = 4096
const APPLEHV_MAC_ADDRESS = '5a:94:ef:e4:0c:ee'

function output(result) {
  return typeof result === 'string' ? result : result?.stdout ?? ''
}

export function platformEngineIdentity(stateRoot) {
  const canonicalStateRoot = resolve(stateRoot)
  const installationId = createHash('sha256').update(canonicalStateRoot).digest('hex').slice(0, 12)
  return {
    installationId,
    machineName: `openlink-platform-${installationId}`,
    guestReleaseRoot: `/var/mnt/openlink/${installationId}/release`,
    guestStateRoot: `/var/mnt/openlink/${installationId}/state`,
  }
}

function inspectRecord(raw) {
  const parsed = JSON.parse(raw)
  return Array.isArray(parsed) ? parsed[0] : parsed
}

function machineDisk(record) {
  return record?.ImagePath?.Path ?? record?.ImagePath ?? record?.Image?.Path
}

function mountMatches(record, source, target) {
  return (record?.Mounts ?? []).some((mount) => resolve(mount.Source) === resolve(source) && mount.Target === target && mount.Type === 'virtiofs')
}

function processRunning(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

async function closeServer(server) {
  if (!server) return
  await new Promise((resolveClose) => server.close(() => resolveClose()))
}

function sshArgs(config) {
  const ssh = config.SSH ?? config.SSHConfig
  return ['-p', String(ssh.Port), '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', '-o', 'ConnectTimeout=3', '-i', ssh.IdentityPath]
}

export async function reusableAppleHvProcessSet(previous, apiSocket, config, runner) {
  if (!previous || !processRunning(previous.vfkitPid) || !processRunning(previous.gvproxyPid)) return false
  if (!await access(apiSocket).then(() => true).catch(() => false)) return false
  try {
    await runner('/usr/bin/ssh', [...sshArgs(config), 'root@127.0.0.1', 'true'], { timeout: 5_000 })
    return true
  } catch {
    return false
  }
}

async function startDirectAppleHv({ config, identity, stateRoot, helperRoot, runner }) {
  const processRoot = resolve(stateRoot, 'platform-engine')
  const socketRoot = resolve('/tmp', `openlink-platform-${typeof process.getuid === 'function' ? process.getuid() : 'user'}`, identity.installationId)
  const statePath = resolve(processRoot, 'processes.json')
  const apiSocket = resolve(socketRoot, 'podman-api.sock')
  const previous = await readFile(statePath, 'utf8').then(JSON.parse).catch(() => undefined)
  if (await reusableAppleHvProcessSet(previous, apiSocket, config, runner)) {
    return { apiSocket, reused: true }
  }
  if (previous) {
    if (processRunning(previous.vfkitPid)) process.kill(previous.vfkitPid, 'SIGTERM')
    if (processRunning(previous.gvproxyPid)) process.kill(previous.gvproxyPid, 'SIGTERM')
  }
  await Promise.all([mkdir(processRoot, { recursive: true, mode: 0o700 }), mkdir(socketRoot, { recursive: true, mode: 0o700 })])
  const networkSocket = resolve(socketRoot, 'gvproxy.sock')
  const readySocket = resolve(socketRoot, 'ready.sock')
  const serialLog = resolve(processRoot, 'serial.log')
  const gvproxyLog = resolve(processRoot, 'gvproxy.log')
  const vfkitLog = resolve(processRoot, 'vfkit.log')
  await Promise.all([networkSocket, readySocket, apiSocket].map((path) => rm(path, { force: true })))
  const ssh = config.SSH ?? config.SSHConfig
  const gvproxy = spawn(resolve(helperRoot, 'gvproxy'), [
    '-mtu', '1500', '-ssh-port', String(ssh.Port), '-listen-vfkit', `unixgram://${networkSocket}`,
    '-forward-user', 'root', '-forward-identity', ssh.IdentityPath, '-forward-sock', apiSocket,
    '-forward-dest', '/run/podman/podman.sock', '-pid-file', resolve(processRoot, 'gvproxy.pid'), '-log-file', gvproxyLog,
  ], { detached: true, stdio: 'ignore', shell: false })
  if (!gvproxy.pid) throw new Error('Unable to launch the bundled AppleHV network helper')
  gvproxy.unref()
  let readyServer
  let vfkit
  try {
    const networkDeadline = Date.now() + 10_000
    while (Date.now() < networkDeadline && !await access(networkSocket).then(() => true).catch(() => false)) {
      if (!processRunning(gvproxy.pid)) throw new Error('AppleHV network helper exited before becoming ready')
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
    }
    readyServer = createServer((socket) => socket.resume())
    readyServer.unref()
    await new Promise((resolveListen, rejectListen) => { readyServer.once('error', rejectListen); readyServer.listen(readySocket, resolveListen) })
    const vfkitConfig = config.AppleHypervisor.Vfkit
    const args = [
      '--cpus', String(config.Resources.CPUs), '--memory', String(config.Resources.Memory),
      '--bootloader', `efi,variable-store=${vfkitConfig.VirtualMachine.bootloader.efiVariableStorePath},create`,
      '--device', `virtio-blk,path=${config.ImagePath.Path}`, '--device', 'virtio-rng',
      '--device', `virtio-serial,logFilePath=${serialLog}`,
      '--device', `virtio-vsock,port=1025,socketURL=${readySocket},listen`,
      '--device', `virtio-net,unixSocketPath=${networkSocket},mac=${APPLEHV_MAC_ADDRESS}`,
      '--timesync', 'vsockPort=1234', '--restful-uri', vfkitConfig.Endpoint.replace(/^http:/, 'tcp:'),
      '--pidfile', resolve(processRoot, 'vfkit.pid'),
    ]
    for (const mount of config.Mounts ?? []) args.push('--device', `virtio-fs,sharedDir=${mount.Source},mountTag=${mount.Tag}`)
    const firstBootMarker = resolve(processRoot, 'first-boot-complete')
    if (!await access(firstBootMarker).then(() => true).catch(() => false)) {
      args.push('--ignition', resolve(config.ConfigDir?.Path ?? dirname(config.ImagePath.Path), `${identity.machineName}.ign`))
    }
    const vfkitLogHandle = await open(vfkitLog, 'a', 0o600)
    try {
      vfkit = spawn(resolve(helperRoot, 'vfkit'), args, {
        detached: true,
        stdio: ['ignore', vfkitLogHandle.fd, vfkitLogHandle.fd],
        shell: false,
      })
    } finally {
      await vfkitLogHandle.close()
    }
    if (!vfkit.pid) throw new Error('Unable to launch the bundled Apple Hypervisor runtime')
    vfkit.unref()
    await writeFile(statePath, `${JSON.stringify({ machineName: identity.machineName, vfkitPid: vfkit.pid, gvproxyPid: gvproxy.pid })}\n`, { mode: 0o600 })
    const deadline = Date.now() + 180_000
    let ready = false
    while (Date.now() < deadline) {
      if (!processRunning(vfkit.pid)) {
        const diagnostic = await readFile(vfkitLog, 'utf8')
          .then((value) => value.trim().split('\n').slice(-8).join('\n'))
          .catch(() => '')
        throw new Error(`AppleHV VM exited before SSH became ready${diagnostic ? `:\n${diagnostic}` : ''}`)
      }
      try {
        await runner('/usr/bin/ssh', [...sshArgs(config), 'root@127.0.0.1', 'true'], { timeout: 10_000 })
        ready = true
        break
      } catch { await new Promise((resolveDelay) => setTimeout(resolveDelay, 1000)) }
    }
    if (!ready) throw new Error('AppleHV platform VM did not become ready within 180 seconds')
    await writeFile(firstBootMarker, `${new Date().toISOString()}\n`, { mode: 0o600 })
    await closeServer(readyServer)
    return { apiSocket, reused: false }
  } catch (error) {
    await closeServer(readyServer).catch(() => undefined)
    if (vfkit?.pid && processRunning(vfkit.pid)) process.kill(vfkit.pid, 'SIGTERM')
    if (processRunning(gvproxy.pid)) process.kill(gvproxy.pid, 'SIGTERM')
    await rm(statePath, { force: true })
    throw error
  }
}

async function cloneCowDisk(source, destination, runner) {
  const sourcePath = resolve(source)
  const destinationPath = resolve(destination)
  const [sourceStat, destinationStat] = await Promise.all([lstat(sourcePath), lstat(destinationPath)])
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.size <= 0) throw new Error('OpenLink platform Golden Disk is invalid')
  if (!destinationStat.isFile() || destinationStat.isSymbolicLink()) throw new Error('Podman platform disk placeholder is invalid')
  if (sourceStat.dev !== destinationStat.dev) throw new Error('Platform state and release must be on the same copy-on-write filesystem')
  const staging = resolve(dirname(destinationPath), `.${basename(destinationPath)}.clone-${process.pid}-${randomUUID()}`)
  try {
    await runner('/bin/cp', ['-c', sourcePath, staging], { timeout: 600_000 })
    await chmod(staging, 0o600)
    const cloneStat = await lstat(staging)
    if (!cloneStat.isFile() || cloneStat.size !== sourceStat.size) throw new Error('OpenLink platform CoW clone is incomplete')
    await rename(staging, destinationPath)
  } finally {
    await rm(staging, { force: true }).catch(() => undefined)
  }
}

/**
 * Reconcile the per-installation AppleHV container engine from sealed local
 * artifacts. Nothing here relies on a checkout name, a pre-created VM, the
 * user's global Podman state, or a network image pull.
 */
export async function ensureMacPlatformContainerEngine(options) {
  const env = options.env ?? process.env
  const runner = options.execFile ?? execFile
  const releaseRoot = resolve(options.releaseRoot)
  const stateRoot = resolve(options.stateRoot)
  const baseDisk = resolve(options.baseDisk)
  const podman = resolve(options.podman)
  const identity = platformEngineIdentity(stateRoot)
  const connection = `${identity.machineName}-root`
  const commandEnvironment = {
    ...env,
    CONTAINERS_MACHINE_PROVIDER: 'applehv',
    CONTAINER_CONNECTION: connection,
  }
  const configRoot = resolve(options.configRoot ?? resolve(stateRoot, 'podman/config'))
  const dataRoot = resolve(options.dataRoot ?? resolve(stateRoot, 'podman/data'))
  const containersRoot = resolve(configRoot, 'containers')
  const helperRoot = resolve(options.helperRoot ?? dirname(podman))
  Object.assign(commandEnvironment, {
    XDG_CONFIG_HOME: configRoot,
    XDG_DATA_HOME: dataRoot,
    CONTAINERS_HELPER_BINARY_DIR: helperRoot,
    CONTAINERS_CONF: resolve(containersRoot, 'containers.conf'),
    CONTAINERS_POLICY: resolve(containersRoot, 'policy.json'),
    PODMAN_CONNECTIONS_CONF: resolve(containersRoot, 'podman-connections.json'),
    PATH: `${helperRoot}:${commandEnvironment.PATH ?? ''}`,
  })
  await Promise.all([
    mkdir(stateRoot, { recursive: true, mode: 0o700 }),
    mkdir(dataRoot, { recursive: true, mode: 0o700 }),
    mkdir(containersRoot, { recursive: true, mode: 0o700 }),
  ])
  await writeFile(commandEnvironment.CONTAINERS_CONF, `[engine]\nhelper_binaries_dir = ["${helperRoot.replaceAll('\\', '/')}"]\n[machine]\nvolumes = []\n`, { mode: 0o600 })
  await writeFile(commandEnvironment.CONTAINERS_POLICY, '{"default":[{"type":"insecureAcceptAnything"}]}\n', { mode: 0o600 })

  let inspection
  try {
    inspection = inspectRecord(output(await runner(podman, ['machine', 'inspect', identity.machineName], { env: commandEnvironment, timeout: 30_000 })))
  } catch (error) {
    if (!/not found|no such machine|does not exist/i.test(String(error?.message ?? error))) throw error
  }

  const enrichInspection = async (record) => {
    if (!record) return record
    if (record.Mounts && record.ImagePath) return record
    const configPath = resolve(configRoot, 'containers/podman/machine/applehv', `${identity.machineName}.json`)
    const durable = JSON.parse(await readFile(configPath, 'utf8'))
    return { ...durable, ...record, Mounts: record.Mounts ?? durable.Mounts, ImagePath: record.ImagePath ?? durable.ImagePath }
  }
  inspection = await enrichInspection(inspection)

  if (!inspection) {
    const temporaryRoot = await mkdtemp(resolve(tmpdir(), 'openlink-platform-init-'))
    const placeholder = resolve(temporaryRoot, 'placeholder.raw')
    try {
      await writeFile(placeholder, Buffer.alloc(PLACEHOLDER_BYTES), { flag: 'wx', mode: 0o600 })
      await runner(podman, [
        'machine', 'init', '--image', placeholder, '--rootful',
        '--cpus', String(options.cpus ?? 4),
        '--memory', String(options.memoryMb ?? 6144),
        '--disk-size', String(options.diskGb ?? 64),
        '--volume', `${releaseRoot}:${identity.guestReleaseRoot}`,
        '--volume', `${stateRoot}:${identity.guestStateRoot}`,
        identity.machineName,
      ], { env: commandEnvironment, timeout: 240_000 })
      inspection = await enrichInspection(inspectRecord(output(await runner(podman, ['machine', 'inspect', identity.machineName], { env: commandEnvironment, timeout: 30_000 }))))
      const destination = machineDisk(inspection)
        ?? resolve(dataRoot, 'containers/podman/machine/applehv', `${identity.machineName}-${process.arch}.raw`)
      if (!destination) throw new Error('Podman did not expose the generated platform disk path')
      await cloneCowDisk(baseDisk, destination, runner)
    } catch (error) {
      await runner(podman, ['machine', 'rm', '--force', identity.machineName], { env: commandEnvironment, timeout: 120_000 }).catch(() => undefined)
      throw error
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  if (!mountMatches(inspection, releaseRoot, identity.guestReleaseRoot) || !mountMatches(inspection, stateRoot, identity.guestStateRoot)) {
    throw new Error(`Platform engine ${identity.machineName} belongs to this installation but has an obsolete mount contract; remove it with openlinkctl repair-platform-engine before retrying`)
  }

  const directStarter = options.startDirectAppleHv ?? startDirectAppleHv
  const direct = await directStarter({ config: inspection, identity, stateRoot, helperRoot, runner })
  commandEnvironment.CONTAINER_HOST = `unix://${direct.apiSocket}`
  commandEnvironment.DOCKER_HOST = commandEnvironment.CONTAINER_HOST
  delete commandEnvironment.CONTAINER_CONNECTION
  await runner(podman, ['info', '--format', '{{json .Version.Version}}'], { env: commandEnvironment, timeout: 30_000 })

  Object.assign(env, commandEnvironment, {
    OPENLINK_PODMAN_COMMAND: podman,
    OPENLINK_DOCKER_COMMAND: podman,
    CONTAINERS_MACHINE_PROVIDER: 'applehv',
    OPENLINK_ZOKERBASE_STACK_ROOT: `${identity.guestReleaseRoot}/backend/docker`,
    OPENLINK_ZOKERBASE_DB_DATA_SOURCE: 'db-data',
    OPENLINK_ZOKERBASE_STORAGE_SOURCE: 'storage-data',
    OPENLINK_ZERO_GUEST_DATA_ROOT: `${identity.guestStateRoot}/knowledge/zero`,
    OPENLINK_ZERO_ETCD_SOURCE: 'zero-etcd',
    OPENLINK_ZERO_MINIO_SOURCE: 'zero-minio',
    OPENLINK_ZERO_ENGINE_SOURCE: 'zero-engine',
  })
  return { managed: true, ...identity, connection, podman, apiSocket: direct.apiSocket }
}
