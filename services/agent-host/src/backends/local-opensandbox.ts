import { ConnectionConfig, Sandbox, type Endpoint } from '@alibaba-group/opensandbox'
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { promisify } from 'node:util'
import { AgentHostError } from '../errors.js'
import type { AgentExtensionUiResponse, AgentNativeSessionSnapshot, AgentProviderRuntimeConfiguration } from '../contracts.js'
import type { BrowserAgentSession } from '../browser-client.js'
import { browserAgentBinding, browserHostNetworkTarget, LOCAL_BROWSER_EXTENSION_PATH, projectBrowserHostOrigin } from '../browser-binding.js'
import type { ProjectRuntimeDescriptor } from '../project-runtime.js'
import { createSessionStorageLayout, ensureSessionStorage, type SessionStorageLayout } from '../storage.js'
import { disposeOpenSandbox } from './sandbox-cleanup.js'
import { cleanupOpenSandboxSessionWorkloads } from './opensandbox-recovery.js'
import { ambientProviderEnvironment, providerNetworkTargets } from '../provider-environment.js'
import type { AgentResourceRequest, PromptAttachment, PromptRuntimeAgentOptions } from '../prompt-http-server.js'
import type { CodexPluginSnapshot } from '../codex-plugin-snapshot.js'

const execFileAsync = promisify(execFile)

export interface LocalOpenSandboxConfig {
  domain: string
  apiKey: string
  image: string
  workspaceRoot: string
  storageRoot: string
  /** OpenSandbox workload lifetime. `null` delegates cleanup to Agent Host. */
  sessionTtlSeconds: number | null
  /** Project/session outbound policy. Keep deny as the library default; the
   * Local app explicitly opts into public egress while its approval layer is
   * active. */
  networkDefaultAction?: 'allow' | 'deny'
  /** Explicit escape hatch for development-only rootless VMs without egress enforcement. */
  allowUnsafeRootlessCredentials?: boolean
  /** Project-scoped Supabase MCP capability injected into the worker session. */
  supabaseMcp?: {
    extensionPath: string
    urlFor: (projectId: string) => string
    tokenFor: (projectId: string) => string
  }
  /** Produces the host Codex installation snapshot copied into each isolated
   * Codex session before its App Server starts. Pi sessions never receive it. */
  codexPluginSnapshot?: () => Promise<CodexPluginSnapshot>
}

export interface OpenSandboxPromptSession {
  control(input: { action: string; text?: string }): Promise<unknown>
  readonly sandboxId: string
  readonly layout: SessionStorageLayout
  pause(): Promise<void>
  resume(): Promise<void>
  prompt(message: string, signal?: AbortSignal, attachments?: PromptAttachment[]): Promise<Response>
  resolveExtensionUi(response: AgentExtensionUiResponse): Promise<void>
  networkAccess(hosts: string[], mode: 'temporary' | 'persistent', durationSeconds?: number): Promise<void>
  resources(request?: AgentResourceRequest): Promise<unknown>
  setBrowser(browser?: BrowserAgentSession): Promise<void>
  cleanup(): Promise<void>
}

interface DurableRuntimeLease {
  version: 1
  sandboxId: string
  workerToken: string
  identity: string
  updatedAt: string
}

function workerUrl(config: ConnectionConfig, endpoint: Endpoint): string {
  return `${config.protocol}://${endpoint.endpoint}`
}

/** Project sandboxes reach VM-published services through Podman's host gateway. */
export function projectContainerReachableUrl(rawUrl: string, projectRuntime?: ProjectRuntimeDescriptor): string {
  if (!projectRuntime) return rawUrl
  const url = new URL(rawUrl)
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
    url.hostname = 'host.containers.internal'
  }
  return url.toString().replace(/\/$/, '')
}

export async function waitForWorker(baseUrl: string, headers: Record<string, string> = {}, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/healthz`, {
        headers,
        signal: AbortSignal.timeout(2_000),
      })
      if (response.ok) { await response.body?.cancel(); return }
      const health = await response.json().catch(() => null) as { state?: string; error?: unknown } | null
      if (health?.state === 'error') {
        lastError = new Error(typeof health.error === 'string' ? health.error : 'Native Agent initialization failed')
        break
      }
      lastError = new Error(`Agent Worker health check returned HTTP ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200))
  }
  throw new AgentHostError(
    'PROVISIONING_FAILED',
    `Agent Worker did not become ready: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  )
}

type WorkerReadyProbe = (baseUrl: string, headers: Record<string, string>, timeoutMs: number) => Promise<void>

/** Abort preparation promptly, then preserve the final native stream on stop. */
export async function requestWorkerPrompt(baseUrl: string, headers: Record<string, string>, message: string, signal?: AbortSignal, attachments: PromptAttachment[] = []): Promise<Response> {
  const preparation = new AbortController()
  const abortPreparation = () => preparation.abort()
  signal?.throwIfAborted()
  signal?.addEventListener('abort', abortPreparation, { once: true })
  const timeout = setTimeout(abortPreparation, 60_000)
  timeout.unref?.()
  let response: Response
  try {
    response = await fetch(`${baseUrl}/v1/events`, {
      method: 'POST', headers, body: JSON.stringify({ message, ...(attachments.length ? { attachments } : {}) }), signal: preparation.signal,
    })
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', abortPreparation)
  }
  const cancelWorker = () => {
    void fetch(`${baseUrl}/v1/cancel`, { method: 'POST', headers, signal: AbortSignal.timeout(2_000) }).catch(() => undefined)
  }
  if (signal?.aborted) cancelWorker()
  else signal?.addEventListener('abort', cancelWorker, { once: true })
  return response
}

interface ProviderCredentialVault {
  create(request: {
    credentials: Array<{ name: string; source: { type: 'inline'; value: string } }>
    bindings: Array<{
      name: string
      match: { schemes: Array<'http' | 'https'>; hosts: string[] }
      auth: {
        type: 'passthrough'
        substitutions: Array<{ credential: string; placeholder: string; in: ['header'] }>
      }
    }>
  }): Promise<unknown>
  delete(): Promise<void>
}

const providerVaultPlaceholder = 'openlink-provider-vault-placeholder'

function providerCredentialVaultRequest(providerBaseUrl: string, providerHosts: string[], providerApiKey: string) {
  const providerUrl = new URL(providerBaseUrl)
  return {
    credentials: [{ name: 'provider-api-key', source: { type: 'inline' as const, value: providerApiKey } }],
    bindings: [{
      name: 'provider-api',
      match: {
        schemes: [providerUrl.protocol === 'http:' ? 'http' as const : 'https' as const],
        hosts: providerHosts,
      },
      auth: {
        type: 'passthrough' as const,
        substitutions: [{ credential: 'provider-api-key', placeholder: providerVaultPlaceholder, in: ['header'] as ['header'] }],
      },
    }],
  }
}

function httpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined
  const statusCode = (error as { statusCode?: unknown }).statusCode
  return typeof statusCode === 'number' ? statusCode : undefined
}

/**
 * Credential Vault contents live in the egress sidecar's memory. Podman can
 * restart a durable sandbox and its sidecar after a Project VM reboot, but it
 * cannot recreate secrets that were provisioned through the runtime API.
 * Reinstall the complete sandbox-owned vault before exposing the recovered
 * Worker. A still-live vault is replaced atomically from the control plane's
 * current provider configuration.
 */
export async function ensureProviderCredentialVault(
  vault: ProviderCredentialVault,
  providerBaseUrl: string,
  providerHosts: string[],
  providerApiKey: string,
): Promise<'created' | 'replaced'> {
  const request = providerCredentialVaultRequest(providerBaseUrl, providerHosts, providerApiKey)
  try {
    await vault.create(request)
    return 'created'
  } catch (error) {
    if (httpStatus(error) !== 409) throw error
  }
  await vault.delete()
  await vault.create(request)
  return 'replaced'
}

/**
 * Reattach to the native Agent process when the sandbox container survived a
 * Project VM reboot. OpenSandbox keeps the container and its environment, but
 * background commands launched through execd are not container init children
 * and therefore do not come back with the container itself.
 */
export async function ensureRecoveredWorkerProcess(
  sandbox: Pick<Sandbox, 'commands'>,
  baseUrl: string,
  headers: Record<string, string>,
  probe: WorkerReadyProbe = waitForWorker,
): Promise<'running' | 'restarted'> {
  try {
    await probe(baseUrl, headers, 2_000)
    return 'running'
  } catch {
    const execution = await sandbox.commands.run(
      'exec node /opt/openlink/agent-worker/dist/main.js',
      { background: true, workingDirectory: '/workspace' },
    )
    if (!execution.id) throw new AgentHostError('PROVISIONING_FAILED', 'OpenSandbox did not return an Agent Worker recovery command id')
    await probe(baseUrl, headers, 60_000)
    return 'restarted'
  }
}

export class LocalOpenSandboxBackend {
  private readonly connection: ConnectionConfig

  constructor(private readonly config: LocalOpenSandboxConfig) {
    this.connection = new ConnectionConfig({
      domain: config.domain,
      protocol: 'http',
      apiKey: config.apiKey,
      requestTimeoutSeconds: 120,
    })
  }

  private connectionFor(projectRuntime?: ProjectRuntimeDescriptor): ConnectionConfig {
    if (!projectRuntime) return this.connection
    const endpoint = new URL(projectRuntime.opensandboxEndpoint)
    return new ConnectionConfig({
      domain: endpoint.host,
      protocol: endpoint.protocol === 'https:' ? 'https' : 'http',
      apiKey: projectRuntime.opensandboxApiKey,
      requestTimeoutSeconds: 120,
      useServerProxy: true,
    })
  }

  private leaseFile(userId: string, workspaceId: string, sessionId: string): string {
    return resolve(this.config.storageRoot, '.runtime-leases', userId, workspaceId, `${sessionId}.json`)
  }

  private leaseIdentity(runtimeConfiguration: AgentProviderRuntimeConfiguration, projectId?: string, _browserSession?: BrowserAgentSession, agentOptions?: PromptRuntimeAgentOptions, projectRuntime?: ProjectRuntimeDescriptor, codexPluginRevision?: string): string {
    return JSON.stringify({
      projectId: projectId ?? null,
      providerId: runtimeConfiguration.providerId,
      modelId: runtimeConfiguration.modelId,
      revision: runtimeConfiguration.revision,
      agent: agentOptions?.agent ?? 'pi',
      accessMode: agentOptions?.accessMode ?? 'restricted',
      workerImage: projectRuntime?.agentWorkerImage ?? this.config.image,
      workerRevision: projectRuntime?.agentWorkerRevision ?? null,
      // The projected environment is part of the durable worker identity. A
      // project container cannot consume host-published services through
      // loopback, so leases created before host-gateway projection must never
      // be reattached with their stale environment after an Agent Host restart.
      projectContainerNetworking: projectRuntime ? 'host-gateway+mcp-annotations-v2' : null,
      codexPluginRevision: agentOptions?.agent === 'codex' ? codexPluginRevision ?? null : null,
    })
  }

  private async resolveCodexPluginSnapshot(agentOptions?: PromptRuntimeAgentOptions): Promise<CodexPluginSnapshot | undefined> {
    if (agentOptions?.agent !== 'codex' || !this.config.codexPluginSnapshot) return undefined
    return this.config.codexPluginSnapshot()
  }

  private async materializeCodexPluginSnapshot(
    snapshot: CodexPluginSnapshot | undefined,
    layout: SessionStorageLayout,
    sandbox?: Sandbox,
  ): Promise<void> {
    if (!snapshot) return
    const managedTargets = [
      'codex-home/config.toml',
      'codex-home/plugins/cache',
      'codex-home/.tmp/plugins',
      'codex-home/.tmp/bundled-marketplaces',
      'codex-home/openlink-native',
      'codex-home/openlink-marketplaces',
      'codex-cache/codex-runtimes/codex-primary-runtime/plugins/openai-primary-runtime',
    ]
    if (!sandbox) {
      await Promise.all(managedTargets.map((target) => rm(resolve(layout.root, target), { recursive: true, force: true })))
      await execFileAsync('tar', ['-xzf', snapshot.archivePath, '-C', layout.root], { maxBuffer: 4 * 1024 * 1024 })
      return
    }
    const uploadedArchive = '/openlink/session/.codex-plugin-snapshot.tar.gz'
    await sandbox.files.writeFiles([{
      path: uploadedArchive,
      data: createReadStream(snapshot.archivePath),
      mode: 600,
    }])
    await sandbox.commands.run(
      `rm -rf ${managedTargets.map((target) => `/openlink/session/${target}`).join(' ')} && tar -xzf ${uploadedArchive} -C /openlink/session && rm -f ${uploadedArchive}`,
      { workingDirectory: '/openlink/session' },
    )
  }

  private async persistLease(path: string, lease: DurableRuntimeLease): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const temporary = `${path}.tmp-${process.pid}`
    await writeFile(temporary, `${JSON.stringify(lease)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, path)
  }

  private async runtimeHandle(
    sandbox: Sandbox,
    connection: ConnectionConfig,
    workerToken: string,
    layout: SessionStorageLayout,
    leaseFile: string,
    projectRuntime?: ProjectRuntimeDescriptor,
  ): Promise<OpenSandboxPromptSession> {
    let activeSandbox = sandbox
    let endpoint = await activeSandbox.getEndpoint(43130)
    let baseUrl = workerUrl(connection, endpoint)
    let paused = false
    let cleaned = false
    let cleanupPromise: Promise<void> | undefined
    const networkTimers = new Set<ReturnType<typeof setTimeout>>()
    const ensureRunning = async (): Promise<void> => {
      if (cleaned) throw new AgentHostError('INVALID_SESSION', 'Agent Worker session has been cleaned up', { retryable: true })
      if (!paused) return
      activeSandbox = await activeSandbox.resume({ readyTimeoutSeconds: 180 })
      endpoint = await activeSandbox.getEndpoint(43130)
      baseUrl = workerUrl(connection, endpoint)
      await waitForWorker(baseUrl, endpoint.headers)
      paused = false
    }
    const workerHeaders = () => ({
      ...endpoint.headers,
      'X-OpenLink-Agent-Worker-Token': workerToken,
      Authorization: `Bearer ${workerToken}`,
      'Content-Type': 'application/json',
    })
    return {
      sandboxId: sandbox.id as string,
      layout,
      pause: async () => {
        if (cleaned || paused) return
        await activeSandbox.pause()
        paused = true
      },
      resume: ensureRunning,
      prompt: async (message, signal, attachments) => {
        await ensureRunning()
        return requestWorkerPrompt(baseUrl, workerHeaders(), message, signal, attachments)
      },
      control: async (input) => {
        await ensureRunning()
        const result = await fetch(`${baseUrl}/v1/control`, {
          method: 'POST', headers: workerHeaders(),
          body: JSON.stringify(input),
          signal: AbortSignal.timeout(input.action === 'fork' ? 120_000 : 30_000),
        })
        if (!result.ok) {
          const failure = await result.json().catch(() => null) as { error?: unknown } | null
          if (input.action === 'compact' && typeof failure?.error === 'string'
            && /^(Nothing to compact \(session too small\)|Already compacted)$/.test(failure.error)) {
            return { compacted: false, reason: 'not-needed' }
          }
          throw new AgentHostError('INVALID_BODY', `Agent control rejected (${result.status})`)
        }
        return result.json()
      },
      resolveExtensionUi: async (response) => {
        await ensureRunning()
        const result = await fetch(`${baseUrl}/v1/extension-ui-response`, {
          method: 'POST',
          headers: workerHeaders(),
          body: JSON.stringify(response),
          signal: AbortSignal.timeout(5_000),
        })
        if (!result.ok) throw new AgentHostError('EXTENSION_UI_REQUEST_NOT_FOUND', `Agent Worker rejected extension UI response (${result.status})`, { retryable: true })
      },
      networkAccess: async (hosts, mode, durationSeconds) => {
        await ensureRunning()
        await activeSandbox.patchEgressRules(hosts.map((target) => ({ action: 'allow' as const, target })))
        if (mode === 'temporary') {
          const timer = setTimeout(() => {
            networkTimers.delete(timer)
            void activeSandbox.deleteEgressRules(hosts).catch(() => undefined)
          }, (durationSeconds ?? 900) * 1_000)
          networkTimers.add(timer)
        }
      },
      resources: async (request) => {
        await ensureRunning()
        const params = new URLSearchParams()
        if (request?.scope) params.set('scope', request.scope)
        if (request?.command !== undefined) params.set('command', request.command)
        if (request?.query !== undefined) params.set('query', request.query)
        const suffix = params.size ? `?${params}` : ''
        const result = await fetch(request?.scope === 'title' ? `${baseUrl}/v1/title` : `${baseUrl}/v1/resources${suffix}`, {
          headers: workerHeaders(),
          ...(request?.scope === 'title' ? { method: 'POST', body: JSON.stringify({ message: request.query }) } : {}),
          signal: AbortSignal.timeout(request?.scope === 'title' ? 45_000 : 15_000),
        })
        if (!result.ok) throw new AgentHostError('INVALID_SESSION', `Agent Worker could not read runtime resources (${result.status})`, { retryable: true })
        return result.json()
      },
      setBrowser: async (browserSession) => {
        await ensureRunning()
        const capability = browserSession
          ? browserAgentBinding(browserSession, LOCAL_BROWSER_EXTENSION_PATH, projectRuntime)
          : null
        if (capability) await activeSandbox.patchEgressRules([{ action: 'allow' as const, target: browserHostNetworkTarget(capability.hostUrl) }])
        const result = await fetch(`${baseUrl}/v1/browser-capability`, {
          method: 'PUT',
          headers: workerHeaders(),
          body: JSON.stringify({ capability }),
          signal: AbortSignal.timeout(5_000),
        })
        if (!result.ok) throw new AgentHostError('INVALID_SESSION', `Agent Worker could not update Browser capability (${result.status})`, { retryable: true })
      },
      cleanup: async () => {
        if (cleaned) return
        if (cleanupPromise) return cleanupPromise
        for (const timer of networkTimers) clearTimeout(timer)
        networkTimers.clear()
        cleanupPromise = disposeOpenSandbox(activeSandbox).then(async () => {
          cleaned = true
          await rm(leaseFile, { force: true })
        }).catch((error) => {
          cleanupPromise = undefined
          throw error
        })
        return cleanupPromise
      },
    }
  }

  async recoverSession(userId: string, workspaceId: string, sessionId: string, runtimeConfiguration: AgentProviderRuntimeConfiguration, _nativeSession?: AgentNativeSessionSnapshot, projectId?: string, projectRuntime?: ProjectRuntimeDescriptor, browserSession?: BrowserAgentSession, agentOptions?: PromptRuntimeAgentOptions): Promise<OpenSandboxPromptSession | null> {
    const codexPluginSnapshot = await this.resolveCodexPluginSnapshot(agentOptions)
    const leaseFile = this.leaseFile(userId, workspaceId, sessionId)
    let lease: DurableRuntimeLease
    try {
      lease = JSON.parse(await readFile(leaseFile, 'utf8')) as DurableRuntimeLease
    } catch {
      return null
    }
    if (lease.version !== 1 || lease.identity !== this.leaseIdentity(runtimeConfiguration, projectId, browserSession, agentOptions, projectRuntime, codexPluginSnapshot?.revision) || !lease.sandboxId || !lease.workerToken) {
      // A durable workload's environment cannot be patched in place. Remove
      // the stale session workload before the caller provisions its successor;
      // otherwise every configuration/plugin/network projection change leaks
      // another live Worker into the Project VM.
      await this.cleanupSession(userId, workspaceId, sessionId, projectId, projectRuntime)
      return null
    }
    const connection = this.connectionFor(projectRuntime)
    try {
      let sandbox = await Sandbox.connect({ sandboxId: lease.sandboxId, connectionConfig: connection, skipHealthCheck: true })
      const info = await sandbox.getInfo()
      if (info.status.state === 'Paused' || info.status.state === 'Pausing') {
        sandbox = await sandbox.resume({ readyTimeoutSeconds: 180 })
      } else if (info.status.state !== 'Running' && info.status.state !== 'Resuming') {
        throw new Error(`sandbox is ${info.status.state}`)
      }
      const egressEnabled = projectRuntime?.egressMode !== 'disabled'
      if (egressEnabled && runtimeConfiguration.apiKey) {
        await ensureProviderCredentialVault(
          sandbox.credentialVault,
          runtimeConfiguration.baseUrl,
          providerNetworkTargets(runtimeConfiguration.providerId, runtimeConfiguration.baseUrl),
          runtimeConfiguration.apiKey,
        )
      }
      const endpoint = await sandbox.getEndpoint(43130)
      await ensureRecoveredWorkerProcess(sandbox, workerUrl(connection, endpoint), endpoint.headers ?? {})
      const layout = createSessionStorageLayout(projectRuntime?.sessionStorageRoot ?? this.config.storageRoot, userId, workspaceId, sessionId)
      const runtime = await this.runtimeHandle(sandbox, connection, lease.workerToken, layout, leaseFile, projectRuntime)
      if (browserSession) await runtime.setBrowser(browserSession)
      return runtime
    } catch (error) {
      console.warn(`OpenLink could not reattach Agent sandbox ${lease.sandboxId}: ${error instanceof Error ? error.message : String(error)}`)
      await rm(leaseFile, { force: true }).catch(() => undefined)
      return null
    }
  }

  async cleanupSession(userId: string, workspaceId: string, sessionId: string, projectId?: string, projectRuntime?: ProjectRuntimeDescriptor): Promise<void> {
    const connection = projectRuntime
      ? (() => {
        const endpoint = new URL(projectRuntime.opensandboxEndpoint)
        return {
          domain: endpoint.host,
          protocol: endpoint.protocol === 'https:' ? 'https' as const : 'http' as const,
          apiKey: projectRuntime.opensandboxApiKey,
          useServerProxy: true,
        }
      })()
      : { domain: this.config.domain, protocol: 'http' as const, apiKey: this.config.apiKey }
    await cleanupOpenSandboxSessionWorkloads(connection, {
      'openlink.user_id': userId,
      'openlink.workspace_id': workspaceId,
      'openlink.session_id': sessionId,
      ...(projectId ? { 'openlink.project_id': projectId } : {}),
    })
    await rm(this.leaseFile(userId, workspaceId, sessionId), { force: true })
  }

  async createSession(userId: string, workspaceId: string, sessionId: string, runtimeConfiguration: AgentProviderRuntimeConfiguration, nativeSession?: AgentNativeSessionSnapshot, projectId?: string, projectRuntime?: ProjectRuntimeDescriptor, browserSession?: BrowserAgentSession, agentOptions?: PromptRuntimeAgentOptions): Promise<OpenSandboxPromptSession> {
    const codexPluginSnapshot = await this.resolveCodexPluginSnapshot(agentOptions)
    const layout = createSessionStorageLayout(projectRuntime?.sessionStorageRoot ?? this.config.storageRoot, userId, workspaceId, sessionId)
    // A project runtime path is visible to the Linux VM's Podman daemon, not
    // to this Agent Host process. The OpenSandbox bind mount creates the
    // guest-side session directory; only the legacy process-local backend
    // prepares it directly on the host.
    if (!projectRuntime) {
      await ensureSessionStorage(layout)
      await mkdir(resolve(layout.root, 'worker'), { recursive: true, mode: 0o700 })
      await this.materializeCodexPluginSnapshot(codexPluginSnapshot, layout)
    }
    const nativeSessionFile = resolve(layout.root, 'cloud-session.jsonl')
    if (nativeSession && !projectRuntime) {
      const serialized = [nativeSession.header, ...nativeSession.entries].map((entry) => JSON.stringify(entry)).join('\n') + '\n'
      const temporaryFile = `${nativeSessionFile}.tmp-${process.pid}`
      await writeFile(temporaryFile, serialized, { encoding: 'utf8', mode: 0o600 })
      await rename(temporaryFile, nativeSessionFile)
    }
    const workerToken = randomBytes(32).toString('base64url')
    const providerId = runtimeConfiguration.providerId
    const providerApiKey = runtimeConfiguration.apiKey
    const providerBaseUrl = runtimeConfiguration.baseUrl
    const providerHosts = providerNetworkTargets(providerId, providerBaseUrl)
    const model = `${runtimeConfiguration.providerId}/${runtimeConfiguration.modelId}`
    const browser = browserSession ? browserAgentBinding(browserSession, LOCAL_BROWSER_EXTENSION_PATH, projectRuntime) : undefined
    const browserHost = browser
      ? browserHostNetworkTarget(browser.hostUrl)
      : projectRuntime
        ? browserHostNetworkTarget(projectBrowserHostOrigin(projectRuntime))
        : undefined
    const browserCapabilityFile = resolve(layout.root, 'browser-capability.json')
    const browserCapabilityData = `${JSON.stringify(browser ?? null)}\n`
    if (!projectRuntime && agentOptions?.agent !== 'codex') {
      await writeFile(browserCapabilityFile, browserCapabilityData, { encoding: 'utf8', mode: 0o600 })
    }
    const supabaseMcpUrl = projectId && this.config.supabaseMcp
      ? projectContainerReachableUrl(this.config.supabaseMcp.urlFor(projectId), projectRuntime)
      : undefined
    const projectSupabaseUrl = projectRuntime?.supabase
      ? projectContainerReachableUrl(projectRuntime.supabase.url, projectRuntime)
      : undefined
    // Rootless Podman Machine cannot grant NET_ADMIN to OpenSandbox's egress
    // sidecar. The local capability profile therefore runs the worker in the
    // Project VM without a sidecar, while remote QEMU guests keep the full
    // credential-vault/network-policy path.
    const egressEnabled = projectRuntime?.egressMode !== 'disabled'
    if (projectRuntime && !egressEnabled && !this.config.allowUnsafeRootlessCredentials) {
      throw new AgentHostError(
        'BACKEND_NOT_CONFIGURED',
        'The local Project VM is rootless and cannot enforce OpenSandbox Credential Vault egress. Enable rootful Project VM mode before running a Web Agent session.',
        { retryable: false },
      )
    }
    const connection = this.connectionFor(projectRuntime)
    const sandbox = await Sandbox.create({
      connectionConfig: connection,
      image: projectRuntime?.agentWorkerImage ?? this.config.image,
      timeoutSeconds: this.config.sessionTtlSeconds,
      env: {
        OPENLINK_AGENT_WORKER_TOKEN: workerToken,
        OPENLINK_AGENT_WORKER_HOST: '0.0.0.0',
        OPENLINK_AGENT_WORKER_PORT: '43130',
        OPENLINK_AGENT_WORKSPACE_ROOT: '/workspace',
        OPENLINK_AGENT_SESSION_ROOT: '/openlink/session',
        ...(nativeSession ? { OPENLINK_AGENT_SESSION_FILE: '/openlink/session/cloud-session.jsonl' } : {}),
        ...(egressEnabled ? { NODE_EXTRA_CA_CERTS: '/opt/opensandbox/mitmproxy-ca-cert.pem' } : {}),
        OPENLINK_AGENT_MODEL: model,
        OPENLINK_PROVIDER_ID: providerId,
        OPENLINK_PROVIDER_BASE_URL: providerBaseUrl,
        OPENLINK_AGENT_KIND: agentOptions?.agent === 'codex' ? 'codex' : 'pi',
        ...(agentOptions?.agent === 'codex' ? { XDG_CACHE_HOME: '/openlink/session/codex-cache' } : {}),
        ...(agentOptions?.accessMode ? { OPENLINK_AGENT_ACCESS_MODE: agentOptions.accessMode } : {}),
        ...ambientProviderEnvironment(providerId),
        ...(providerApiKey ? { OPENLINK_PROVIDER_API_KEY: egressEnabled ? providerVaultPlaceholder : providerApiKey } : {}),
        OPENLINK_BROWSER_EXTENSION_PATH: LOCAL_BROWSER_EXTENSION_PATH,
        OPENLINK_BROWSER_CAPABILITY_FILE: '/openlink/session/browser-capability.json',
        ...(projectId && this.config.supabaseMcp && supabaseMcpUrl ? {
          OPENLINK_SUPABASE_EXTENSION_PATH: this.config.supabaseMcp.extensionPath,
          OPENLINK_SUPABASE_MCP_URL: supabaseMcpUrl,
          OPENLINK_SUPABASE_MCP_TOKEN: this.config.supabaseMcp.tokenFor(projectId),
          OPENLINK_SUPABASE_MCP_SESSION_ID: sessionId,
        } : {}),
        // Project-local Supabase backend: publishable connection material only.
        // The service-role key / DB password stay inside the Project VM and are
        // absent from the descriptor, so they cannot be injected here.
        ...(projectRuntime?.supabase && projectSupabaseUrl ? {
          SUPABASE_URL: projectSupabaseUrl,
          SUPABASE_PUBLISHABLE_KEY: projectRuntime.supabase.publishableKey,
          SUPABASE_ANON_KEY: projectRuntime.supabase.anonKey,
          NEXT_PUBLIC_SUPABASE_URL: projectSupabaseUrl,
          NEXT_PUBLIC_SUPABASE_ANON_KEY: projectRuntime.supabase.anonKey,
          NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: projectRuntime.supabase.publishableKey,
        } : {}),
      },
      metadata: {
        'openlink.user_id': userId,
        'openlink.workspace_id': workspaceId,
        'openlink.session_id': sessionId,
        ...(projectId ? { 'openlink.project_id': projectId } : {}),
        ...(browser ? { 'openlink.browser_session_id': browser.sessionId } : {}),
        'openlink.runtime': 'node-sdk',
      },
      // Ask the OpenSandbox Docker provider to grant the narrowly scoped
      // capabilities and mounts required by execd's bubblewrap session
      // isolator. The provider keeps this opt-in per workload and still
      // applies the configured capability drops/limits to the container.
      ...(egressEnabled ? { extensions: { 'bootstrap.execd.isolation': 'enable' } } : {}),
      ...(egressEnabled ? {
        networkPolicy: {
          defaultAction: (this.config.networkDefaultAction ?? 'deny') as 'allow' | 'deny',
          egress: [...providerHosts, browserHost]
            .filter((target): target is string => Boolean(target))
            .map((target) => ({ action: 'allow' as const, target })),
        },
        credentialProxy: { enabled: true },
      } : {}),
      volumes: [
        { name: 'workspace', host: { path: projectRuntime?.workspacePath ?? this.config.workspaceRoot }, mountPath: '/workspace', readOnly: false },
        { name: 'session', host: { path: layout.root }, mountPath: '/openlink/session', readOnly: false },
      ],
      resource: { cpu: '2', memory: '4Gi' },
      readyTimeoutSeconds: 180,
    })

    try {
      if (egressEnabled && providerApiKey) {
        await ensureProviderCredentialVault(sandbox.credentialVault, providerBaseUrl, providerHosts, providerApiKey)
      }
      const endpoint = await sandbox.getEndpoint(43130)
      const baseUrl = workerUrl(connection, endpoint)
      if (projectRuntime) {
        await sandbox.files.createDirectories([
          // execd's bwrap isolation runs the workload as uid 1000 while the
          // OpenSandbox file API creates directories as root.  The worker
          // must be able to append Pi's JSONL session inside this mounted
          // volume; the VM/project path itself remains private and the session
          // file is only exposed inside this sandbox.
          // OpenSandbox's filesystem API represents permissions as octal
          // digits in a decimal JSON number (777/666), not JavaScript's
          // numeric octal literals (0o777/0o666). Passing 0o666 becomes 438
          // on the wire and the execd service rejects it while parsing octal.
          { path: '/openlink/session', mode: 777 },
          { path: '/openlink/session/worker', mode: 777 },
          { path: '/openlink/session/pi-sessions', mode: 777 },
          { path: '/openlink/session/artifacts', mode: 777 },
          { path: '/openlink/session/logs', mode: 777 },
        ])
        if (nativeSession) {
          const serialized = [nativeSession.header, ...nativeSession.entries].map((entry) => JSON.stringify(entry)).join('\n') + '\n'
          // Keep the session payload out of a shell argument. Long Pi sessions
          // can exceed the host/guest ARG_MAX limit after base64 encoding and
          // fail with `argument list too long` before the Worker is launched.
          // The filesystem API streams the content through execd instead.
          await sandbox.files.writeFiles([{
            path: '/openlink/session/cloud-session.jsonl',
            data: serialized,
            // The bind-mounted directory is created by the control plane as
            // root while execd runs the Worker as uid 1000. The Worker must be
            // able to read and append the durable Pi JSONL snapshot.
            mode: 666,
          }])
        }
        await sandbox.files.writeFiles([{
          path: '/openlink/session/browser-capability.json',
          data: browserCapabilityData,
          // The live Worker atomically replaces this capability when a
          // Browser tab connects after Agent warmup.
          mode: 666,
        }])
        await this.materializeCodexPluginSnapshot(codexPluginSnapshot, layout, sandbox)
      }
      const execution = await sandbox.commands.run(
        'exec node /opt/openlink/agent-worker/dist/main.js',
        { background: true, workingDirectory: '/workspace' },
      )
      if (!execution.id) throw new AgentHostError('PROVISIONING_FAILED', 'OpenSandbox did not return an Agent Worker command id')
      await waitForWorker(baseUrl, endpoint.headers)
      const leaseFile = this.leaseFile(userId, workspaceId, sessionId)
      await this.persistLease(leaseFile, {
        version: 1,
        sandboxId: sandbox.id as string,
        workerToken,
        identity: this.leaseIdentity(runtimeConfiguration, projectId, browserSession, agentOptions, projectRuntime, codexPluginSnapshot?.revision),
        updatedAt: new Date().toISOString(),
      })
      return await this.runtimeHandle(sandbox, connection, workerToken, layout, leaseFile, projectRuntime)
    } catch (error) {
      try {
        await disposeOpenSandbox(sandbox)
      } catch (cleanupError) {
        console.error(`OpenLink OpenSandbox provisioning cleanup failed for ${sandbox.id}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`)
      }
      throw new AgentHostError('PROVISIONING_FAILED', error instanceof Error ? error.message : String(error))
    }
  }

  async close(): Promise<void> {
    await this.connection.closeTransport()
  }
}
