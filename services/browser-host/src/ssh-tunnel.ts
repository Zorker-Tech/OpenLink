import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, createConnection } from 'node:net'
import { BrowserHostError } from './errors.js'

export interface SshForwardTarget {
  host: string
  user: string
  port: number
  knownHostsFile: string
  identityFile?: string
}

export interface SshLocalForwardSpec {
  target: SshForwardTarget
  remoteHost?: '127.0.0.1' | 'localhost' | '::1'
  remotePort: number
  localPort?: number
  connectTimeoutMs?: number
}

export function buildSshLocalForwardArgs(spec: SshLocalForwardSpec, localPort: number): string[] {
  const target = spec.target
  validateHost(target.host)
  validateUser(target.user)
  validatePort(target.port, 'SSH port')
  validatePort(spec.remotePort, 'Remote forwarded port')
  validatePort(localPort, 'Local forwarded port')
  if (!target.knownHostsFile || /[\u0000\r\n]/.test(target.knownHostsFile)) {
    throw new BrowserHostError('INVALID_SSH_TARGET', 'knownHostsFile is required', 400)
  }
  if (target.identityFile && /[\u0000\r\n]/.test(target.identityFile)) {
    throw new BrowserHostError('INVALID_SSH_TARGET', 'identityFile is invalid', 400)
  }
  const remoteHost = spec.remoteHost ?? '127.0.0.1'
  const args = [
    '-N', '-T',
    '-o', 'BatchMode=yes',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', `UserKnownHostsFile=${target.knownHostsFile}`,
    '-o', `ConnectTimeout=${Math.max(1, Math.ceil((spec.connectTimeoutMs ?? 10_000) / 1000))}`,
    '-p', String(target.port),
  ]
  if (target.identityFile) args.push('-i', target.identityFile)
  args.push('-L', `127.0.0.1:${localPort}:${remoteHost}:${spec.remotePort}`, `${target.user}@${target.host}`)
  return args
}

function validateHost(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9.:[\]-]{0,253}$/.test(value) || value.startsWith('-')) {
    throw new BrowserHostError('INVALID_SSH_TARGET', 'SSH host contains unsafe characters', 400)
  }
  return value
}

function validateUser(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(value)) {
    throw new BrowserHostError('INVALID_SSH_TARGET', 'SSH user contains unsafe characters', 400)
  }
  return value
}

function validatePort(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new BrowserHostError('INVALID_SSH_TARGET', `${label} is invalid`, 400)
  }
  return value
}

async function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new BrowserHostError('PORT_ALLOCATION_FAILED', 'Could not allocate a loopback port'))
        return
      }
      const port = address.port
      server.close((error) => error ? reject(error) : resolve(port))
    })
  })
}

async function waitForPort(port: number, timeoutMs: number, process: ChildProcess, stderr: () => string): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (process.exitCode !== null) {
      throw new BrowserHostError('SSH_TUNNEL_FAILED', `SSH tunnel exited before becoming ready: ${stderr() || `code ${process.exitCode}`}`, 502, true)
    }
    const ready = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ host: '127.0.0.1', port })
      const finish = (value: boolean) => {
        socket.removeAllListeners()
        socket.destroy()
        resolve(value)
      }
      socket.setTimeout(250)
      socket.once('connect', () => finish(true))
      socket.once('timeout', () => finish(false))
      socket.once('error', () => finish(false))
    })
    if (ready) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new BrowserHostError('SSH_TUNNEL_TIMEOUT', `SSH tunnel did not become ready within ${timeoutMs}ms`, 504, true)
}

export class SshLocalForward {
  private process?: ChildProcess
  private _localPort?: number
  private stderr = ''

  constructor(private readonly spec: SshLocalForwardSpec) {}

  get localPort(): number {
    if (!this._localPort) throw new BrowserHostError('SSH_TUNNEL_NOT_READY', 'SSH tunnel is not ready', 409, true)
    return this._localPort
  }

  get url(): string {
    return `http://127.0.0.1:${this.localPort}`
  }

  async start(): Promise<void> {
    if (this.process) throw new BrowserHostError('SSH_TUNNEL_ALREADY_STARTED', 'SSH tunnel is already started', 409)
    this._localPort = this.spec.localPort ? validatePort(this.spec.localPort, 'Local forwarded port') : await reservePort()
    const args = buildSshLocalForwardArgs(this.spec, this._localPort)

    const child = spawn('ssh', args, { stdio: ['ignore', 'ignore', 'pipe'], shell: false })
    this.process = child
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-8192)
    })
    child.once('error', (error) => {
      this.stderr = `${this.stderr}\n${error.message}`.trim()
    })

    try {
      await waitForPort(this._localPort, this.spec.connectTimeoutMs ?? 10_000, this.process, () => this.stderr.trim())
    } catch (error) {
      await this.close()
      throw error
    }
  }

  async close(): Promise<void> {
    const child = this.process
    this.process = undefined
    this._localPort = undefined
    if (!child || child.exitCode !== null) return
    child.kill('SIGTERM')
    const exited = await Promise.race([
      new Promise<boolean>((resolve) => child.once('exit', () => resolve(true))),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2_000)),
    ])
    if (!exited && child.exitCode === null) child.kill('SIGKILL')
  }
}
