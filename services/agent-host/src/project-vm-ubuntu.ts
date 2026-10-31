import { execFile as execFileCallback } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { promisify } from 'node:util'
import { AgentHostError } from './errors.js'
import {
  shellQuote,
  type ProjectVmCommandResult,
  type ProjectVmDiskMode,
  type ProjectVmMachineDriver,
  type ProjectVmMachineSpec,
} from './project-vm.js'

const execFile = promisify(execFileCallback)
const DEFAULT_START_TIMEOUT_MS = 180_000
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000
const STOP_TIMEOUT_MS = 60_000
const MAX_BUFFER = 16 * 1024 * 1024
const PROJECT_VM_NAME = /^[a-z0-9][a-z0-9-]{0,40}$/
const PUBLIC_KEY = /^ssh-(ed25519|rsa|ecdsa-[a-z0-9-]+) [A-Za-z0-9+/=]+(?: [^\r\n]*)?$/

export interface UbuntuQemuProjectVmDriverOptions {
  /** Immutable, versioned Ubuntu Project VM base qcow2. */
  projectBaseDisk: string
  /** Manifest fingerprint recorded with each project disk. */
  baseFingerprint?: string
  /** Durable per-project QEMU state (disk, SSH identity, seed identity). */
  stateRoot: string
  qemuCommand?: string
  qemuImgCommand?: string
  sshCommand?: string
  scpCommand?: string
  sshKeygenCommand?: string
  guestUser?: string
  /** Run the guest Podman/bootstrap checks after SSH becomes ready. */
  bootstrap?: boolean
  startTimeoutMs?: number
  commandTimeoutMs?: number
  hostPortAvailable?: (port: number) => Promise<boolean>
  /** Injectable process runner used by tests and embedded runtimes. */
  run?: (file: string, args: string[], options?: { timeout?: number; maxBuffer?: number; cwd?: string }) => Promise<{ stdout: string; stderr: string }>
  /** Injectable process liveness probe used by tests. */
  isProcessRunning?: (pid: number) => Promise<boolean>
  /** Override the short QMP socket directory (macOS sockaddr_un limits). */
  socketRoot?: string
}

interface UbuntuProjectVmRecord {
  schemaVersion: 1
  name: string
  cpus: number
  memoryMb: number
  diskGb: number
  diskMode: ProjectVmDiskMode
  servicePorts: number[]
  desktopPort?: number
  sshPort: number
  baseDisk: string
  baseFingerprint: string
  guestUser: string
  createdAt: string
}

interface UbuntuProjectVmSeed {
  schemaVersion: 1
  instanceId: string
  token: string
}

interface QemuImageInfo {
  format?: string
  'virtual-size'?: number
  'full-backing-filename'?: string
  'backing-filename'?: string
}

function shellQuoteArgument(value: string): string {
  return shellQuote(value)
}

function assertPort(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1_024 || (value as number) > 65_000) {
    throw new AgentHostError('INVALID_BODY', `${label} is invalid`)
  }
  return value as number
}

function safeName(value: string): string {
  if (!PROJECT_VM_NAME.test(value)) throw new AgentHostError('INVALID_BODY', 'Ubuntu Project VM name is invalid')
  return value
}

function stateDirectory(stateRoot: string, name: string): string {
  return resolve(stateRoot, 'ubuntu-vms', safeName(name))
}

function stateFile(directory: string, file: string): string {
  return resolve(directory, file)
}

async function atomicWrite(path: string, data: string, mode = 0o600): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}-${randomBytes(6).toString('hex')}.tmp`
  await writeFile(temporary, data, { mode })
  await rename(temporary, path)
}

async function readJson<T>(path: string): Promise<T | undefined> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new AgentHostError('PROVISIONING_FAILED', `Ubuntu Project VM state is unreadable: ${path}`, { retryable: false })
  }
  try {
    return JSON.parse(text) as T
  } catch {
    throw new AgentHostError('PROVISIONING_FAILED', `Ubuntu Project VM state is corrupt: ${path}`, { retryable: false })
  }
}

async function readTail(path: string, bytes = 12_000): Promise<string> {
  try {
    const content = await readFile(path, 'utf8')
    return content.slice(-bytes)
  } catch {
    return ''
  }
}

async function defaultIsProcessRunning(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function defaultHostPortAvailable(port: number): Promise<boolean> {
  return new Promise<boolean>((resolveAvailability) => {
    const server = createNetServer()
    server.unref()
    server.once('error', () => resolveAvailability(false))
    server.listen(port, '127.0.0.1', () => {
      server.close((error) => resolveAvailability(!error))
    })
  })
}

function qemuSocketPath(socketRoot: string, name: string): string {
  const hash = createHash('sha256').update(name).digest('hex').slice(0, 20)
  const path = resolve(socketRoot, `openlink-qemu-${hash}.sock`)
  if (Buffer.byteLength(path) >= 104) {
    throw new AgentHostError('BACKEND_NOT_CONFIGURED', 'Ubuntu Project VM QMP socket path is too long')
  }
  return path
}

export function ubuntuProjectVmSeedDocuments(input: {
  name: string
  instanceId: string
  publicKey: string
  guestUser: string
}): Map<string, string> {
  if (!PUBLIC_KEY.test(input.publicKey.trim())) {
    throw new AgentHostError('INVALID_BODY', 'Ubuntu Project VM public key is invalid')
  }
  const user = input.guestUser
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(user)) {
    throw new AgentHostError('INVALID_BODY', 'Ubuntu Project VM guest user is invalid')
  }
  const userData = `#cloud-config
users:
  - name: ${user}
    sudo: ALL=(ALL) NOPASSWD:ALL
    groups: [sudo, adm]
    shell: /bin/bash
    lock_passwd: true
    ssh_authorized_keys:
      - ${input.publicKey.trim()}
ssh_pwauth: false
disable_root: true
package_update: false
timezone: UTC
runcmd:
  - [ sh, -c, "systemctl enable --now podman.socket >/dev/null 2>&1 || true" ]
`
  const metaData = `instance-id: ${input.instanceId}
local-hostname: ${input.name}
`
  return new Map([
    ['user-data', userData],
    ['meta-data', metaData],
    ['vendor-data', ''],
    ['network-config', 'version: 2\n'],
  ])
}

export interface UbuntuProjectVmQemuArgumentsInput {
  name: string
  diskPath: string
  cpus: number
  memoryMb: number
  sshPort: number
  servicePorts: number[]
  desktopPort?: number
  seedUrl: string
  pidFile: string
  qmpPath: string
  consoleLog: string
}

export function ubuntuProjectVmQemuArguments(input: UbuntuProjectVmQemuArgumentsInput): string[] {
  safeName(input.name)
  if (!Number.isSafeInteger(input.cpus) || input.cpus < 1 || input.cpus > 64) throw new AgentHostError('INVALID_BODY', 'Ubuntu Project VM CPU count is invalid')
  if (!Number.isSafeInteger(input.memoryMb) || input.memoryMb < 512 || input.memoryMb > 262_144) throw new AgentHostError('INVALID_BODY', 'Ubuntu Project VM memory is invalid')
  const sshPort = assertPort(input.sshPort, 'Ubuntu Project VM SSH port')
  const hostForwardPorts = new Set<number>()
  const hostfwd = [`tcp:127.0.0.1:${sshPort}-:22`]
  hostForwardPorts.add(sshPort)
  for (const port of input.servicePorts) {
    const value = assertPort(port, 'Ubuntu Project VM service port')
    if (hostForwardPorts.has(value)) throw new AgentHostError('INVALID_BODY', 'Ubuntu Project VM service ports collide')
    hostForwardPorts.add(value)
    hostfwd.push(`tcp:127.0.0.1:${value}-:${value}`)
  }
  if (input.desktopPort !== undefined) {
    const value = assertPort(input.desktopPort, 'Ubuntu Project VM desktop port')
    if (hostForwardPorts.has(value)) throw new AgentHostError('INVALID_BODY', 'Ubuntu Project VM desktop port collides')
    hostForwardPorts.add(value)
    hostfwd.push(`tcp:127.0.0.1:${value}-:6080`)
  }
  if (!/^http:\/\/10\.0\.2\.2:\d{1,5}\/seed\/[a-f0-9]{32}\/$/.test(input.seedUrl)) {
    throw new AgentHostError('INVALID_BODY', 'Ubuntu Project VM seed URL is invalid')
  }
  return [
    '-name', `openlink-${input.name}`,
    '-machine', 'q35',
    '-accel', 'kvm',
    '-cpu', 'host',
    '-smp', String(input.cpus),
    '-m', String(input.memoryMb),
    '-drive', `file=${input.diskPath},if=virtio,format=qcow2,cache=none`,
    '-netdev', `user,id=net0,${hostfwd.join(',')}`,
    '-device', 'virtio-net-pci,netdev=net0',
    '-smbios', `type=1,serial=ds=nocloud;s=${input.seedUrl}`,
    '-display', 'none',
    '-serial', `file:${input.consoleLog}`,
    '-qmp', `unix:${input.qmpPath},server=on,wait=off`,
    '-pidfile', input.pidFile,
    '-rtc', 'base=utc',
    '-no-reboot',
    '-daemonize',
  ]
}

class UbuntuSeedServer {
  private server?: Server
  private port?: number

  constructor(
    private readonly token: string,
    private readonly documents: Map<string, string>,
  ) {}

  async start(): Promise<number> {
    if (this.server) {
      if (!this.port) throw new Error('Ubuntu seed server has no port')
      return this.port
    }
    const server = createServer((request, response) => {
      const url = new URL(request.url || '/', 'http://127.0.0.1')
      const prefix = `/seed/${this.token}/`
      if (request.method !== 'GET' || !url.pathname.startsWith(prefix)) {
        response.writeHead(404, { 'Cache-Control': 'no-store' })
        response.end()
        return
      }
      const name = url.pathname.slice(prefix.length)
      const value = this.documents.get(name)
      if (value === undefined) {
        response.writeHead(404, { 'Cache-Control': 'no-store' })
        response.end()
        return
      }
      response.writeHead(200, {
        'Cache-Control': 'no-store',
        'Content-Type': name.endsWith('-config') ? 'text/cloud-config' : 'text/plain',
      })
      response.end(value)
    })
    await new Promise<void>((accept, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', accept)
    })
    const address = server.address()
    if (!address || typeof address === 'string') {
      server.close()
      throw new Error('Ubuntu seed server did not bind a loopback port')
    }
    this.server = server
    this.port = address.port
    return address.port
  }

  async close(): Promise<void> {
    const server = this.server
    this.server = undefined
    this.port = undefined
    if (!server?.listening) return
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
  }
}

/**
 * Provider-independent Ubuntu Project VM driver.
 *
 * One project owns one durable QEMU VM. The VM is an Ubuntu LTS guest with a
 * native desktop and rootful Podman; OpenSandbox sessions run inside it. The
 * driver owns only VM lifecycle and transport:
 *
 * - the base disk is immutable and versioned; every project gets a qcow2
 *   overlay whose backing file is recorded in durable state;
 * - a per-project ed25519 identity is generated locally and injected through
 *   a loopback cloud-init seed server (SMBIOS `nocloud`), so no ISO tooling
 *   or shared credential is required on the host;
 * - all guest service endpoints and the desktop are forwarded only to
 *   127.0.0.1, and the Desktop Gateway remains the only browser-facing path.
 *
 * A crash between any two steps is recoverable: the disk, identity and seed
 * identity are durable; the next ensure() adopts the running QEMU process or
 * starts it again from the same disk.
 */
export class UbuntuQemuProjectVmDriver implements ProjectVmMachineDriver {
  private readonly projectBaseDisk: string
  private readonly baseFingerprint: string
  private readonly stateRoot: string
  private readonly qemu: string
  private readonly qemuImg: string
  private readonly ssh: string
  private readonly scp: string
  private readonly sshKeygen: string
  private readonly guestUser: string
  private readonly bootstrap: boolean
  private readonly startTimeoutMs: number
  private readonly commandTimeoutMs: number
  private readonly hostPortAvailable: (port: number) => Promise<boolean>
  private readonly run: NonNullable<UbuntuQemuProjectVmDriverOptions['run']>
  private readonly isProcessRunning: (pid: number) => Promise<boolean>
  private readonly socketRoot: string
  private readonly seedServers = new Map<string, UbuntuSeedServer>()

  constructor(options: UbuntuQemuProjectVmDriverOptions) {
    this.projectBaseDisk = resolve(options.projectBaseDisk)
    this.stateRoot = resolve(options.stateRoot)
    this.qemu = options.qemuCommand?.trim() || 'qemu-system-x86_64'
    this.qemuImg = options.qemuImgCommand?.trim() || 'qemu-img'
    this.ssh = options.sshCommand?.trim() || '/usr/bin/ssh'
    this.scp = options.scpCommand?.trim() || '/usr/bin/scp'
    this.sshKeygen = options.sshKeygenCommand?.trim() || 'ssh-keygen'
    this.guestUser = options.guestUser?.trim() || 'ubuntu'
    if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(this.guestUser)) throw new AgentHostError('INVALID_BODY', 'Ubuntu Project VM guest user is invalid')
    this.bootstrap = options.bootstrap !== false
    this.startTimeoutMs = Math.max(10_000, options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS)
    this.commandTimeoutMs = Math.max(5_000, options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS)
    this.hostPortAvailable = options.hostPortAvailable ?? defaultHostPortAvailable
    this.run = options.run ?? ((file, args, runOptions) => execFile(file, args, {
      timeout: runOptions?.timeout ?? this.commandTimeoutMs,
      maxBuffer: runOptions?.maxBuffer ?? MAX_BUFFER,
      cwd: runOptions?.cwd,
      encoding: 'utf8',
    }))
    this.isProcessRunning = options.isProcessRunning ?? defaultIsProcessRunning
    this.socketRoot = resolve(options.socketRoot || tmpdir())
    this.baseFingerprint = options.baseFingerprint?.trim() || 'unversioned'
  }

  async ensureMachine(name: string, spec: ProjectVmMachineSpec): Promise<void> {
    const directory = stateDirectory(this.stateRoot, name)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const previous = await readJson<UbuntuProjectVmRecord>(stateFile(directory, 'vm.json'))
    const baseDisk = previous?.baseDisk ? resolve(previous.baseDisk) : this.projectBaseDisk
    await this.assertBaseDisk(baseDisk)
    const record = this.normalizeSpec(name, spec, baseDisk, previous)
    if (previous && JSON.stringify({ ...previous, createdAt: '' }) !== JSON.stringify({ ...record, createdAt: '' })) {
      if (await this.isMachineRunning(name)) await this.stopMachine(name)
    }
    await this.ensureIdentity(directory)
    // A missing disk is only creatable for a brand-new project. Once a
    // durable record exists, losing the disk is data loss, not a silent
    // re-provision: fail closed and require an explicit restore/recreate.
    await this.ensureDisk(directory, record, previous === undefined)
    await atomicWrite(stateFile(directory, 'vm.json'), `${JSON.stringify(record)}\n`)
    const seed = await this.ensureSeed(directory, name)
    if (await this.isMachineRunning(name)) {
      if (this.bootstrap) await this.bootstrapToolchain(name)
      return
    }
    await this.startMachine(directory, record, seed)
    if (this.bootstrap) await this.bootstrapToolchain(name)
  }

  async bootstrapToolchain(name: string): Promise<void> {
    await this.runInMachine(name, 'sh', ['-lc', [
      'set -eu',
      'sudo -n true',
      'if command -v systemctl >/dev/null 2>&1; then sudo -n systemctl enable --now podman.socket >/dev/null 2>&1 || true; fi',
      'sudo -n podman version >/dev/null',
    ].join('\n')])
  }

  async runInMachine(name: string, command: string, args: string[] = []): Promise<ProjectVmCommandResult> {
    const directory = stateDirectory(this.stateRoot, name)
    const record = await this.requireRecord(directory)
    const commandLine = [command, ...args].map(shellQuoteArgument).join(' ')
    try {
      const result = await this.run(this.ssh, this.sshArgs(record, [commandLine]), {
        timeout: this.commandTimeoutMs,
        maxBuffer: MAX_BUFFER,
      })
      return { stdout: result.stdout, stderr: result.stderr }
    } catch (error) {
      throw new AgentHostError(
        'PROJECT_BACKEND_UNAVAILABLE',
        `Ubuntu Project VM ${name} command failed: ${error instanceof Error ? error.message : String(error)}`,
        { retryable: true },
      )
    }
  }

  async copyToMachine(name: string, sourcePath: string, destinationPath: string): Promise<void> {
    const directory = stateDirectory(this.stateRoot, name)
    const record = await this.requireRecord(directory)
    try {
      await this.run(this.scp, [
        '-i', stateFile(directory, 'id_ed25519'),
        '-P', String(record.sshPort),
        '-o', 'BatchMode=yes',
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'UserKnownHostsFile=/dev/null',
        '-o', 'ConnectTimeout=10',
        sourcePath,
        `${record.guestUser}@127.0.0.1:${destinationPath}`,
      ], { timeout: 15 * 60_000, maxBuffer: MAX_BUFFER })
    } catch (error) {
      throw new AgentHostError(
        'PROJECT_BACKEND_UNAVAILABLE',
        `Ubuntu Project VM ${name} copy failed: ${error instanceof Error ? error.message : String(error)}`,
        { retryable: true },
      )
    }
  }

  async isMachineRunning(name: string): Promise<boolean> {
    const directory = stateDirectory(this.stateRoot, name)
    const pid = await this.readPid(stateFile(directory, 'qemu.pid'))
    if (pid === undefined) return false
    if (!await this.isProcessRunning(pid)) {
      await rm(stateFile(directory, 'qemu.pid'), { force: true }).catch(() => undefined)
      return false
    }
    return true
  }

  async stopMachine(name: string): Promise<void> {
    const directory = stateDirectory(this.stateRoot, name)
    const record = await readJson<UbuntuProjectVmRecord>(stateFile(directory, 'vm.json')).catch(() => undefined)
    const pid = await this.readPid(stateFile(directory, 'qemu.pid'))
    if (record && pid !== undefined && await this.isProcessRunning(pid)) {
      await this.run(this.ssh, this.sshArgs(record, ['sudo -n poweroff']), { timeout: 15_000 }).catch(() => undefined)
      const deadline = Date.now() + STOP_TIMEOUT_MS
      while (Date.now() < deadline && await this.isProcessRunning(pid)) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 500))
      }
      if (await this.isProcessRunning(pid)) {
        try { process.kill(pid, 'SIGTERM') } catch {}
        const termDeadline = Date.now() + 10_000
        while (Date.now() < termDeadline && await this.isProcessRunning(pid)) {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 250))
        }
      }
      if (await this.isProcessRunning(pid)) {
        try { process.kill(pid, 'SIGKILL') } catch {}
      }
    }
    await this.seedServers.get(name)?.close()
    this.seedServers.delete(name)
    await rm(stateFile(directory, 'qemu.pid'), { force: true }).catch(() => undefined)
    await rm(stateFile(directory, 'qmp.sock'), { force: true }).catch(() => undefined)
  }

  async removeMachine(name: string): Promise<void> {
    await this.stopMachine(name)
    await rm(stateDirectory(this.stateRoot, name), { recursive: true, force: true })
  }

  private normalizeSpec(name: string, spec: ProjectVmMachineSpec, baseDisk: string, previous?: UbuntuProjectVmRecord): UbuntuProjectVmRecord {
    safeName(name)
    if (!Number.isSafeInteger(spec.cpus) || spec.cpus < 1 || spec.cpus > 64) throw new AgentHostError('INVALID_BODY', 'Ubuntu Project VM CPU count is invalid')
    if (!Number.isSafeInteger(spec.memoryMb) || spec.memoryMb < 512 || spec.memoryMb > 262_144) throw new AgentHostError('INVALID_BODY', 'Ubuntu Project VM memory is invalid')
    if (!Number.isSafeInteger(spec.diskGb) || spec.diskGb < 10 || spec.diskGb > 4_096) throw new AgentHostError('INVALID_BODY', 'Ubuntu Project VM disk size is invalid')
    if (spec.diskMode !== 'thin' && spec.diskMode !== 'thick') throw new AgentHostError('INVALID_BODY', 'Ubuntu Project VM disk mode is invalid')
    const sshPort = assertPort(spec.sshPort, 'Ubuntu Project VM SSH port')
    const servicePorts = [...(spec.servicePorts ?? [])]
    if (servicePorts.length !== 6) throw new AgentHostError('INVALID_BODY', 'Ubuntu Project VM requires six local service ports')
    for (const port of servicePorts) assertPort(port, 'Ubuntu Project VM service port')
    const desktopPort = spec.desktopPort === undefined ? previous?.desktopPort : assertPort(spec.desktopPort, 'Ubuntu Project VM desktop port')
    return {
      schemaVersion: 1,
      name,
      cpus: spec.cpus,
      memoryMb: spec.memoryMb,
      diskGb: spec.diskGb,
      diskMode: spec.diskMode,
      servicePorts,
      ...(desktopPort !== undefined ? { desktopPort } : {}),
      sshPort,
      baseDisk,
      baseFingerprint: previous?.baseFingerprint || this.baseFingerprint,
      guestUser: this.guestUser,
      createdAt: previous?.createdAt || new Date().toISOString(),
    }
  }

  private async assertBaseDisk(path: string): Promise<void> {
    let metadata
    try {
      metadata = await lstat(path)
    } catch {
      throw new AgentHostError('BACKEND_NOT_CONFIGURED', `Ubuntu Project VM base disk is missing: ${path}`)
    }
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0) {
      throw new AgentHostError('BACKEND_NOT_CONFIGURED', `Ubuntu Project VM base disk is invalid: ${path}`)
    }
  }

  private async requireRecord(directory: string): Promise<UbuntuProjectVmRecord> {
    const record = await readJson<UbuntuProjectVmRecord>(stateFile(directory, 'vm.json'))
    if (!record || record.schemaVersion !== 1) throw new AgentHostError('INVALID_SESSION', 'Ubuntu Project VM state is missing or invalid', { retryable: true })
    return record
  }

  private async ensureIdentity(directory: string): Promise<void> {
    const privateKey = stateFile(directory, 'id_ed25519')
    const publicKey = `${privateKey}.pub`
    const [privateExists, publicExists] = await Promise.all([
      lstat(privateKey).then(() => true).catch(() => false),
      lstat(publicKey).then(() => true).catch(() => false),
    ])
    if (privateExists !== publicExists) {
      throw new AgentHostError('PROVISIONING_FAILED', 'Ubuntu Project VM SSH identity is incomplete', { retryable: false })
    }
    if (privateExists) return
    try {
      await this.run(this.sshKeygen, ['-q', '-t', 'ed25519', '-N', '', '-C', `openlink-project-${randomUUID()}`, '-f', privateKey], { timeout: 30_000 })
      await chmod(privateKey, 0o600)
    } catch (error) {
      await rm(privateKey, { force: true }).catch(() => undefined)
      await rm(publicKey, { force: true }).catch(() => undefined)
      throw new AgentHostError('PROVISIONING_FAILED', `Ubuntu Project VM SSH identity generation failed: ${error instanceof Error ? error.message : String(error)}`, { retryable: true })
    }
  }

  private async ensureDisk(directory: string, record: UbuntuProjectVmRecord, allowCreate: boolean): Promise<void> {
    const disk = stateFile(directory, 'disk.qcow2')
    const exists = await lstat(disk).then((metadata) => metadata.isFile()).catch(() => false)
    if (!exists && !allowCreate) {
      throw new AgentHostError(
        'PROVISIONING_FAILED',
        `Ubuntu Project VM disk is missing: ${disk}. Restore the project VM state from backup, or remove ${directory} and the project runtime record to recreate it.`,
        { retryable: false },
      )
    }
    if (!exists) {
      try {
        if (record.diskMode === 'thick') {
          // A thick T1 disk is an independent qcow2 copy, not a thin backing
          // overlay. It still only stores allocated blocks, but it no longer
          // depends on the versioned base artifact.
          await this.run(this.qemuImg, ['convert', '-O', 'qcow2', record.baseDisk, disk], { timeout: 30 * 60_000 })
          await this.run(this.qemuImg, ['resize', disk, `${record.diskGb}G`], { timeout: 60_000 })
        } else {
          await this.run(this.qemuImg, ['create', '-f', 'qcow2', '-F', 'qcow2', '-b', record.baseDisk, disk, `${record.diskGb}G`], { timeout: 60_000 })
        }
      } catch (error) {
        await rm(disk, { force: true }).catch(() => undefined)
        throw new AgentHostError('PROVISIONING_FAILED', `Ubuntu Project VM disk creation failed: ${error instanceof Error ? error.message : String(error)}`, { retryable: true })
      }
    }
    const info = await this.qemuInfo(disk)
    const backing = info['full-backing-filename'] || info['backing-filename']
    if (info.format !== 'qcow2') {
      throw new AgentHostError('PROVISIONING_FAILED', `Ubuntu Project VM disk is not qcow2: ${disk}`, { retryable: false })
    }
    if (record.diskMode === 'thin' && (!backing || resolve(backing) !== resolve(record.baseDisk))) {
      throw new AgentHostError('PROVISIONING_FAILED', `Ubuntu Project VM thin disk does not reference the expected base disk: ${disk}`, { retryable: false })
    }
    if (record.diskMode === 'thick' && backing) {
      throw new AgentHostError('PROVISIONING_FAILED', `Ubuntu Project VM thick disk must not have a backing file: ${disk}`, { retryable: false })
    }
    const expectedVirtualSize = record.diskGb * 1024 * 1024 * 1024
    if (typeof info['virtual-size'] !== 'number' || info['virtual-size'] < expectedVirtualSize) {
      await this.run(this.qemuImg, ['resize', disk, `${record.diskGb}G`], { timeout: 60_000 })
    }
    await chmod(disk, 0o600)
  }

  private async qemuInfo(path: string): Promise<QemuImageInfo> {
    try {
      const result = await this.run(this.qemuImg, ['info', '--output=json', path], { timeout: 30_000 })
      return JSON.parse(result.stdout) as QemuImageInfo
    } catch (error) {
      throw new AgentHostError('PROVISIONING_FAILED', `Ubuntu Project VM disk metadata is unreadable: ${error instanceof Error ? error.message : String(error)}`, { retryable: true })
    }
  }

  private async ensureSeed(directory: string, name: string): Promise<UbuntuProjectVmSeed> {
    const path = stateFile(directory, 'seed.json')
    const existing = await readJson<UbuntuProjectVmSeed>(path)
    if (existing && existing.schemaVersion === 1
      && typeof existing.instanceId === 'string' && existing.instanceId.length > 0
      && /^[a-f0-9]{32}$/.test(existing.token)) return existing
    const seed: UbuntuProjectVmSeed = {
      schemaVersion: 1,
      instanceId: `${name}-${randomUUID()}`,
      token: randomBytes(16).toString('hex'),
    }
    await atomicWrite(path, `${JSON.stringify(seed)}\n`)
    return seed
  }

  private async startMachine(directory: string, record: UbuntuProjectVmRecord, seed: UbuntuProjectVmSeed): Promise<void> {
    const disk = stateFile(directory, 'disk.qcow2')
    await this.assertPorts(record)
    const publicKey = (await readFile(stateFile(directory, 'id_ed25519.pub'), 'utf8')).trim()
    const documents = ubuntuProjectVmSeedDocuments({
      name: record.name,
      instanceId: seed.instanceId,
      publicKey,
      guestUser: record.guestUser,
    })
    const seedServer = new UbuntuSeedServer(seed.token, documents)
    this.seedServers.get(record.name)?.close().catch(() => undefined)
    this.seedServers.set(record.name, seedServer)
    let port: number
    try {
      port = await seedServer.start()
    } catch (error) {
      this.seedServers.delete(record.name)
      throw new AgentHostError('PROVISIONING_FAILED', `Ubuntu Project VM seed server failed: ${error instanceof Error ? error.message : String(error)}`, { retryable: true })
    }
    const qmpPath = qemuSocketPath(this.socketRoot, record.name)
    const pidFile = stateFile(directory, 'qemu.pid')
    const consoleLog = stateFile(directory, 'console.log')
    await rm(pidFile, { force: true }).catch(() => undefined)
    await rm(qmpPath, { force: true }).catch(() => undefined)
    const seedUrl = `http://10.0.2.2:${port}/seed/${seed.token}/`
    const args = ubuntuProjectVmQemuArguments({
      name: record.name,
      diskPath: disk,
      cpus: record.cpus,
      memoryMb: record.memoryMb,
      sshPort: record.sshPort,
      servicePorts: record.servicePorts,
      ...(record.desktopPort !== undefined ? { desktopPort: record.desktopPort } : {}),
      seedUrl,
      pidFile,
      qmpPath,
      consoleLog,
    })
    try {
      await this.run(this.qemu, args, { timeout: 120_000, maxBuffer: MAX_BUFFER, cwd: directory })
    } catch (error) {
      await seedServer.close()
      this.seedServers.delete(record.name)
      const tail = await readTail(consoleLog)
      throw new AgentHostError(
        'PROVISIONING_FAILED',
        `Ubuntu Project VM ${record.name} failed to start: ${error instanceof Error ? error.message : String(error)}${tail ? `; console: ${tail.slice(-4_000)}` : ''}`,
        { retryable: true },
      )
    }
    try {
      await this.waitForPid(record.name, pidFile)
      await this.waitForSsh(record.name, directory, record)
    } catch (error) {
      await seedServer.close()
      this.seedServers.delete(record.name)
      await this.forceStop(pidFile).catch(() => undefined)
      throw error
    }
    await seedServer.close()
    this.seedServers.delete(record.name)
  }

  private async waitForPid(name: string, pidFile: string): Promise<void> {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      if (await this.isMachineRunning(name)) return
      if (await lstat(pidFile).then(() => true).catch(() => false)) {
        // QEMU wrote a pid but the process is gone: fail before waiting for
        // the full SSH budget so a crash loop stays fast and observable.
        if (!await this.isProcessRunning(Number((await readFile(pidFile, 'utf8').catch(() => '0')).trim()))) {
          throw new AgentHostError('PROVISIONING_FAILED', `Ubuntu Project VM ${name} exited immediately after start`, { retryable: true })
        }
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
    }
    throw new AgentHostError('PROVISIONING_FAILED', `Ubuntu Project VM ${name} did not publish its QEMU pid`, { retryable: true })
  }

  private async assertPorts(record: UbuntuProjectVmRecord): Promise<void> {
    const ports = [record.sshPort, ...record.servicePorts, ...(record.desktopPort !== undefined ? [record.desktopPort] : [])]
    for (const port of ports) {
      if (!await this.hostPortAvailable(port)) {
        throw new AgentHostError('PROVISIONING_FAILED', `Ubuntu Project VM host port ${port} is already in use`, { retryable: true })
      }
    }
  }

  private async waitForSsh(name: string, directory: string, record: UbuntuProjectVmRecord): Promise<void> {
    const deadline = Date.now() + this.startTimeoutMs
    let lastError: unknown
    while (Date.now() < deadline) {
      if (!await this.isMachineRunning(name)) {
        throw new AgentHostError('PROVISIONING_FAILED', `Ubuntu Project VM ${name} exited during boot`, { retryable: true })
      }
      try {
        await this.run(this.ssh, this.sshArgs(record, ['true'], 3), { timeout: 10_000, maxBuffer: MAX_BUFFER })
        return
      } catch (error) {
        lastError = error
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000))
    }
    const tail = await readTail(stateFile(directory, 'console.log'))
    throw new AgentHostError(
      'PROVISIONING_FAILED',
      `Ubuntu Project VM ${name} did not become reachable: ${lastError instanceof Error ? lastError.message : String(lastError)}${tail ? `; console: ${tail.slice(-4_000)}` : ''}`,
      { retryable: true },
    )
  }

  private sshArgs(record: UbuntuProjectVmRecord, command: string[], connectTimeoutSeconds = 10): string[] {
    const directory = stateDirectory(this.stateRoot, record.name)
    return [
      '-i', stateFile(directory, 'id_ed25519'),
      '-p', String(record.sshPort),
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'UserKnownHostsFile=/dev/null',
      '-o', `ConnectTimeout=${connectTimeoutSeconds}`,
      `${record.guestUser}@127.0.0.1`,
      command.map(shellQuoteArgument).join(' '),
    ]
  }

  private async readPid(path: string): Promise<number | undefined> {
    try {
      const value = Number((await readFile(path, 'utf8')).trim())
      return Number.isSafeInteger(value) && value > 1 ? value : undefined
    } catch {
      return undefined
    }
  }

  private async forceStop(pidFile: string): Promise<void> {
    const pid = await this.readPid(pidFile)
    if (pid === undefined) return
    for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
      try { process.kill(pid, signal) } catch { return }
      const deadline = Date.now() + (signal === 'SIGTERM' ? 10_000 : 2_000)
      while (Date.now() < deadline && await this.isProcessRunning(pid)) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 250))
      }
      if (!await this.isProcessRunning(pid)) return
    }
  }
}
