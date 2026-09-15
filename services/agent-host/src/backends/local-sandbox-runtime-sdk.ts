import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { resolve } from 'node:path'
import { AgentHostError } from '../errors.js'
import { compileSandboxPolicy } from '../policy.js'
import { createSessionStorageLayout, ensureSessionStorage } from '../storage.js'
import type { AgentExtensionUiResponse, AgentNativeSessionSnapshot, AgentPolicy, AgentProviderRuntimeConfiguration } from '../contracts.js'
import type { SandboxRuntimeAdapter } from './local-sandbox-runtime.js'
import type { ProjectRuntimeDescriptor } from '../project-runtime.js'
import type { BrowserAgentSession } from '../browser-client.js'
import { browserAgentBinding, browserHostNetworkTarget } from '../browser-binding.js'
import { ambientProviderEnvironment, providerNetworkTargets } from '../provider-environment.js'

export interface DesktopNodeSdkConfig {
  nodeExecutable?: string
  workerEntrypoint: string
  /** Local filesystem path to the browser Pi extension used by desktop workers. */
  browserExtensionPath?: string
  /** Project-scoped Supabase MCP capability injected into desktop workers. */
  supabaseMcp?: {
    extensionPath: string
    urlFor: (projectId: string) => string
    tokenFor: (projectId: string) => string
  }
  workspaceRoot: string
  storageRoot: string
  policy: AgentPolicy
}

export interface DesktopNodeSdkSession {
  readonly pid: number
  prompt(message: string, signal?: AbortSignal): Promise<Response>
  resolveExtensionUi(response: AgentExtensionUiResponse): Promise<void>
  setBrowser(browser?: BrowserAgentSession): Promise<void>
  cleanup(): Promise<void>
}

/**
 * sandbox-runtime's public SandboxManager is deliberately process-global: it
 * owns one proxy, one credential sentinel registry and (on Windows) one ACL
 * session.  Treat it as a leased resource instead of allowing two desktop
 * sessions to reconfigure/reset it concurrently.
 */
class SandboxManagerLease {
  private active = false
  private operation: Promise<void> = Promise.resolve()

  async acquire(): Promise<() => Promise<void>> {
    if (this.active) {
      throw new AgentHostError(
        'SESSION_BUSY',
        'The desktop sandbox-runtime process already owns an active agent session',
        { retryable: true },
      )
    }
    let releaseOperation!: () => void
    const previous = this.operation
    const current = new Promise<void>((resolveOperation) => { releaseOperation = resolveOperation })
    this.operation = previous.then(() => current)
    await previous
    if (this.active) {
      releaseOperation()
      throw new AgentHostError(
        'SESSION_BUSY',
        'The desktop sandbox-runtime process already owns an active agent session',
        { retryable: true },
      )
    }
    this.active = true
    let released = false
    return async () => {
      if (released) return
      released = true
      this.active = false
      releaseOperation()
    }
  }
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
  private readonly sandboxLease = new SandboxManagerLease()

  constructor(
    private readonly sandboxRuntime: SandboxRuntimeAdapter,
    private readonly config: DesktopNodeSdkConfig,
  ) {}

  async createSession(userId: string, workspaceId: string, sessionId: string, runtimeConfiguration: AgentProviderRuntimeConfiguration, nativeSession?: AgentNativeSessionSnapshot, projectId?: string, _projectRuntime?: ProjectRuntimeDescriptor, browserSession?: BrowserAgentSession): Promise<DesktopNodeSdkSession> {
    const releaseSandbox = await this.sandboxLease.acquire()
    let sandboxReleased = false
    const releaseSandboxOnce = async () => {
      if (sandboxReleased) return
      sandboxReleased = true
      await releaseSandbox()
    }
    let sessionReady = false
    try {
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
    const providerId = runtimeConfiguration.providerId
    const providerApiKey = runtimeConfiguration.apiKey
    const providerBaseUrl = runtimeConfiguration.baseUrl
    const providerHosts = providerNetworkTargets(providerId, providerBaseUrl)
    const model = `${runtimeConfiguration.providerId}/${runtimeConfiguration.modelId}`
    const browserExtensionPath = this.config.browserExtensionPath || resolve(process.cwd(), '../agent-browser-extension/openlink-browser.ts')
    const browser = browserSession
      ? browserAgentBinding(browserSession, browserExtensionPath)
      : undefined
    const browserCapabilityFile = resolve(layout.root, 'browser-capability.json')
    await writeFile(browserCapabilityFile, `${JSON.stringify(browser ?? null)}\n`, { encoding: 'utf8', mode: 0o600 })
    const browserHost = browser ? browserHostNetworkTarget(browser.hostUrl) : undefined
    const effectivePolicy = {
      ...this.config.policy,
      // Browser actions are issued by the Pi extension through Browser Host.
      // Include its origin in the sandbox policy or desktop agents would have
      // browser UI but no network permission to use it.
      allowedDomains: [...new Set([...providerHosts, ...(browserHost ? [browserHost] : ['127.0.0.1', 'localhost']), ...this.config.policy.allowedDomains])],
    }
    const compiledPolicy = compileSandboxPolicy(this.config.workspaceRoot, layout.root, effectivePolicy)
    const policy = {
      ...compiledPolicy,
      network: {
        ...compiledPolicy.network,
        allowLocalBinding: true,
        tlsTerminate: {},
      },
      credentials: {
        envVars: providerApiKey
          ? [{ name: 'OPENLINK_PROVIDER_API_KEY', mode: 'mask', injectHosts: providerHosts }]
          : [],
      },
    }
    const command = `${quote(resolve(this.config.nodeExecutable || process.execPath))} ${quote(resolve(this.config.workerEntrypoint))}`
    const previousProviderApiKey = process.env.OPENLINK_PROVIDER_API_KEY
    process.env.OPENLINK_PROVIDER_API_KEY = providerApiKey
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
      OPENLINK_AGENT_MODEL: model,
      OPENLINK_PROVIDER_ID: providerId,
      OPENLINK_PROVIDER_BASE_URL: providerBaseUrl,
      // Ambient credentials are explicitly scoped to the selected provider.
      // They are not part of the generic inherited environment and therefore
      // cannot expose Supabase/SSH credentials to the desktop worker.
      ...ambientProviderEnvironment(providerId),
      OPENLINK_BROWSER_EXTENSION_PATH: browserExtensionPath,
      OPENLINK_BROWSER_CAPABILITY_FILE: browserCapabilityFile,
      ...(projectId && this.config.supabaseMcp ? {
        OPENLINK_SUPABASE_EXTENSION_PATH: this.config.supabaseMcp.extensionPath,
        OPENLINK_SUPABASE_MCP_URL: this.config.supabaseMcp.urlFor(projectId),
        OPENLINK_SUPABASE_MCP_TOKEN: this.config.supabaseMcp.tokenFor(projectId),
        OPENLINK_SUPABASE_MCP_SESSION_ID: sessionId,
      } : {}),
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
      try {
        await this.sandboxRuntime.reset()
      } finally {
        // A failed provision has no session object through which the caller
        // could retry cleanup, so always release the lease after best-effort
        // reset. The next desktop request will reinitialize the manager.
        await releaseSandboxOnce()
      }
      throw new AgentHostError('PROVISIONING_FAILED', `${error instanceof Error ? error.message : String(error)}${stderr ? `: ${stderr}` : ''}`)
    }
    sessionReady = true
    let cleaned = false
    let cleanupPromise: Promise<void> | undefined
    return {
      pid: child.pid!,
      prompt: async (message, signal) => {
        const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
        const cancelWorker = () => {
          void fetch(`${baseUrl}/v1/cancel`, {
            method: 'POST',
            headers,
            signal: AbortSignal.timeout(2_000),
          }).catch(() => undefined)
        }
        const response = await fetch(`${baseUrl}/v1/events`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ message }),
        })
        if (signal) {
          if (signal.aborted) cancelWorker()
          else signal.addEventListener('abort', cancelWorker, { once: true })
        }
        return response
      },
      resolveExtensionUi: async (response) => {
        const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
        const result = await fetch(`${baseUrl}/v1/extension-ui-response`, {
          method: 'POST',
          headers,
          body: JSON.stringify(response),
          signal: AbortSignal.timeout(5_000),
        })
        if (!result.ok) {
          throw new AgentHostError(
            'EXTENSION_UI_REQUEST_NOT_FOUND',
            `Desktop Agent Worker rejected extension UI response (${result.status})`,
            { retryable: true },
          )
        }
      },
      setBrowser: async (nextBrowserSession) => {
        const capability = nextBrowserSession ? browserAgentBinding(nextBrowserSession, browserExtensionPath) : null
        const result = await fetch(`${baseUrl}/v1/browser-capability`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ capability }),
          signal: AbortSignal.timeout(5_000),
        })
        if (!result.ok) throw new AgentHostError('INVALID_SESSION', `Desktop Agent Worker could not update Browser capability (${result.status})`, { retryable: true })
      },
      cleanup: async () => {
        if (cleaned) return
        if (cleanupPromise) return cleanupPromise
        cleanupPromise = (async () => {
          if (child.exitCode === null) child.kill('SIGTERM')
          await Promise.race([
            new Promise<void>((resolveExit) => child.once('exit', () => resolveExit())),
            new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 5_000)),
          ])
          if (child.exitCode === null) child.kill('SIGKILL')
          await this.sandboxRuntime.reset()
          await releaseSandboxOnce()
          cleaned = true
        })().catch((error) => {
          cleanupPromise = undefined
          throw error
        })
        return cleanupPromise
      },
    }
    } catch (error) {
      if (!sessionReady) await releaseSandboxOnce().catch(() => undefined)
      throw error
    }
  }
}
