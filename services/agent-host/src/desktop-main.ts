import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import { resolve } from 'node:path'
import { DesktopSandboxRuntimeNodeBackend } from './backends/local-sandbox-runtime-sdk.js'
import { startPromptHttpServer } from './prompt-http-server.js'

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

const env = process.env
const host = env.OPENLINK_DESKTOP_AGENT_HOST || '127.0.0.1'
const port = integer(env.OPENLINK_DESKTOP_AGENT_PORT, 43123, 1, 65_535)
const apiToken = required(env, 'OPENLINK_DESKTOP_AGENT_API_TOKEN')
const workspaceRoot = resolve(env.OPENLINK_AGENT_WORKSPACE_ROOT || process.cwd())
const storageRoot = resolve(env.OPENLINK_DESKTOP_AGENT_STORAGE_ROOT || '.agent-data/desktop')
const sessionIdleTtlMs = integer(env.OPENLINK_AGENT_SESSION_IDLE_TTL_MS, 30 * 60_000, 60_000, 24 * 60 * 60_000)
const geminiBaseUrl = env.GOOGLE_GEMINI_BASE_URL
const geminiHost = geminiBaseUrl ? new URL(geminiBaseUrl).hostname : 'generativelanguage.googleapis.com'
const backend = new DesktopSandboxRuntimeNodeBackend(SandboxManager, {
  nodeExecutable: env.OPENLINK_NODE_EXECUTABLE || process.execPath,
  workerEntrypoint: resolve(env.OPENLINK_AGENT_WORKER_ENTRYPOINT || '../agent-worker/dist/main.js'),
  workspaceRoot,
  storageRoot,
  model: env.OPENLINK_AGENT_MODEL || env.GEMINI_MODEL,
  geminiApiKey: env.GEMINI_API_KEY,
  geminiBaseUrl,
  policy: {
    allowedDomains: [...new Set([geminiHost, ...list(env.OPENLINK_AGENT_ALLOWED_DOMAINS)])],
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
  // SandboxManager is process-global. A desktop shell starts one supervisor
  // per active agent session; this standalone host intentionally enforces it.
  maxSessions: 1,
}, {
  createSession: (userId, workspaceId, sessionId, runtimeConfiguration, nativeSession) => backend.createSession(userId, workspaceId, sessionId, runtimeConfiguration, nativeSession),
  close: () => SandboxManager.reset(),
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    runtime.server.close()
    void runtime.shutdown().finally(() => process.exit(0))
  })
}
