import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { RemoteOpenSandboxRpcBackend } from './backends/remote-opensandbox.js'
import { startPromptHttpServer } from './prompt-http-server.js'
import { buildRemoteBootstrapPlan, SshTransport } from './ssh.js'

interface ReleaseManifest {
  releaseId: string
  remoteRoot: string
  bundleSha256: string
  piCommit: string
  piRuntimeManifestSha256: string
  images: { serverImage: string; rpcImage: string }
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim()
  if (!value) throw new Error(`${key} is required`)
  return value
}

function integer(value: string | undefined, fallback: number, min: number, max: number): number {
  if (!value) return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new Error('Remote Agent Host numeric configuration is invalid')
  return parsed
}

function safeRemotePath(value: string, label: string): string {
  if (!/^\/(?:[A-Za-z0-9._-]+\/?)*$/.test(value) || value.split('/').includes('..')) throw new Error(`${label} must be a safe absolute POSIX path`)
  return value.replace(/\/+$/, '') || '/'
}

function safeEnvValue(value: string, label: string): string {
  if (!value || /[\r\n\u0000]/.test(value)) throw new Error(`${label} is invalid for runtime.env`)
  return value
}

function releaseManifest(value: unknown): ReleaseManifest {
  if (!value || typeof value !== 'object') throw new Error('release.json is invalid')
  const manifest = value as Partial<ReleaseManifest>
  if (!manifest.releaseId || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(manifest.releaseId)) throw new Error('release.json releaseId is invalid')
  if (!manifest.bundleSha256 || !/^[a-f0-9]{64}$/.test(manifest.bundleSha256)) throw new Error('release.json bundleSha256 is invalid')
  if (!manifest.piCommit || !/^[a-f0-9]{40}$/.test(manifest.piCommit)) throw new Error('release.json piCommit is invalid')
  if (!manifest.piRuntimeManifestSha256 || !/^[a-f0-9]{64}$/.test(manifest.piRuntimeManifestSha256)) throw new Error('release.json piRuntimeManifestSha256 is invalid')
  const imagePattern = /^[A-Za-z0-9][A-Za-z0-9._/-]*:[A-Za-z0-9][A-Za-z0-9._-]*$/
  if (!manifest.images?.serverImage || !imagePattern.test(manifest.images.serverImage) || !manifest.images.rpcImage || !imagePattern.test(manifest.images.rpcImage)) throw new Error('release.json images are invalid')
  return manifest as ReleaseManifest
}

async function waitForOpenSandbox(baseUrl: string): Promise<void> {
  const deadline = Date.now() + 120_000
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2_000) })
      if (response.ok) return
      lastError = new Error(`OpenSandbox health returned ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250))
  }
  throw new Error(`Remote OpenSandbox did not become healthy: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
}

const env = process.env
const releaseDirectory = resolve(required(env, 'OPENLINK_REMOTE_RELEASE_DIR'))
const manifest = releaseManifest(JSON.parse(await readFile(join(releaseDirectory, 'release.json'), 'utf8')) as unknown)
const remoteRoot = safeRemotePath(required(env, 'OPENLINK_REMOTE_ROOT'), 'OPENLINK_REMOTE_ROOT')
if (remoteRoot !== safeRemotePath(manifest.remoteRoot, 'release remoteRoot')) throw new Error('Release remoteRoot does not match OPENLINK_REMOTE_ROOT')
const opensandboxApiKey = safeEnvValue(required(env, 'OPEN_SANDBOX_API_KEY'), 'OPEN_SANDBOX_API_KEY')
const runtimeEnvironment = await mkdtemp(join(tmpdir(), 'openlink-remote-agent-'))
const secretsPath = join(runtimeEnvironment, 'runtime.env')
await writeFile(secretsPath, [
  `OPENLINK_REMOTE_ROOT=${remoteRoot}`,
  `OPENLINK_OPENSANDBOX_SERVER_IMAGE=${manifest.images.serverImage}`,
  `OPENSANDBOX_SERVER_API_KEY=${opensandboxApiKey}`,
  '',
].join('\n'), { mode: 0o600 })

const target = {
  id: required(env, 'OPENLINK_SSH_TARGET_ID'),
  host: required(env, 'OPENLINK_SSH_HOST'),
  user: required(env, 'OPENLINK_SSH_USER'),
  port: integer(env.OPENLINK_SSH_PORT, 22, 1, 65_535),
  remoteRoot,
}
const transport = new SshTransport(target, {
  knownHostsFile: required(env, 'OPENLINK_SSH_KNOWN_HOSTS_FILE'),
  identityFile: env.OPENLINK_SSH_IDENTITY_FILE,
  connectTimeoutSeconds: integer(env.OPENLINK_SSH_CONNECT_TIMEOUT_SECONDS, 10, 1, 120),
})
const plan = buildRemoteBootstrapPlan(target, manifest.releaseId, manifest.bundleSha256, {
  bundle: join(releaseDirectory, 'openlink-agent-bundle.tar.gz'),
  checksum: join(releaseDirectory, 'bundle.sha256'),
  secrets: secretsPath,
})

let tunnel: Awaited<ReturnType<SshTransport['tunnel']>> | undefined
try {
  await transport.executePlan(plan)
  await rm(runtimeEnvironment, { recursive: true, force: true })
  tunnel = await transport.tunnel(43122)
  const baseUrl = `http://127.0.0.1:${tunnel.localPort}`
  await waitForOpenSandbox(baseUrl)

  const sessionIdleTtlMs = integer(env.OPENLINK_AGENT_SESSION_IDLE_TTL_MS, 30 * 60_000, 60_000, 24 * 60 * 60_000)
  const backend = new RemoteOpenSandboxRpcBackend({
    domain: `127.0.0.1:${tunnel.localPort}`,
    apiKey: opensandboxApiKey,
    image: manifest.images.rpcImage,
    workspaceRoot: safeRemotePath(required(env, 'OPENLINK_REMOTE_WORKSPACE_ROOT'), 'OPENLINK_REMOTE_WORKSPACE_ROOT'),
    storageRoot: `${remoteRoot}/sessions`,
    model: env.OPENLINK_AGENT_MODEL || env.GEMINI_MODEL,
    geminiApiKey: env.GEMINI_API_KEY,
    geminiBaseUrl: env.GOOGLE_GEMINI_BASE_URL,
    sessionTtlSeconds: Math.ceil(sessionIdleTtlMs / 1_000) + 300,
  })
  const activeTunnel = tunnel
  const runtime = await startPromptHttpServer({
    host: env.OPENLINK_REMOTE_AGENT_HOST || '127.0.0.1',
    port: integer(env.OPENLINK_REMOTE_AGENT_PORT, 43124, 1, 65_535),
    apiToken: required(env, 'OPENLINK_REMOTE_AGENT_API_TOKEN'),
    storageRoot: resolve(env.OPENLINK_REMOTE_AGENT_STORAGE_ROOT || '.agent-data/remote-host'),
    transport: 'ssh-opensandbox-pi-cli-rpc',
    sessionIdleTtlMs,
  }, {
    createSession: (userId, workspaceId, sessionId, runtimeConfiguration, nativeSession) => backend.createSession(userId, workspaceId, sessionId, runtimeConfiguration, nativeSession),
    close: async () => {
      await backend.close()
      await activeTunnel.close()
    },
  })

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      runtime.server.close()
      void runtime.shutdown().finally(() => process.exit(0))
    })
  }
} catch (error) {
  await rm(runtimeEnvironment, { recursive: true, force: true })
  await tunnel?.close()
  throw error
}
