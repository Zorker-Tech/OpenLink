import { ConnectionConfig, Sandbox, type Endpoint } from '@alibaba-group/opensandbox'
import { randomBytes } from 'node:crypto'
import type { AgentExtensionUiResponse, AgentNativeSessionSnapshot, AgentProviderRuntimeConfiguration } from '../contracts.js'
import type { BrowserAgentSession } from '../browser-client.js'
import { browserAgentBinding, browserHostNetworkTarget, REMOTE_BROWSER_EXTENSION_PATH } from '../browser-binding.js'
import { AgentHostError } from '../errors.js'
import type { ProjectRuntimeDescriptor } from '../project-runtime.js'
import { disposeOpenSandbox } from './sandbox-cleanup.js'
import { cleanupOpenSandboxSessionWorkloads } from './opensandbox-recovery.js'
import { ambientProviderEnvironment, providerNetworkTargets } from '../provider-environment.js'

export interface RemoteOpenSandboxRpcConfig {
  domain: string
  apiKey: string
  image: string
  workspaceRoot: string
  storageRoot: string
  /** OpenSandbox workload lifetime. `null` delegates cleanup to Agent Host. */
  sessionTtlSeconds: number | null
  /** Outbound policy selected by the remote approval controller. */
  networkDefaultAction?: 'allow' | 'deny'
}

export interface RemoteRpcPromptSession {
  readonly sandboxId: string
  pause(): Promise<void>
  resume(): Promise<void>
  prompt(message: string, signal?: AbortSignal): Promise<Response>
  resolveExtensionUi(response: AgentExtensionUiResponse): Promise<void>
  networkAccess(hosts: string[], mode: 'temporary' | 'persistent', durationSeconds?: number): Promise<void>
  cleanup(): Promise<void>
}

function endpointUrl(connection: ConnectionConfig, endpoint: Endpoint): string {
  return `${connection.protocol}://${endpoint.endpoint}`
}

async function waitForRpcWorker(baseUrl: string, headers: Record<string, string> = {}): Promise<void> {
  const deadline = Date.now() + 60_000
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/healthz`, { headers, signal: AbortSignal.timeout(2_000) })
      if (response.ok) return
      lastError = new Error(`RPC Worker health check returned HTTP ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200))
  }
  throw new AgentHostError('PROVISIONING_FAILED', `RPC Worker did not become ready: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
}

function remoteSegment(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new AgentHostError('INVALID_BODY', `${label} is invalid`)
  }
  return value
}

/**
 * Workload transport used after the SSH control-plane tunnel is established.
 * `useServerProxy` keeps all execd and worker traffic inside that single tunnel.
 */
export class RemoteOpenSandboxRpcBackend {
  private readonly connection: ConnectionConfig

  constructor(private readonly config: RemoteOpenSandboxRpcConfig) {
    this.connection = new ConnectionConfig({
      domain: config.domain,
      protocol: 'http',
      apiKey: config.apiKey,
      requestTimeoutSeconds: 120,
      useServerProxy: true,
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
      : { domain: this.config.domain, protocol: 'http' as const, apiKey: this.config.apiKey, useServerProxy: true }
    await cleanupOpenSandboxSessionWorkloads(connection, {
      'openlink.user_id': userId,
      'openlink.workspace_id': workspaceId,
      'openlink.session_id': sessionId,
      ...(projectId ? { 'openlink.project_id': projectId } : {}),
    })
  }

  async createSession(userId: string, workspaceId: string, sessionId: string, runtimeConfiguration: AgentProviderRuntimeConfiguration, nativeSession?: AgentNativeSessionSnapshot, projectId?: string, projectRuntime?: ProjectRuntimeDescriptor, browserSession?: BrowserAgentSession): Promise<RemoteRpcPromptSession> {
    const scopedProject = projectId ? remoteSegment(projectId, 'projectId') : 'draft'
    const scopedUser = remoteSegment(userId, 'userId')
    const scopedWorkspace = remoteSegment(workspaceId, 'workspaceId')
    const scopedSession = remoteSegment(sessionId, 'sessionId')
    const workerToken = randomBytes(32).toString('base64url')
    const providerId = runtimeConfiguration.providerId
    const providerApiKey = runtimeConfiguration.apiKey
    const providerBaseUrl = runtimeConfiguration.baseUrl
    const providerUrl = new URL(providerBaseUrl)
    const providerHosts = providerNetworkTargets(providerId, providerBaseUrl)
    const model = `${runtimeConfiguration.providerId}/${runtimeConfiguration.modelId}`
    const browser = browserSession ? browserAgentBinding(browserSession, REMOTE_BROWSER_EXTENSION_PATH, projectRuntime) : undefined
    const browserHost = browser ? browserHostNetworkTarget(browser.hostUrl) : undefined
    const vaultPlaceholder = 'openlink-provider-vault-placeholder'
    // A remote Project Runtime points at the OpenSandbox endpoint forwarded
    // from that Project VM. Legacy mode keeps an explicit namespace only for
    // compatibility with the transitional shared control plane.
    const projectWorkspaceRoot = projectRuntime?.workspacePath ?? (this.config.workspaceRoot + '/' + scopedProject)
    const sessionRoot = projectRuntime
      ? (projectRuntime.sessionStorageRoot + '/' + scopedUser + '/' + scopedWorkspace + '/' + scopedSession)
      : (this.config.storageRoot + '/' + scopedProject + '/' + scopedUser + '/' + scopedWorkspace + '/' + scopedSession)
    const connection = projectRuntime
      ? (() => {
        const endpoint = new URL(projectRuntime.opensandboxEndpoint)
        return new ConnectionConfig({
          domain: endpoint.host,
          protocol: endpoint.protocol === 'https:' ? 'https' : 'http',
          apiKey: projectRuntime.opensandboxApiKey,
          requestTimeoutSeconds: 120,
          useServerProxy: true,
        })
      })()
      : this.connection
    const sandbox = await Sandbox.create({
      connectionConfig: connection,
      image: projectRuntime?.agentRpcWorkerImage ?? this.config.image,
      timeoutSeconds: this.config.sessionTtlSeconds,
      env: {
        OPENLINK_AGENT_RPC_TOKEN: workerToken,
        OPENLINK_AGENT_RPC_HOST: '0.0.0.0',
        OPENLINK_AGENT_RPC_PORT: '43131',
        OPENLINK_AGENT_WORKSPACE_ROOT: '/workspace',
        OPENLINK_AGENT_SESSION_ROOT: '/openlink/session',
        OPENLINK_AGENT_SESSION_ID: sessionId,
        ...(nativeSession ? { OPENLINK_AGENT_SESSION_FILE: '/openlink/session/pi-sessions/cloud-session.jsonl' } : {}),
        NODE_EXTRA_CA_CERTS: '/opt/opensandbox/mitmproxy-ca-cert.pem',
        OPENLINK_AGENT_MODEL: model,
        OPENLINK_PROVIDER_ID: providerId,
        OPENLINK_PROVIDER_BASE_URL: providerBaseUrl,
        ...ambientProviderEnvironment(providerId),
        ...(providerApiKey ? { OPENLINK_PROVIDER_API_KEY: vaultPlaceholder } : {}),
        ...(browser ? {
          OPENLINK_BROWSER_HOST_URL: browser.hostUrl,
          OPENLINK_BROWSER_SESSION_ID: browser.sessionId,
          OPENLINK_BROWSER_CONTROL_TOKEN: browser.controlToken,
          OPENLINK_BROWSER_EXTENSION_PATH: browser.extensionPath,
        } : {}),
        // Project-local Supabase backend: inject only the safe, publishable
        // connection material so the generated app and the Agent worker can
        // reach Auth/REST/Realtime/Storage. Service-role keys and the DB
        // password never leave the Project VM and are not placed on the
        // descriptor, so they cannot leak through this env block.
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
        'openlink.user_id': scopedUser,
        'openlink.workspace_id': scopedWorkspace,
        'openlink.session_id': scopedSession,
        'openlink.project_id': scopedProject,
        ...(browser ? { 'openlink.browser_session_id': browser.sessionId } : {}),
        'openlink.runtime': 'pi-cli-rpc',
      },
      // Enable OpenSandbox's per-command bubblewrap isolation inside the
      // Podman workload. The server applies CAP_SYS_ADMIN/seccomp/AppArmor
      // only for this explicit extension and keeps the control plane private
      // behind the SSH tunnel.
      extensions: { 'bootstrap.execd.isolation': 'enable' },
      networkPolicy: {
        defaultAction: this.config.networkDefaultAction ?? 'deny',
        egress: [...providerHosts, browserHost]
          .filter((target): target is string => Boolean(target))
          .map((target) => ({ action: 'allow' as const, target })),
      },
      credentialProxy: { enabled: true },
      volumes: [
        { name: 'workspace', host: { path: projectWorkspaceRoot }, mountPath: '/workspace', readOnly: false },
        { name: 'session', host: { path: sessionRoot }, mountPath: '/openlink/session', readOnly: false },
      ],
      resource: { cpu: '2', memory: '4Gi' },
      readyTimeoutSeconds: 180,
    })
    try {
      if (nativeSession) {
        const serialized = [nativeSession.header, ...nativeSession.entries].map((entry) => JSON.stringify(entry)).join('\n') + '\n'
        // execd runs the worker as uid 1000, while the OpenSandbox file API
        // creates this directory as root.  Keep the mounted session volume
        // writable for Pi's JSONL append path; the backing project VM path is
        // private to the project and the file is only exposed inside this sandbox.
        // OpenSandbox's filesystem API expects octal digits in a decimal JSON
        // number (777/666). JavaScript's 0o777/0o666 literals become 511/438
        // and are rejected by execd's octal parser.
        await sandbox.files.createDirectories([{ path: '/openlink/session/pi-sessions', mode: 777 }])
        // Upload through execd's filesystem API instead of embedding the
        // entire JSONL in a shell argument. A long Cloud session can exceed
        // ARG_MAX after base64 encoding and prevent the Worker from starting.
        await sandbox.files.writeFiles([{
          path: '/openlink/session/pi-sessions/cloud-session.jsonl',
          data: serialized,
          mode: 666,
        }])
      }
      if (providerApiKey) await sandbox.credentialVault.create({
        credentials: [{ name: 'provider-api-key', source: { type: 'inline', value: providerApiKey } }],
        bindings: [{
          name: 'provider-api',
          match: { schemes: [providerUrl.protocol === 'http:' ? 'http' : 'https'], hosts: providerHosts },
          auth: { type: 'passthrough', substitutions: [{ credential: 'provider-api-key', placeholder: vaultPlaceholder, in: ['header'] }] },
        }],
      })
      let activeSandbox: Sandbox = sandbox
      let endpoint = await activeSandbox.getEndpoint(43131)
      let baseUrl = endpointUrl(connection, endpoint)
      const execution = await sandbox.commands.run('exec node /opt/openlink/agent-rpc-worker/dist/main.js', { background: true, workingDirectory: '/workspace' })
      if (!execution.id) throw new AgentHostError('PROVISIONING_FAILED', 'OpenSandbox did not return an RPC Worker command id')
      await waitForRpcWorker(baseUrl, endpoint.headers)
      let paused = false
      let cleaned = false
      let cleanupPromise: Promise<void> | undefined
      const networkTimers = new Set<ReturnType<typeof setTimeout>>()
      const ensureRunning = async (): Promise<void> => {
        if (cleaned) throw new AgentHostError('INVALID_SESSION', 'Agent Worker session has been cleaned up', { retryable: true })
        if (!paused) return
        activeSandbox = await activeSandbox.resume({ readyTimeoutSeconds: 180 })
        endpoint = await activeSandbox.getEndpoint(43131)
        baseUrl = endpointUrl(connection, endpoint)
        await waitForRpcWorker(baseUrl, endpoint.headers)
        paused = false
      }
      return {
        sandboxId: sandbox.id as string,
        pause: async () => {
          if (cleaned || paused) return
          await activeSandbox.pause()
          paused = true
        },
        resume: ensureRunning,
        prompt: async (message, signal) => {
          await ensureRunning()
          const headers = { ...endpoint.headers, 'X-OpenLink-Agent-Token': workerToken, 'Content-Type': 'application/json' }
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
            'X-OpenLink-Agent-Token': workerToken,
            'Content-Type': 'application/json',
          }
          const result = await fetch(`${baseUrl}/v1/extension-ui-response`, {
            method: 'POST',
            headers,
            body: JSON.stringify(response),
            signal: AbortSignal.timeout(5_000),
          })
          if (!result.ok) {
            throw new AgentHostError(
              'EXTENSION_UI_REQUEST_NOT_FOUND',
              `RPC Worker rejected extension UI response (${result.status})`,
              { retryable: true },
            )
          }
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
        console.error(`OpenLink remote OpenSandbox provisioning cleanup failed for ${sandbox.id}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`)
      }
      throw new AgentHostError('PROVISIONING_FAILED', error instanceof Error ? error.message : String(error))
    }
  }

  close(): Promise<void> {
    return this.connection.closeTransport()
  }
}
