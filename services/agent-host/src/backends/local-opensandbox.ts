import { ConnectionConfig, Sandbox, type Endpoint } from '@alibaba-group/opensandbox'
import { randomBytes } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { AgentHostError } from '../errors.js'
import type { AgentNativeSessionSnapshot, AgentProviderRuntimeConfiguration } from '../contracts.js'
import { createSessionStorageLayout, ensureSessionStorage, type SessionStorageLayout } from '../storage.js'

export interface LocalOpenSandboxConfig {
  domain: string
  apiKey: string
  image: string
  workspaceRoot: string
  storageRoot: string
  model?: string
  geminiApiKey?: string
  geminiBaseUrl?: string
  sessionTtlSeconds: number
}

export interface OpenSandboxPromptSession {
  readonly sandboxId: string
  readonly layout: SessionStorageLayout
  prompt(message: string, signal?: AbortSignal): Promise<Response>
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

  async createSession(userId: string, workspaceId: string, sessionId: string, runtimeConfiguration?: AgentProviderRuntimeConfiguration, nativeSession?: AgentNativeSessionSnapshot, projectId?: string): Promise<OpenSandboxPromptSession> {
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
    const workerToken = randomBytes(32).toString('base64url')
    const providerId = runtimeConfiguration?.providerId ?? (this.config.geminiApiKey ? 'google' : undefined)
    const providerApiKey = runtimeConfiguration?.apiKey ?? this.config.geminiApiKey
    const providerBaseUrl = runtimeConfiguration?.baseUrl ?? this.config.geminiBaseUrl ?? 'https://generativelanguage.googleapis.com/v1beta'
    const providerUrl = new URL(providerBaseUrl)
    const providerHost = providerUrl.hostname
    const model = runtimeConfiguration ? `${runtimeConfiguration.providerId}/${runtimeConfiguration.modelId}` : this.config.model
    const vaultPlaceholder = 'openlink-provider-vault-placeholder'
    const sandbox = await Sandbox.create({
      connectionConfig: this.connection,
      image: this.config.image,
      timeoutSeconds: this.config.sessionTtlSeconds,
      env: {
        OPENLINK_AGENT_WORKER_TOKEN: workerToken,
        OPENLINK_AGENT_WORKER_HOST: '0.0.0.0',
        OPENLINK_AGENT_WORKER_PORT: '43130',
        OPENLINK_AGENT_WORKSPACE_ROOT: '/workspace',
        OPENLINK_AGENT_SESSION_ROOT: '/openlink/session',
        ...(nativeSession ? { OPENLINK_AGENT_SESSION_FILE: '/openlink/session/cloud-session.jsonl' } : {}),
        NODE_EXTRA_CA_CERTS: '/opt/opensandbox/mitmproxy-ca-cert.pem',
        ...(model ? { OPENLINK_AGENT_MODEL: model } : {}),
        ...(providerId ? { OPENLINK_PROVIDER_ID: providerId } : {}),
        ...(providerBaseUrl ? { OPENLINK_PROVIDER_BASE_URL: providerBaseUrl } : {}),
        ...(providerApiKey ? { OPENLINK_PROVIDER_API_KEY: vaultPlaceholder } : {}),
      },
      metadata: {
        'openlink.user_id': userId,
        'openlink.workspace_id': workspaceId,
        'openlink.session_id': sessionId,
        ...(projectId ? { 'openlink.project_id': projectId } : {}),
        'openlink.runtime': 'node-sdk',
      },
      networkPolicy: {
        defaultAction: 'deny',
        egress: [{ action: 'allow', target: providerHost }],
      },
      credentialProxy: { enabled: Boolean(providerApiKey) },
      volumes: [
        { name: 'workspace', host: { path: this.config.workspaceRoot }, mountPath: '/workspace', readOnly: false },
        { name: 'session', host: { path: layout.root }, mountPath: '/openlink/session', readOnly: false },
      ],
      resource: { cpu: '2', memory: '4Gi' },
      readyTimeoutSeconds: 180,
    })

    try {
      if (providerApiKey) {
        await sandbox.credentialVault.create({
          credentials: [{ name: 'provider-api-key', source: { type: 'inline', value: providerApiKey } }],
          bindings: [{
            name: 'provider-api',
            match: { schemes: [providerUrl.protocol === 'http:' ? 'http' : 'https'], hosts: [providerHost] },
            auth: {
              type: 'passthrough',
              substitutions: [{ credential: 'provider-api-key', placeholder: vaultPlaceholder, in: ['header'] }],
            },
          }],
        })
      }
      const endpoint = await sandbox.getEndpoint(43130)
      const baseUrl = workerUrl(this.connection, endpoint)
      const execution = await sandbox.commands.run(
        'exec node /opt/openlink/agent-worker/dist/main.js',
        { background: true, workingDirectory: '/workspace' },
      )
      if (!execution.id) throw new AgentHostError('PROVISIONING_FAILED', 'OpenSandbox did not return an Agent Worker command id')
      await waitForWorker(baseUrl, endpoint.headers)
      let cleaned = false
      return {
        sandboxId: sandbox.id as string,
        layout,
        prompt: (message, signal) => fetch(`${baseUrl}/v1/events`, {
          method: 'POST',
          headers: { ...endpoint.headers, Authorization: `Bearer ${workerToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ message }),
          signal,
        }),
        cleanup: async () => {
          if (cleaned) return
          cleaned = true
          await Promise.allSettled([sandbox.kill(), sandbox.close()])
        },
      }
    } catch (error) {
      await Promise.allSettled([sandbox.kill(), sandbox.close()])
      throw new AgentHostError('PROVISIONING_FAILED', error instanceof Error ? error.message : String(error))
    }
  }

  async close(): Promise<void> {
    await this.connection.closeTransport()
  }
}
