import { ConnectionConfig, Sandbox, type Endpoint } from '@alibaba-group/opensandbox'
import { randomBytes } from 'node:crypto'
import type { AgentLaunchSpec, AgentNativeSessionSnapshot, AgentProcess, AgentProviderRuntimeConfiguration, ProvisionedEnvironment, SandboxBackend } from '../contracts.js'
import { AgentHostError } from '../errors.js'
import { buildPiRpcCommand, type CommandSpec } from '../pi-rpc.js'
import { buildRemoteBootstrapPlan, type RemoteBootstrapPlan, type SshTarget } from '../ssh.js'

export interface RemoteOpenSandboxAdapter {
  createSandbox(spec: AgentLaunchSpec, command: CommandSpec): Promise<{ id: string }>
  launchPi(sandboxId: string, command: CommandSpec): Promise<AgentProcess>
  deleteSandbox(sandboxId: string): Promise<void>
}

export interface RemoteRelease {
  id: string
  bundleSha256: string
  bundlePath?: string
  checksumPath?: string
  secretsPath?: string
}

export interface RemoteOpenSandboxRpcConfig {
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

export interface RemoteRpcPromptSession {
  readonly sandboxId: string
  prompt(message: string, signal?: AbortSignal): Promise<Response>
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

  async createSession(userId: string, workspaceId: string, sessionId: string, runtimeConfiguration?: AgentProviderRuntimeConfiguration, nativeSession?: AgentNativeSessionSnapshot, projectId?: string): Promise<RemoteRpcPromptSession> {
    const workerToken = randomBytes(32).toString('base64url')
    const providerId = runtimeConfiguration?.providerId ?? (this.config.geminiApiKey ? 'google' : undefined)
    const providerApiKey = runtimeConfiguration?.apiKey ?? this.config.geminiApiKey
    const providerBaseUrl = runtimeConfiguration?.baseUrl ?? this.config.geminiBaseUrl ?? 'https://generativelanguage.googleapis.com/v1beta'
    const providerUrl = new URL(providerBaseUrl)
    const providerHost = providerUrl.hostname
    const model = runtimeConfiguration ? `${runtimeConfiguration.providerId}/${runtimeConfiguration.modelId}` : this.config.model
    const vaultPlaceholder = 'openlink-provider-vault-placeholder'
    const sessionRoot = `${this.config.storageRoot}/${userId}/${workspaceId}/${sessionId}`
    const sandbox = await Sandbox.create({
      connectionConfig: this.connection,
      image: this.config.image,
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
        'openlink.runtime': 'pi-cli-rpc',
      },
      networkPolicy: { defaultAction: 'deny', egress: [{ action: 'allow', target: providerHost }] },
      credentialProxy: { enabled: Boolean(providerApiKey) },
      volumes: [
        { name: 'workspace', host: { path: this.config.workspaceRoot }, mountPath: '/workspace', readOnly: false },
        { name: 'session', host: { path: sessionRoot }, mountPath: '/openlink/session', readOnly: false },
      ],
      resource: { cpu: '2', memory: '4Gi' },
      readyTimeoutSeconds: 180,
    })
    try {
      if (nativeSession) {
        const serialized = [nativeSession.header, ...nativeSession.entries].map((entry) => JSON.stringify(entry)).join('\n') + '\n'
        await sandbox.files.createDirectories([{ path: '/openlink/session/pi-sessions', mode: 0o700 }])
        await sandbox.files.writeFiles([{ path: '/openlink/session/pi-sessions/cloud-session.jsonl', data: serialized, mode: 0o600 }])
      }
      if (providerApiKey) {
        await sandbox.credentialVault.create({
          credentials: [{ name: 'provider-api-key', source: { type: 'inline', value: providerApiKey } }],
          bindings: [{
            name: 'provider-api',
            match: { schemes: [providerUrl.protocol === 'http:' ? 'http' : 'https'], hosts: [providerHost] },
            auth: { type: 'passthrough', substitutions: [{ credential: 'provider-api-key', placeholder: vaultPlaceholder, in: ['header'] }] },
          }],
        })
      }
      const endpoint = await sandbox.getEndpoint(43131)
      const baseUrl = endpointUrl(this.connection, endpoint)
      const execution = await sandbox.commands.run('exec node /opt/openlink/agent-rpc-worker/dist/main.js', { background: true, workingDirectory: '/workspace' })
      if (!execution.id) throw new AgentHostError('PROVISIONING_FAILED', 'OpenSandbox did not return an RPC Worker command id')
      await waitForRpcWorker(baseUrl, endpoint.headers)
      let cleaned = false
      return {
        sandboxId: sandbox.id as string,
        prompt: (message, signal) => fetch(`${baseUrl}/v1/events`, {
          method: 'POST',
          headers: { ...endpoint.headers, 'X-OpenLink-Agent-Token': workerToken, 'Content-Type': 'application/json' },
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

  close(): Promise<void> {
    return this.connection.closeTransport()
  }
}

export class RemoteOpenSandboxBackend implements SandboxBackend {
  readonly runtime = 'remote-opensandbox' as const
  readonly bootstrapPlan: RemoteBootstrapPlan

  constructor(
    target: SshTarget,
    release: RemoteRelease,
    private readonly adapter?: RemoteOpenSandboxAdapter,
  ) {
    this.bootstrapPlan = buildRemoteBootstrapPlan(target, release.id, release.bundleSha256, {
      bundle: release.bundlePath ?? 'openlink-agent-bundle.tar.gz',
      checksum: release.checksumPath ?? 'bundle.sha256',
      secrets: release.secretsPath ?? 'runtime.env',
    })
  }

  async provision(spec: AgentLaunchSpec): Promise<ProvisionedEnvironment> {
    if (!this.adapter) {
      throw new AgentHostError(
        'BACKEND_NOT_CONFIGURED',
        'OpenSandbox adapter is not configured; review and approve the SSH bootstrap plan first',
      )
    }
    const command = buildPiRpcCommand({
      entrypoint: spec.piEntrypoint,
      cwd: spec.workspaceRoot,
      sessionDir: spec.sessionDir,
      sessionId: spec.sessionId,
      model: spec.model,
      environment: spec.environment,
      browser: spec.browser,
    })
    const sandbox = await this.adapter.createSandbox(spec, command)
    return {
      runtime: this.runtime,
      workspaceRoot: spec.workspaceRoot,
      storageRoot: spec.storageRoot,
      launchPi: (launchSpec) => this.adapter!.launchPi(sandbox.id, buildPiRpcCommand({
        entrypoint: launchSpec.piEntrypoint,
        cwd: launchSpec.workspaceRoot,
        sessionDir: launchSpec.sessionDir,
        sessionId: launchSpec.sessionId,
        model: launchSpec.model,
        environment: launchSpec.environment,
        browser: launchSpec.browser,
      })),
      cleanup: () => this.adapter!.deleteSandbox(sandbox.id),
    }
  }
}
