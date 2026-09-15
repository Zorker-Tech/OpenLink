import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentHostError } from './errors.js'

export interface SshTarget {
  id: string
  host: string
  user: string
  port: number
  remoteRoot: string
}

export interface SshCommand {
  executable: 'ssh' | 'scp'
  args: string[]
}

export interface RemoteBootstrapStep {
  id:
    | 'preflight-os'
    | 'preflight-kvm'
    | 'create-release-dir'
    | 'upload-bundle'
    | 'upload-checksum'
    | 'verify-bundle'
    | 'extract-bundle'
    | 'verify-project-vm-podman'
    | 'verify-project-vm-helper'
  description: string
  requiresPrivilege: boolean
  command: SshCommand
}

export interface RemoteBootstrapPlan {
  target: SshTarget
  releaseId: string
  bundleSha256: string
  steps: RemoteBootstrapStep[]
}

function validateId(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new AgentHostError('INVALID_TARGET', `${label} contains unsafe characters`)
  }
  return value
}

function validateRemoteRoot(value: string): string {
  if (!/^\/(?:[A-Za-z0-9._-]+\/?)*$/.test(value) || value.split('/').includes('..')) {
    throw new AgentHostError('INVALID_TARGET', 'remoteRoot must be an absolute safe POSIX path')
  }
  return value.replace(/\/+$/, '') || '/'
}

function validateHost(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9.:[\]-]{0,253}$/.test(value) || value.startsWith('-')) {
    throw new AgentHostError('INVALID_TARGET', 'host contains unsafe characters')
  }
  return value
}

function validateUser(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(value)) {
    throw new AgentHostError('INVALID_TARGET', 'user contains unsafe characters')
  }
  return value
}

function validateLocalPath(value: string, label: string): string {
  if (!value || /[\u0000-\u001f]/.test(value)) {
    throw new AgentHostError('INVALID_TARGET', `${label} is invalid`)
  }
  return value
}

export function validateSshTarget(target: SshTarget): SshTarget {
  if (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535) {
    throw new AgentHostError('INVALID_TARGET', 'SSH port is invalid')
  }
  return {
    id: validateId(target.id, 'target id'),
    host: validateHost(target.host),
    user: validateUser(target.user),
    port: target.port,
    remoteRoot: validateRemoteRoot(target.remoteRoot),
  }
}

function endpoint(target: SshTarget): string {
  return `${target.user}@${target.host}`
}

function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\"'\"'") + "'"
}

/**
 * Bootstrap only the immutable VM helper and image bundle. It deliberately
 * does not inspect Docker or start a host-level service manager; the selected
 * Project VM is created lazily and all services are started inside that guest.
 */
export function buildRemoteProjectVmBootstrapPlan(
  input: SshTarget,
  releaseId: string,
  bundleSha256: string,
  paths: { bundle: string; checksum: string } = {
    bundle: 'openlink-agent-bundle.tar.gz',
    checksum: 'bundle.sha256',
  },
): RemoteBootstrapPlan {
  const target = validateSshTarget(input)
  validateId(releaseId, 'release id')
  const bundlePath = validateLocalPath(paths.bundle, 'bundle path')
  const checksumPath = validateLocalPath(paths.checksum, 'checksum path')
  if (!/^[a-f0-9]{64}$/.test(bundleSha256)) {
    throw new AgentHostError('INVALID_TARGET', 'bundleSha256 must be a lowercase SHA-256 digest')
  }
  const releaseDir = `${target.remoteRoot}/releases/${releaseId}`
  const common = ['-p', String(target.port), endpoint(target)]
  return {
    target,
    releaseId,
    bundleSha256,
    steps: [
      {
        id: 'preflight-os',
        description: 'Verify the remote Linux host before VM provisioning',
        requiresPrivilege: false,
        command: { executable: 'ssh', args: [...common, 'uname', '-srm'] },
      },
      {
        id: 'preflight-kvm',
        description: 'Verify hardware virtualization and passwordless sudo before KVM activation',
        requiresPrivilege: false,
        command: { executable: 'ssh', args: [...common, 'bash', '-lc', "command -v sudo >/dev/null && sudo -n true && grep -Eq '(^|[[:space:]])(vmx|svm)([[:space:]]|$)' /proc/cpuinfo"] },
      },
      {
        id: 'create-release-dir',
        description: 'Create a versioned VM runtime release directory',
        requiresPrivilege: false,
        command: { executable: 'ssh', args: [...common, 'mkdir', '-p', releaseDir] },
      },
      {
        id: 'upload-bundle',
        description: 'Upload the pinned VM helper, images, and runtime artifacts',
        requiresPrivilege: false,
        command: { executable: 'scp', args: ['-P', String(target.port), bundlePath, `${endpoint(target)}:${releaseDir}/bundle.tar.gz`] },
      },
      {
        id: 'upload-checksum',
        description: 'Upload the expected SHA-256 manifest',
        requiresPrivilege: false,
        command: { executable: 'scp', args: ['-P', String(target.port), checksumPath, `${endpoint(target)}:${releaseDir}/bundle.sha256`] },
      },
      {
        id: 'verify-bundle',
        description: 'Verify the uploaded VM runtime bundle before execution',
        requiresPrivilege: false,
        command: { executable: 'ssh', args: [...common, 'sha256sum', '-c', `${releaseDir}/bundle.sha256`] },
      },
      {
        id: 'extract-bundle',
        description: 'Extract the verified VM runtime release',
        requiresPrivilege: false,
        command: { executable: 'ssh', args: [...common, 'tar', '-xzf', `${releaseDir}/bundle.tar.gz`, '-C', releaseDir] },
      },
      {
        id: 'verify-project-vm-podman',
        description: 'Verify the repository-built Podman engine is present',
        requiresPrivilege: false,
        command: { executable: 'ssh', args: [...common, 'test', '-x', `${releaseDir}/toolchain/podman`] },
      },
      {
        id: 'verify-project-vm-helper',
        description: 'Verify the Project VM helper is executable',
        requiresPrivilege: false,
        command: { executable: 'ssh', args: [...common, 'test', '-x', `${releaseDir}/project-vm.sh`] },
      },
    ],
  }
}

export interface SshTransportOptions {
  identityFile?: string
  /**
   * Decrypted only inside Agent Host. A short-lived 0600 identity file is
   * materialized for each SSH command and removed immediately afterwards.
   */
  privateKey?: string
  knownHostsFile: string
  connectTimeoutSeconds?: number
}

export interface SshTunnel {
  readonly localPort: number
  close(): Promise<void>
}

export interface SshRemoteCommandResult {
  stdout: string
  stderr: string
}

async function availablePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer()
    server.once('error', rejectPort)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        rejectPort(new Error('Could not allocate a tunnel port'))
        return
      }
      const port = address.port
      server.close((error) => error ? rejectPort(error) : resolvePort(port))
    })
  })
}

export class SshTransport {
  private readonly target: SshTarget

  constructor(target: SshTarget, private readonly options: SshTransportOptions) {
    this.target = validateSshTarget(target)
    validateLocalPath(options.knownHostsFile, 'known hosts file')
    if (options.identityFile) validateLocalPath(options.identityFile, 'identity file')
    if (options.identityFile && options.privateKey) throw new AgentHostError('INVALID_TARGET', 'SSH transport accepts either identityFile or privateKey')
    if (options.privateKey && (options.privateKey.length < 64 || options.privateKey.length > 32_768 || !options.privateKey.includes('PRIVATE KEY'))) {
      throw new AgentHostError('INVALID_TARGET', 'SSH private key is invalid')
    }
  }

  async executePlan(plan: RemoteBootstrapPlan): Promise<void> {
    if (plan.target.id !== this.target.id) throw new AgentHostError('INVALID_TARGET', 'Bootstrap plan target does not match SSH transport')
    for (const step of plan.steps) await this.run(step.command)
  }

  /** Execute a command on the SSH target and retain stdout/stderr. */
  async execRemote(command: string, args: string[] = []): Promise<SshRemoteCommandResult> {
    if (!command || /[\u0000\r\n]/.test(command) || args.some((arg) => /[\u0000\r\n]/.test(arg))) {
      throw new AgentHostError('INVALID_TARGET', 'SSH command contains control characters')
    }
    const remoteCommand = [command, ...args].map(shellQuote).join(' ')
    return this.withIdentity((identityFile) => this.runCapture('ssh', [...this.baseArgs(identityFile), endpoint(this.target), remoteCommand]))
  }

  /** Upload a local artifact to a target path using the same strict SSH policy. */
  async upload(localPath: string, remotePath: string): Promise<void> {
    validateLocalPath(localPath, 'local upload path')
    validateLocalPath(remotePath, 'remote upload path')
    await this.withIdentity((identityFile) => this.runCapture('scp', [
      '-P', String(this.target.port),
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=yes',
      '-o', 'UserKnownHostsFile=' + this.options.knownHostsFile,
      '-o', 'ConnectTimeout=' + String(this.options.connectTimeoutSeconds ?? 10),
      ...(identityFile ? ['-i', identityFile] : []),
      localPath,
      endpoint(this.target) + ':' + remotePath,
    ]))
  }

  async tunnel(remotePort = 43122): Promise<SshTunnel> {
    if (!Number.isSafeInteger(remotePort) || remotePort < 1 || remotePort > 65_535) throw new AgentHostError('INVALID_TARGET', 'Remote tunnel port is invalid')
    const localPort = await availablePort()
    const temporaryIdentity = await this.createTemporaryIdentity()
    const args = [
      ...this.baseArgs(temporaryIdentity?.path),
      '-N',
      '-o', 'ExitOnForwardFailure=yes',
      '-L', `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
      endpoint(this.target),
    ]
    const child = spawn('ssh', args, { shell: false, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => { stderr = `${stderr}${chunk.toString('utf8')}`.slice(-8192) })
    try {
      await new Promise<void>((resolveReady, rejectReady) => {
        const timeout = setTimeout(() => resolveReady(), 500)
        child.once('error', (error) => { clearTimeout(timeout); rejectReady(error) })
        child.once('exit', (code) => { clearTimeout(timeout); rejectReady(new AgentHostError('PROVISIONING_FAILED', `SSH tunnel exited with ${code ?? 'unknown'}${stderr ? `: ${stderr}` : ''}`)) })
      })
    } catch (error) {
      await temporaryIdentity?.cleanup()
      throw error
    }
    return {
      localPort,
      close: async () => {
        if (child.exitCode !== null) return
        child.kill('SIGTERM')
        await Promise.race([
          new Promise<void>((resolveExit) => child.once('exit', () => resolveExit())),
          new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 5_000)),
        ])
        if (child.exitCode === null) child.kill('SIGKILL')
        await temporaryIdentity?.cleanup()
      },
    }
  }

  private baseArgs(identityFile = this.options.identityFile): string[] {
    return [
      '-p', String(this.target.port),
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=yes',
      '-o', `UserKnownHostsFile=${this.options.knownHostsFile}`,
      '-o', `ConnectTimeout=${this.options.connectTimeoutSeconds ?? 10}`,
      ...(identityFile ? ['-i', identityFile] : []),
    ]
  }

  private runCapture(executable: 'ssh' | 'scp', args: string[]): Promise<SshRemoteCommandResult> {
    return new Promise((resolveRun, rejectRun) => {
      const child = spawn(executable, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk: Buffer) => { stdout = (stdout + chunk.toString('utf8')).slice(-16 * 1024 * 1024) })
      child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-16 * 1024 * 1024) })
      child.once('error', rejectRun)
      child.once('exit', (code) => code === 0
        ? resolveRun({ stdout, stderr })
        : rejectRun(new AgentHostError(
          'PROVISIONING_FAILED',
          executable + ' exited with ' + (code ?? 'unknown') + (stderr ? ': ' + stderr : ''),
          { retryable: true },
        )))
    })
  }

  private async run(command: SshCommand): Promise<void> {
    await this.withIdentity(async (identityFile) => {
      const args = command.executable === 'ssh'
      ? [...this.baseArgs(identityFile), ...command.args.slice(2)]
      : [
          '-P', String(this.target.port),
          '-o', 'BatchMode=yes',
          '-o', 'StrictHostKeyChecking=yes',
          '-o', `UserKnownHostsFile=${this.options.knownHostsFile}`,
          ...(identityFile ? ['-i', identityFile] : []),
          ...command.args.slice(2),
        ]
      await new Promise<void>((resolveRun, rejectRun) => {
      const child = spawn(command.executable, args, { shell: false, stdio: ['ignore', 'ignore', 'pipe'] })
      let stderr = ''
      child.stderr.on('data', (chunk: Buffer) => { stderr = `${stderr}${chunk.toString('utf8')}`.slice(-8192) })
      child.once('error', rejectRun)
      child.once('exit', (code) => code === 0 ? resolveRun() : rejectRun(new AgentHostError('PROVISIONING_FAILED', `${command.executable} exited with ${code ?? 'unknown'}${stderr ? `: ${stderr}` : ''}`)))
      })
    })
  }

  private async withIdentity<T>(operation: (identityFile: string | undefined) => Promise<T>): Promise<T> {
    const temporary = await this.createTemporaryIdentity()
    try {
      return await operation(temporary?.path ?? this.options.identityFile)
    } finally {
      await temporary?.cleanup()
    }
  }

  private async createTemporaryIdentity(): Promise<{ path: string; cleanup: () => Promise<void> } | undefined> {
    if (!this.options.privateKey) return undefined
    const directory = await mkdtemp(join(tmpdir(), 'openlink-ssh-'))
    const path = join(directory, 'identity')
    await writeFile(path, `${this.options.privateKey.trim()}\n`, { mode: 0o600 })
    return { path, cleanup: async () => rm(directory, { recursive: true, force: true }) }
  }
}
