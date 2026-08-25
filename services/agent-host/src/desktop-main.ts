import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import { resolve } from 'node:path'
import { DesktopSandboxRuntimeNodeBackend } from './backends/local-sandbox-runtime-sdk.js'
import { startPromptHttpServer } from './prompt-http-server.js'
import { mintSupabaseMcpToken } from './supabase-mcp.js'
import { createAccessModeResolver } from './access-mode-resolver.js'

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim()
  if (!value) throw new Error(`${key} is required`)
  return value
}

function integer(value: string | undefined, fallback: number, min: number, max: number): number {
  if (!value) return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new Error('Desktop Agent Host numeric configuration is invalid')
  return parsed
}

function list(value: string | undefined): string[] {
  return value?.split(',').map((item) => item.trim()).filter(Boolean) ?? []
}

function origins(value: string | undefined): string[] {
  const result = value?.split(',').map((item) => item.trim()).filter(Boolean) ?? ['http://localhost:3000']
  for (const origin of result) {
    const url = new URL(origin)
    if (url.origin !== origin || !['http:', 'https:'].includes(url.protocol)) throw new Error('Desktop Browser gateway origin is invalid')
  }
  return result
}

const env = process.env
const supabaseAccessResolver = createAccessModeResolver(env)
const host = env.OPENLINK_DESKTOP_AGENT_HOST || '127.0.0.1'
const port = integer(env.OPENLINK_DESKTOP_AGENT_PORT, 43123, 1, 65_535)
const apiToken = required(env, 'OPENLINK_DESKTOP_AGENT_API_TOKEN')
const workspaceRoot = resolve(env.OPENLINK_AGENT_WORKSPACE_ROOT || process.cwd())
const storageRoot = resolve(env.OPENLINK_DESKTOP_AGENT_STORAGE_ROOT || '.agent-data/desktop')
const sessionIdleTtlMs = integer(env.OPENLINK_AGENT_SESSION_IDLE_TTL_MS, 30 * 60_000, 60_000, 24 * 60 * 60_000)
// sandbox-runtime's SandboxManager is process-global (proxy, credential
// sentinel registry and filesystem session). A desktop host process can
// therefore own exactly one active agent session; additional sessions must be
// handled by another desktop host process rather than sharing/resetting the
// same manager.
const maxSessions = integer(env.OPENLINK_AGENT_MAX_SESSIONS, 1, 1, 1)
const backend = new DesktopSandboxRuntimeNodeBackend(SandboxManager, {
  nodeExecutable: env.OPENLINK_NODE_EXECUTABLE || process.execPath,
  workerEntrypoint: resolve(env.OPENLINK_AGENT_WORKER_ENTRYPOINT || '../agent-worker/dist/main.js'),
  browserExtensionPath: resolve(env.OPENLINK_AGENT_BROWSER_EXTENSION_PATH || '../agent-browser-extension/openlink-browser.ts'),
  supabaseMcp: {
    extensionPath: resolve(env.OPENLINK_AGENT_SUPABASE_EXTENSION_PATH || '../agent-supabase-extension/openlink-supabase.ts'),
    urlFor: (projectId) => `http://127.0.0.1:${port}/v1/projects/${projectId}/supabase/mcp`,
    tokenFor: (projectId) => mintSupabaseMcpToken(apiToken, projectId),
  },
  workspaceRoot,
  storageRoot,
  policy: {
    allowedDomains: list(env.OPENLINK_AGENT_ALLOWED_DOMAINS),
    deniedDomains: list(env.OPENLINK_AGENT_DENIED_DOMAINS),
    allowWrite: [],
    denyWrite: [],
    denyRead: [],
    allowUnixSockets: [],
  },
})
const runtime = await startPromptHttpServer({
  host,
  port,
  apiToken,
  storageRoot,
  transport: 'sandbox-runtime-node-sdk',
  sessionIdleTtlMs,
  // SandboxManager is process-global; the backend and host both enforce one
  // active session so provider credentials and proxy state cannot cross turns.
  maxSessions,
  browserGatewayPublicUrl: env.OPENLINK_DESKTOP_AGENT_PUBLIC_URL?.trim() || `http://${host}:${port}`,
  browserGatewayAllowedOrigins: origins(env.OPENLINK_BROWSER_GATEWAY_ALLOWED_ORIGINS || env.OPENLINK_BROWSER_ALLOWED_ORIGINS),
  browserGatewayUpstreamOrigin: env.OPENLINK_BROWSER_GATEWAY_UPSTREAM_ORIGIN?.trim() || 'http://localhost:3000',
  resolveSupabaseAccessMode: (sessionId) => supabaseAccessResolver?.resolveAccessMode(sessionId) ?? Promise.resolve('restricted'),
}, {
  // Do not discard the browser capability when the desktop transport is used.
  // This keeps the desktop Node SDK path behaviorally identical to Web
  // OpenSandbox and the remote SSH/RPC path.
  createSession: (userId, workspaceId, sessionId, runtimeConfiguration, nativeSession, projectId, projectRuntime, browser) =>
    backend.createSession(userId, workspaceId, sessionId, runtimeConfiguration, nativeSession, projectId, projectRuntime, browser),
  close: () => SandboxManager.reset(),
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    runtime.server.close()
    void runtime.shutdown().finally(() => process.exit(0))
  })
}
