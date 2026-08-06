import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
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
    | 'preflight-docker'
    | 'create-release-dir'
    | 'upload-bundle'
    | 'upload-checksum'
    | 'upload-secrets'
    | 'protect-secrets'
    | 'verify-bundle'
    | 'extract-bundle'
    | 'load-images'
    | 'start-opensandbox'
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

export function buildRemoteBootstrapPlan(
  input: SshTarget,
  releaseId: string,
  bundleSha256: string,
  paths: { bundle: string; checksum: string; secrets: string } = {
    bundle: 'openlink-agent-bundle.tar.gz',
    checksum: 'bundle.sha256',
    secrets: 'runtime.env',
  },
): RemoteBootstrapPlan {
  const target = validateSshTarget(input)
  validateId(releaseId, 'release id')
  const bundlePath = validateLocalPath(paths.bundle, 'bundle path')
  const checksumPath = validateLocalPath(paths.checksum, 'checksum path')
  const secretsPath = validateLocalPath(paths.secrets, 'secrets path')
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
        description: 'Verify the remote operating system before transfer',
        requiresPrivilege: false,
        command: { executable: 'ssh', args: [...common, 'uname', '-srm'] },
      },
      {
        id: 'preflight-docker',
        description: 'Verify Docker is available on the target host',
        requiresPrivilege: false,
        command: { executable: 'ssh', args: [...common, 'docker', 'info', '--format', '{{.ServerVersion}}'] },
      },
      {
        id: 'create-release-dir',
        description: 'Create a versioned release directory',
        requiresPrivilege: true,
        command: { executable: 'ssh', args: [...common, 'mkdir', '-p', releaseDir] },
      },
      {
        id: 'upload-bundle',
        description: 'Upload the pinned agent and sandbox release bundle',
        requiresPrivilege: false,
        command: {
          executable: 'scp',
          args: ['-P', String(target.port), bundlePath, `${endpoint(target)}:${releaseDir}/bundle.tar.gz`],
        },
      },
      {
        id: 'upload-secrets',
        description: 'Upload the runtime-only OpenSandbox secret environment',
        requiresPrivilege: false,
        command: {
          executable: 'scp',
          args: ['-P', String(target.port), secretsPath, `${endpoint(target)}:${releaseDir}/runtime.env`],
        },
      },
      {
        id: 'protect-secrets',
        description: 'Restrict the runtime secret environment to the SSH account',
        requiresPrivilege: false,
        command: { executable: 'ssh', args: [...common, 'chmod', '600', `${releaseDir}/runtime.env`] },
      },
      {
        id: 'upload-checksum',
        description: 'Upload the expected SHA-256 manifest',
        requiresPrivilege: false,
        command: {
          executable: 'scp',
          args: ['-P', String(target.port), checksumPath, `${endpoint(target)}:${releaseDir}/bundle.sha256`],
        },
      },
      {
        id: 'verify-bundle',
        description: 'Verify the uploaded release digest before execution',
        requiresPrivilege: false,
        command: { executable: 'ssh', args: [...common, 'sha256sum', '-c', `${releaseDir}/bundle.sha256`] },
      },
      {
        id: 'extract-bundle',
        description: 'Extract the verified release bundle',
        requiresPrivilege: false,
        command: { executable: 'ssh', args: [...common, 'tar', '-xzf', `${releaseDir}/bundle.tar.gz`, '-C', releaseDir] },
      },
      {
        id: 'load-images',
        description: 'Load the pinned OpenLink RPC Worker image',
        requiresPrivilege: true,
        command: { executable: 'ssh', args: [...common, 'docker', 'load', '-i', `${releaseDir}/images/openlink-agent-images.tar`] },
      },
      {
        id: 'start-opensandbox',
        description: 'Start the pinned OpenSandbox control plane bound to target loopback',
        requiresPrivilege: true,
        command: {
          executable: 'ssh',
          args: [...common, 'docker', 'compose', '--env-file', `${releaseDir}/runtime.env`, '--project-name', `openlink-agent-${releaseId}`, '-f', `${releaseDir}/compose.yaml`, 'up', '-d'],
        },
      },
    ],
  }
}

export interface SshTransportOptions {
  identityFile?: string
  knownHostsFile: string
  connectTimeoutSeconds?: number
}

export interface SshTunnel {
  readonly localPort: number
  close(): Promise<void>
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
  }

  async executePlan(plan: RemoteBootstrapPlan): Promise<void> {
    if (plan.target.id !== this.target.id) throw new AgentHostError('INVALID_TARGET', 'Bootstrap plan target does not match SSH transport')
    for (const step of plan.steps) await this.run(step.command)
  }

  async tunnel(remotePort = 43122): Promise<SshTunnel> {
    if (!Number.isSafeInteger(remotePort) || remotePort < 1 || remotePort > 65_535) throw new AgentHostError('INVALID_TARGET', 'Remote tunnel port is invalid')
    const localPort = await availablePort()
    const args = [
      ...this.baseArgs(),
      '-N',
      '-o', 'ExitOnForwardFailure=yes',
      '-L', `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
      endpoint(this.target),
    ]
    const child = spawn('ssh', args, { shell: false, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => { stderr = `${stderr}${chunk.toString('utf8')}`.slice(-8192) })
    await new Promise<void>((resolveReady, rejectReady) => {
      const timeout = setTimeout(() => resolveReady(), 500)
      child.once('error', (error) => { clearTimeout(timeout); rejectReady(error) })
      child.once('exit', (code) => { clearTimeout(timeout); rejectReady(new AgentHostError('PROVISIONING_FAILED', `SSH tunnel exited with ${code ?? 'unknown'}${stderr ? `: ${stderr}` : ''}`)) })
    })
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
      },
    }
  }

  private baseArgs(): string[] {
    return [
      '-p', String(this.target.port),
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=yes',
      '-o', `UserKnownHostsFile=${this.options.knownHostsFile}`,
      '-o', `ConnectTimeout=${this.options.connectTimeoutSeconds ?? 10}`,
      ...(this.options.identityFile ? ['-i', this.options.identityFile] : []),
    ]
  }

  private run(command: SshCommand): Promise<void> {
    const args = command.executable === 'ssh'
      ? [...this.baseArgs(), ...command.args.slice(2)]
      : [
          '-P', String(this.target.port),
          '-o', 'BatchMode=yes',
          '-o', 'StrictHostKeyChecking=yes',
          '-o', `UserKnownHostsFile=${this.options.knownHostsFile}`,
          ...(this.options.identityFile ? ['-i', this.options.identityFile] : []),
          ...command.args.slice(2),
        ]
    return new Promise((resolveRun, rejectRun) => {
      const child = spawn(command.executable, args, { shell: false, stdio: ['ignore', 'ignore', 'pipe'] })
      let stderr = ''
      child.stderr.on('data', (chunk: Buffer) => { stderr = `${stderr}${chunk.toString('utf8')}`.slice(-8192) })
      child.once('error', rejectRun)
      child.once('exit', (code) => code === 0 ? resolveRun() : rejectRun(new AgentHostError('PROVISIONING_FAILED', `${command.executable} exited with ${code ?? 'unknown'}${stderr ? `: ${stderr}` : ''}`)))
    })
  }
}
