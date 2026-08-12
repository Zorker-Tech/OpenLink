import { basename } from 'node:path'
import { AgentHostError } from './errors.js'
import type { SshRemoteCommandResult, SshTransport } from './ssh.js'
import type {
  ProjectVmCommandResult,
  ProjectVmMachineDriver,
  ProjectVmMachineSpec,
  ProjectVmPortForward,
} from './project-vm.js'

export interface RemoteQemuProjectVmDriverOptions {
  transport: SshTransport
  remoteRoot: string
  releaseDirectory: string
  podmanBinaryPath: string
  podmanSha256: string
  baseImageUrl: string
  baseImageSha256: string
  /** Optional proxy reachable from the SSH target for VM bootstrap downloads. */
  httpProxy?: string
  httpsProxy?: string
}

function safeAbsolutePath(value: string, label: string): string {
  if (!value || !value.startsWith('/') || value.includes('..') || /[\u0000\r\n]/.test(value)) {
    throw new AgentHostError('INVALID_TARGET', label + ' is invalid')
  }
  return value
}

function safeImageDigest(value: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new AgentHostError('INVALID_TARGET', 'Project VM base image digest is invalid')
  return value
}

function safeImageUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new AgentHostError('INVALID_TARGET', 'Project VM base image URL is invalid')
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hostname !== 'cloud-images.ubuntu.com') {
    throw new AgentHostError('INVALID_TARGET', 'Project VM base image URL must be a pinned Ubuntu cloud image')
  }
  return url.toString()
}

function safeProxy(value: string | undefined, label: string): string | undefined {
  if (!value?.trim()) return undefined
  let url: URL
  try { url = new URL(value) } catch { throw new AgentHostError('INVALID_TARGET', `${label} is invalid`) }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || /[\r\n\u0000"]/.test(value)) {
    throw new AgentHostError('INVALID_TARGET', `${label} is invalid`)
  }
  return url.toString()
}

function safeMachine(value: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(value)) throw new AgentHostError('INVALID_TARGET', 'Project VM machine name is invalid')
  return value
}

function safeCommand(value: string): string {
  if (!/^[A-Za-z0-9._/+:-]+$/.test(value)) throw new AgentHostError('INVALID_BODY', 'Project VM command is invalid')
  return value
}

function safeArgument(value: string): string {
  if (/[\u0000\r\n]/.test(value)) throw new AgentHostError('INVALID_BODY', 'Project VM argument contains control characters')
  return value
}

function normalizeResult(result: SshRemoteCommandResult): ProjectVmCommandResult {
  return { stdout: result.stdout, stderr: result.stderr }
}

/**
 * Remote Linux Project VM driver.
 *
 * The SSH target only runs this small QEMU lifecycle helper. OpenSandbox,
 * Browser Host, Podman and all session workloads are started in the guest.
 * The driver never delegates a Project runtime to Docker Compose on the host.
 */
export class RemoteQemuProjectVmDriver implements ProjectVmMachineDriver {
  private readonly transport: SshTransport
  private readonly remoteRoot: string
  private readonly releaseDirectory: string
  private readonly podmanBinaryPath: string
  private readonly podmanSha256: string
  private readonly baseImageUrl: string
  private readonly baseImageSha256: string
  private readonly httpProxy?: string
  private readonly httpsProxy?: string

  constructor(options: RemoteQemuProjectVmDriverOptions) {
    this.transport = options.transport
    this.remoteRoot = safeAbsolutePath(options.remoteRoot, 'remoteRoot')
    this.releaseDirectory = safeAbsolutePath(options.releaseDirectory, 'releaseDirectory')
    this.podmanBinaryPath = safeAbsolutePath(options.podmanBinaryPath, 'podmanBinaryPath')
    if (!/^[a-f0-9]{64}$/.test(options.podmanSha256)) throw new AgentHostError('INVALID_TARGET', 'Project VM Podman digest is invalid')
    this.podmanSha256 = options.podmanSha256
    this.baseImageUrl = safeImageUrl(options.baseImageUrl)
    this.baseImageSha256 = safeImageDigest(options.baseImageSha256)
    this.httpProxy = safeProxy(options.httpProxy, 'Project VM HTTP proxy')
    this.httpsProxy = safeProxy(options.httpsProxy, 'Project VM HTTPS proxy')
  }

  async ensureMachine(name: string, spec: ProjectVmMachineSpec): Promise<void> {
    const machine = safeMachine(name)
    const servicePorts = spec.servicePorts ?? []
    if (servicePorts.length !== 3) throw new AgentHostError('INVALID_TARGET', 'Remote Project VM requires OpenSandbox, Browser Host, and code-server ports')
    if (!Number.isSafeInteger(spec.sshPort) || spec.sshPort! < 1024 || spec.sshPort! > 65_535) {
      throw new AgentHostError('INVALID_TARGET', 'Remote Project VM SSH port is invalid')
    }
    await this.runHelper([
      'ensure',
      machine,
      String(spec.cpus),
      String(spec.memoryMb),
      String(spec.diskGb),
      spec.diskMode,
      String(spec.sshPort),
      String(servicePorts[0]),
      String(servicePorts[1]),
      String(servicePorts[2]),
    ])
  }

  async bootstrapToolchain(_name: string): Promise<void> {
    // The helper performs the idempotent guest bootstrap as part of ensure.
  }

  async runInMachine(name: string, command: string, args: string[] = []): Promise<ProjectVmCommandResult> {
    const result = await this.runHelper([
      'exec',
      safeMachine(name),
      safeCommand(command),
      ...args.map(safeArgument),
    ])
    return normalizeResult(result)
  }

  async copyToMachine(name: string, sourcePath: string, destinationPath: string): Promise<void> {
    const machine = safeMachine(name)
    const source = safeAbsolutePath(sourcePath, 'sourcePath')
    const destination = safeAbsolutePath(destinationPath, 'destinationPath')
    const staging = this.remoteRoot + '/staging/' + machine
    const remoteSource = staging + '/' + basename(source).replace(/[^A-Za-z0-9._-]/g, '_')
    await this.transport.execRemote('mkdir', ['-p', staging])
    await this.transport.upload(source, remoteSource)
    await this.runHelper(['copy', machine, remoteSource, destination])
  }

  async copyRemoteToMachine(name: string, sourcePath: string, destinationPath: string): Promise<void> {
    const machine = safeMachine(name)
    const source = safeAbsolutePath(sourcePath, 'remote source path')
    const destination = safeAbsolutePath(destinationPath, 'destinationPath')
    await this.runHelper(['copy', machine, source, destination])
  }

  async stopMachine(name: string): Promise<void> {
    await this.runHelper(['stop', safeMachine(name)])
  }

  async removeMachine(name: string): Promise<void> {
    await this.runHelper(['remove', safeMachine(name)])
  }

  async forwardPort(_name: string, remotePort: number): Promise<ProjectVmPortForward> {
    if (!Number.isSafeInteger(remotePort) || remotePort < 1024 || remotePort > 65_535) {
      throw new AgentHostError('INVALID_TARGET', 'Remote Project VM forward port is invalid')
    }
    return this.transport.tunnel(remotePort)
  }

  private runHelper(args: string[]): Promise<SshRemoteCommandResult> {
    return this.transport.execRemote('env', [
      'OPENLINK_REMOTE_ROOT=' + this.remoteRoot,
      'OPENLINK_PROJECT_VM_PODMAN_BINARY=' + this.podmanBinaryPath,
      'OPENLINK_PROJECT_VM_PODMAN_SHA256=' + this.podmanSha256,
      'OPENLINK_PROJECT_VM_BASE_IMAGE_URL=' + this.baseImageUrl,
      'OPENLINK_PROJECT_VM_BASE_IMAGE_SHA256=' + this.baseImageSha256,
      ...(this.httpProxy ? ['OPENLINK_PROJECT_VM_HTTP_PROXY=' + this.httpProxy] : []),
      ...(this.httpsProxy ? ['OPENLINK_PROJECT_VM_HTTPS_PROXY=' + this.httpsProxy] : []),
      this.releaseDirectory + '/project-vm.sh',
      ...args,
    ])
  }
}
