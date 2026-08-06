import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { resolve } from 'node:path'
import { AgentHostError } from '../errors.js'
import { compileSandboxPolicy } from '../policy.js'
import { createSessionStorageLayout, ensureSessionStorage } from '../storage.js'
import type { AgentNativeSessionSnapshot, AgentPolicy, AgentProviderRuntimeConfiguration } from '../contracts.js'
import type { SandboxRuntimeAdapter } from './local-sandbox-runtime.js'

export interface DesktopNodeSdkConfig {
  nodeExecutable?: string
  workerEntrypoint: string
  workspaceRoot: string
  storageRoot: string
  model?: string
  geminiApiKey?: string
  geminiBaseUrl?: string
  policy: AgentPolicy
}

export interface DesktopNodeSdkSession {
  readonly pid: number
  prompt(message: string, signal?: AbortSignal): Promise<Response>
  cleanup(): Promise<void>
}

function quote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

async function availablePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer()
    server.once('error', rejectPort)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        rejectPort(new Error('Could not allocate an Agent Worker port'))
        return
      }
      server.close((error) => error ? rejectPort(error) : resolvePort(address.port))
    })
  })
}

async function waitForWorker(baseUrl: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new AgentHostError('PROVISIONING_FAILED', `Desktop Agent Worker exited with ${child.exitCode}`)
    try {
      const response = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(1_000) })
      if (response.ok) return
    } catch {}
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
  throw new AgentHostError('PROVISIONING_FAILED', 'Desktop Agent Worker did not become ready')
}

/** Desktop-only transport: sandbox-runtime contains the Node SDK Worker process. */
export class DesktopSandboxRuntimeNodeBackend {
  constructor(
    private readonly sandboxRuntime: SandboxRuntimeAdapter,
    private readonly config: DesktopNodeSdkConfig,
  ) {}

  async createSession(userId: string, workspaceId: string, sessionId: string, runtimeConfiguration?: AgentProviderRuntimeConfiguration, nativeSession?: AgentNativeSessionSnapshot, _projectId?: string): Promise<DesktopNodeSdkSession> {
    const layout = createSessionStorageLayout(this.config.storageRoot, userId, workspaceId, sessionId)
    await ensureSessionStorage(layout)
    await mkdir(resolve(layout.root, 'worker'), { recursive: true, mode: 0o700 })
    const nativeSessionFile = resolve(layout.root, 'cloud-session.jsonl')
    if (nativeSession) {
      const serialized = [nativeSession.header, ...nativeSession.entries].map((entry) => JSON.stringify(entry)).join('\n') + '\n'
      const temporaryFile = `${nativeSessionFile}.tmp-${process.pid}`
      await writeFile(temporaryFile, serialized, { encoding: 'utf8', mode: 0o600 })
      await rename(temporaryFile, nativeSessionFile)
    }
    const port = await availablePort()
    const token = randomBytes(32).toString('base64url')
    const providerId = runtimeConfiguration?.providerId ?? (this.config.geminiApiKey ? 'google' : undefined)
    const providerApiKey = runtimeConfiguration?.apiKey ?? this.config.geminiApiKey
    const providerBaseUrl = runtimeConfiguration?.baseUrl ?? this.config.geminiBaseUrl ?? 'https://generativelanguage.googleapis.com/v1beta'
    const providerHost = new URL(providerBaseUrl).hostname
    const model = runtimeConfiguration ? `${runtimeConfiguration.providerId}/${runtimeConfiguration.modelId}` : this.config.model
    const effectivePolicy = { ...this.config.policy, allowedDomains: [...new Set([providerHost, ...this.config.policy.allowedDomains])] }
    const compiledPolicy = compileSandboxPolicy(this.config.workspaceRoot, layout.root, effectivePolicy)
    const policy = {
      ...compiledPolicy,
      network: {
        ...compiledPolicy.network,
        allowLocalBinding: true,
        ...(providerApiKey ? { tlsTerminate: {} } : {}),
      },
      ...(providerApiKey ? {
        credentials: {
          envVars: [{ name: 'OPENLINK_PROVIDER_API_KEY', mode: 'mask', injectHosts: [providerHost] }],
        },
      } : {}),
    }
    const command = `${quote(resolve(this.config.nodeExecutable || process.execPath))} ${quote(resolve(this.config.workerEntrypoint))}`
    const previousProviderApiKey = process.env.OPENLINK_PROVIDER_API_KEY
    if (providerApiKey) process.env.OPENLINK_PROVIDER_API_KEY = providerApiKey
    let wrapped: Awaited<ReturnType<SandboxRuntimeAdapter['wrapWithSandboxArgv']>>
    try {
      await this.sandboxRuntime.initialize(policy)
      wrapped = await this.sandboxRuntime.wrapWithSandboxArgv(command, undefined, policy, undefined, this.config.workspaceRoot)
      wrapped = { ...wrapped, env: { ...wrapped.env } }
    } finally {
      if (previousProviderApiKey === undefined) delete process.env.OPENLINK_PROVIDER_API_KEY
      else process.env.OPENLINK_PROVIDER_API_KEY = previousProviderApiKey
    }
    const workerEnvironment: Record<string, string> = {
      ...Object.fromEntries(Object.entries(wrapped.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
      OPENLINK_AGENT_WORKER_TOKEN: token,
      OPENLINK_AGENT_WORKER_HOST: '127.0.0.1',
      OPENLINK_AGENT_WORKER_PORT: String(port),
      OPENLINK_AGENT_WORKSPACE_ROOT: this.config.workspaceRoot,
      OPENLINK_AGENT_SESSION_ROOT: layout.root,
      ...(nativeSession ? { OPENLINK_AGENT_SESSION_FILE: nativeSessionFile } : {}),
      NODE_USE_ENV_PROXY: '1',
      ...(model ? { OPENLINK_AGENT_MODEL: model } : {}),
      ...(providerId ? { OPENLINK_PROVIDER_ID: providerId } : {}),
      ...(providerBaseUrl ? { OPENLINK_PROVIDER_BASE_URL: providerBaseUrl } : {}),
    }
    const child = spawn(wrapped.argv[0]!, wrapped.argv.slice(1), {
      cwd: this.config.workspaceRoot,
      env: workerEnvironment,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => { stderr = `${stderr}${chunk.toString('utf8')}`.slice(-16_384) })
    child.once('error', () => {})
    const baseUrl = `http://127.0.0.1:${port}`
    try {
      await waitForWorker(baseUrl, child)
    } catch (error) {
      child.kill('SIGTERM')
      await this.sandboxRuntime.reset()
      throw new AgentHostError('PROVISIONING_FAILED', `${error instanceof Error ? error.message : String(error)}${stderr ? `: ${stderr}` : ''}`)
    }
    let cleaned = false
    return {
      pid: child.pid!,
      prompt: (message, signal) => fetch(`${baseUrl}/v1/events`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
        signal,
      }),
      cleanup: async () => {
        if (cleaned) return
        cleaned = true
        if (child.exitCode === null) child.kill('SIGTERM')
        await Promise.race([
          new Promise<void>((resolveExit) => child.once('exit', () => resolveExit())),
          new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 5_000)),
        ])
        if (child.exitCode === null) child.kill('SIGKILL')
        await this.sandboxRuntime.reset()
      },
    }
  }
}
