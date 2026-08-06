import { resolve } from 'node:path'
import { LocalOpenSandboxBackend } from './backends/local-opensandbox.js'
import { PodmanMachineDriver, ProjectVmManager } from './project-vm.js'
import { startPromptHttpServer } from './prompt-http-server.js'

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim()
  if (!value) throw new Error(`${key} is required`)
  return value
}

function integer(value: string | undefined, fallback: number, min: number, max: number): number {
  if (!value) return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new Error('Agent Host numeric configuration is invalid')
  return parsed
}

const env = process.env
const host = env.OPENLINK_AGENT_HOST || '127.0.0.1'
const port = integer(env.OPENLINK_AGENT_PORT, 43121, 1, 65_535)
const apiToken = required(env, 'OPENLINK_AGENT_API_TOKEN')
const workspaceRoot = resolve(env.OPENLINK_AGENT_WORKSPACE_ROOT || process.cwd())
const storageRoot = resolve(env.OPENLINK_AGENT_STORAGE_ROOT || '.agent-data')
const sessionIdleTtlMs = integer(env.OPENLINK_AGENT_SESSION_IDLE_TTL_MS, 30 * 60_000, 60_000, 24 * 60 * 60_000)
const projectVmManager = env.OPENLINK_PROJECT_VM_MODE === 'podman-machine'
  ? new ProjectVmManager({
      stateRoot: resolve(env.OPENLINK_PROJECT_VM_STATE_ROOT || '.project-vms'),
      machineDriver: new PodmanMachineDriver({ bootstrap: env.OPENLINK_PROJECT_VM_BOOTSTRAP !== '0' }),
      machineSpec: {
        cpus: integer(env.OPENLINK_PROJECT_VM_CPUS, 4, 1, 64),
        memoryMb: integer(env.OPENLINK_PROJECT_VM_MEMORY_MB, 8_192, 512, 262_144),
        diskGb: integer(env.OPENLINK_PROJECT_VM_DISK_GB, 64, 10, 4_096),
      },
    })
  : undefined
const backend = new LocalOpenSandboxBackend({
  domain: env.OPEN_SANDBOX_DOMAIN || '127.0.0.1:43122',
  apiKey: required(env, 'OPEN_SANDBOX_API_KEY'),
  image: env.OPENLINK_AGENT_WORKER_IMAGE || 'openlink/agent-worker:dev',
  workspaceRoot,
  storageRoot,
  model: env.OPENLINK_AGENT_MODEL || env.GEMINI_MODEL,
  geminiApiKey: env.GEMINI_API_KEY,
  geminiBaseUrl: env.GOOGLE_GEMINI_BASE_URL,
  sessionTtlSeconds: Math.ceil(sessionIdleTtlMs / 1_000) + 300,
})
const runtime = await startPromptHttpServer({
  host,
  port,
  apiToken,
  storageRoot,
  transport: 'opensandbox-node-sdk',
  sessionIdleTtlMs,
  projectVmManager,
}, backend)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    runtime.server.close()
    void runtime.shutdown().finally(() => process.exit(0))
  })
}
