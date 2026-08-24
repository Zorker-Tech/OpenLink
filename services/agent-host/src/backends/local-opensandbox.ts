import { ConnectionConfig, Sandbox, type Endpoint } from '@alibaba-group/opensandbox'
import { randomBytes } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { AgentHostError } from '../errors.js'
import type { AgentExtensionUiResponse, AgentNativeSessionSnapshot, AgentProviderRuntimeConfiguration } from '../contracts.js'
import type { BrowserAgentSession } from '../browser-client.js'
import { browserAgentBinding, browserHostNetworkTarget, LOCAL_BROWSER_EXTENSION_PATH } from '../browser-binding.js'
import type { ProjectRuntimeDescriptor } from '../project-runtime.js'
import { createSessionStorageLayout, ensureSessionStorage, type SessionStorageLayout } from '../storage.js'
import { disposeOpenSandbox } from './sandbox-cleanup.js'
import { cleanupOpenSandboxSessionWorkloads } from './opensandbox-recovery.js'
import { ambientProviderEnvironment, providerNetworkTargets } from '../provider-environment.js'

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
}

export interface OpenSandboxPromptSession {
  readonly sandboxId: string
  readonly layout: SessionStorageLayout
  pause(): Promise<void>
  resume(): Promise<void>
  prompt(message: string, signal?: AbortSignal): Promise<Response>
  resolveExtensionUi(response: AgentExtensionUiResponse): Promise<void>
  networkAccess(hosts: string[], mode: 'temporary' | 'persistent', durationSeconds?: number): Promise<void>
  cleanup(): Promise<void>
}

function workerUrl(config: ConnectionConfig, endpoint: Endpoint): string {
  return `${config.protocol}://${endpoint.endpoint}`
}

async function waitForWorker(baseUrl: string, headers: Record<string, string> = {}, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/healthz`, {
        headers,
        signal: AbortSignal.timeout(2_000),
      })
      if (response.ok) return
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
  }

  async createSession(userId: string, workspaceId: string, sessionId: string, runtimeConfiguration: AgentProviderRuntimeConfiguration, nativeSession?: AgentNativeSessionSnapshot, projectId?: string, projectRuntime?: ProjectRuntimeDescriptor, browserSession?: BrowserAgentSession): Promise<OpenSandboxPromptSession> {
    const layout = createSessionStorageLayout(projectRuntime?.sessionStorageRoot ?? this.config.storageRoot, userId, workspaceId, sessionId)
    // A project runtime path is visible to the Linux VM's Podman daemon, not
    // to this Agent Host process. The OpenSandbox bind mount creates the
    // guest-side session directory; only the legacy process-local backend
    // prepares it directly on the host.
    if (!projectRuntime) {
      await ensureSessionStorage(layout)
      await mkdir(resolve(layout.root, 'worker'), { recursive: true, mode: 0o700 })
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
    const providerUrl = new URL(providerBaseUrl)
    const providerHosts = providerNetworkTargets(providerId, providerBaseUrl)
    const model = `${runtimeConfiguration.providerId}/${runtimeConfiguration.modelId}`
    const browser = browserSession ? browserAgentBinding(browserSession, LOCAL_BROWSER_EXTENSION_PATH, projectRuntime) : undefined
    const browserHost = browser ? browserHostNetworkTarget(browser.hostUrl) : undefined
    const vaultPlaceholder = 'openlink-provider-vault-placeholder'
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
    const connection = projectRuntime
      ? (() => {
        const endpoint = new URL(projectRuntime.opensandboxEndpoint)
        return new ConnectionConfig({
          domain: endpoint.host,
          protocol: endpoint.protocol === 'https:' ? 'https' : 'http',
          apiKey: projectRuntime.opensandboxApiKey,
          requestTimeoutSeconds: 120,
          // Session sandbox ports live inside the Project VM. Route worker
          // calls through the in-VM OpenSandbox control plane instead of
          // trying to reach 127.0.0.1 on the host process.
          useServerProxy: true,
        })
      })()
      : this.connection
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
        ...ambientProviderEnvironment(providerId),
        ...(providerApiKey ? { OPENLINK_PROVIDER_API_KEY: egressEnabled ? vaultPlaceholder : providerApiKey } : {}),
        ...(browser ? {
          OPENLINK_BROWSER_HOST_URL: browser.hostUrl,
          OPENLINK_BROWSER_SESSION_ID: browser.sessionId,
          OPENLINK_BROWSER_CONTROL_TOKEN: browser.controlToken,
          OPENLINK_BROWSER_EXTENSION_PATH: browser.extensionPath,
        } : {}),
        // Project-local Supabase backend: publishable connection material only.
        // The service-role key / DB password stay inside the Project VM and are
        // absent from the descriptor, so they cannot be injected here.
        ...(projectRuntime?.supabase ? {
          SUPABASE_URL: projectRuntime.supabase.url,
          SUPABASE_PUBLISHABLE_KEY: projectRuntime.supabase.publishableKey,
          SUPABASE_ANON_KEY: projectRuntime.supabase.anonKey,
          NEXT_PUBLIC_SUPABASE_URL: projectRuntime.supabase.url,
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
        await sandbox.credentialVault.create({
          credentials: [{ name: 'provider-api-key', source: { type: 'inline', value: providerApiKey } }],
          bindings: [{
            name: 'provider-api',
            match: { schemes: [providerUrl.protocol === 'http:' ? 'http' : 'https'], hosts: providerHosts },
            auth: {
              type: 'passthrough',
              substitutions: [{ credential: 'provider-api-key', placeholder: vaultPlaceholder, in: ['header'] }],
            },
          }],
        })
      }
      let activeSandbox: Sandbox = sandbox
      let endpoint = await activeSandbox.getEndpoint(43130)
      let baseUrl = workerUrl(connection, endpoint)
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
      }
      const execution = await sandbox.commands.run(
        'exec node /opt/openlink/agent-worker/dist/main.js',
        { background: true, workingDirectory: '/workspace' },
      )
      if (!execution.id) throw new AgentHostError('PROVISIONING_FAILED', 'OpenSandbox did not return an Agent Worker command id')
      await waitForWorker(baseUrl, endpoint.headers)
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
      return {
        sandboxId: sandbox.id as string,
        layout,
        pause: async () => {
          if (cleaned || paused) return
          await activeSandbox.pause()
          paused = true
        },
        resume: ensureRunning,
        prompt: async (message, signal) => {
          await ensureRunning()
          const headers = {
            ...endpoint.headers,
            // Authorization is reserved by OpenSandbox's server-proxy for
            // control-plane auth and is stripped before forwarding. Keep the
            // worker capability in a dedicated header that the proxy passes
            // through to the session container.
            'X-OpenLink-Agent-Worker-Token': workerToken,
            Authorization: `Bearer ${workerToken}`,
            'Content-Type': 'application/json',
          }
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
          await ensureRunning()
          const headers = {
            ...endpoint.headers,
            'X-OpenLink-Agent-Worker-Token': workerToken,
            Authorization: `Bearer ${workerToken}`,
            'Content-Type': 'application/json',
          }
          const result = await fetch(`${baseUrl}/v1/extension-ui-response`, {
            method: 'POST',
            headers,
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
        cleanup: async () => {
          if (cleaned) return
          if (cleanupPromise) return cleanupPromise
          for (const timer of networkTimers) clearTimeout(timer)
          networkTimers.clear()
          cleanupPromise = disposeOpenSandbox(activeSandbox).then(() => {
            cleaned = true
          }).catch((error) => {
            // A failed DELETE/close must remain retryable. Marking this
            // workload as cleaned before the operation succeeds makes the
            // next recovery silently skip cleanup and leak the sandbox.
            cleanupPromise = undefined
            throw error
          })
          return cleanupPromise
        },
      }
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
