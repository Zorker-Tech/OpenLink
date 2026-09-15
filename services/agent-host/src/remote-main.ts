import { readFile } from 'node:fs/promises'
import { resolve as resolvePath } from 'node:path'
import { RemoteOpenSandboxRpcBackend } from './backends/remote-opensandbox.js'
import { PodmanProjectRuntimeServiceDriver, ProjectRuntimeManager } from './project-runtime.js'
import { ProjectVmManager } from './project-vm.js'
import { RemoteQemuProjectVmDriver } from './remote-project-vm.js'
import { startPromptHttpServer } from './prompt-http-server.js'
import { createSupabaseProjectRuntimeStatusWriter } from './project-runtime-status.js'
import { createSupabaseProjectRuntimeProvisioningQueue, ProjectRuntimeProvisioner } from './project-runtime-provisioner.js'
import { buildRemoteProjectVmBootstrapPlan, SshTransport } from './ssh.js'

interface ReleaseManifest {
  releaseId: string
  remoteRoot: string
  bundleSha256: string
  piCommit: string
  piRuntimeManifestSha256: string
  images: {
    serverImage: string
    execdImage: string
    egressImage: string
    rpcImage: string
    agentWorkerImage: string
    browserHostImage: string
    codeServerImage: string
  }
  podman: { path: string; sha256: string }
  projectVmBaseImage: { url: string; sha256: string }
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim()
  if (!value) throw new Error(key + ' is required')
  return value
}

function integer(value: string | undefined, fallback: number, min: number, max: number): number {
  if (!value) return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new Error('Remote Agent Host numeric configuration is invalid')
  return parsed
}

function networkDefaultAction(value: string | undefined): 'allow' | 'deny' {
  const action = value?.trim().toLowerCase() || 'allow'
  if (action !== 'allow' && action !== 'deny') throw new Error('OPENLINK_AGENT_NETWORK_DEFAULT_ACTION must be allow or deny')
  return action
}

function origins(value: string | undefined): string[] {
  const result = value?.split(',').map((item) => item.trim()).filter(Boolean) ?? ['http://localhost:3000']
  for (const origin of result) {
    const url = new URL(origin)
    if (url.origin !== origin || !['http:', 'https:'].includes(url.protocol)) throw new Error('Remote Browser gateway origin is invalid')
  }
  return result
}

function safeRemotePath(value: string, label: string): string {
  if (!/^\/(?:[A-Za-z0-9._-]+\/?)*$/.test(value) || value.split('/').includes('..')) throw new Error(label + ' must be a safe absolute POSIX path')
  return value.replace(/\/+$/, '') || '/'
}

function releaseManifest(value: unknown): ReleaseManifest {
  if (!value || typeof value !== 'object') throw new Error('release.json is invalid')
  const manifest = value as Partial<ReleaseManifest>
  if (!manifest.releaseId || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(manifest.releaseId)) throw new Error('release.json releaseId is invalid')
  if (!manifest.bundleSha256 || !/^[a-f0-9]{64}$/.test(manifest.bundleSha256)) throw new Error('release.json bundleSha256 is invalid')
  if (!manifest.piCommit || !/^[a-f0-9]{40}$/.test(manifest.piCommit)) throw new Error('release.json piCommit is invalid')
  if (!manifest.piRuntimeManifestSha256 || !/^[a-f0-9]{64}$/.test(manifest.piRuntimeManifestSha256)) throw new Error('release.json piRuntimeManifestSha256 is invalid')
  const imagePattern = /^[A-Za-z0-9][A-Za-z0-9._/-]*:[A-Za-z0-9][A-Za-z0-9._-]*$/
  const images = manifest.images
  if (!images
    || !imagePattern.test(images.serverImage)
    || !imagePattern.test(images.execdImage)
    || !imagePattern.test(images.egressImage)
    || !imagePattern.test(images.rpcImage)
    || !imagePattern.test(images.agentWorkerImage)
    || !imagePattern.test(images.browserHostImage)
    || !imagePattern.test(images.codeServerImage)) {
    throw new Error('release.json images are invalid')
  }
  if (!manifest.projectVmBaseImage
    || !/^https:\/\/cloud-images\.ubuntu\.com\/.+$/.test(manifest.projectVmBaseImage.url)
    || !/^[a-f0-9]{64}$/.test(manifest.projectVmBaseImage.sha256)) {
    throw new Error('release.json Project VM base image is invalid')
  }
  if (!manifest.podman
    || manifest.podman.path !== 'toolchain/podman'
    || !/^[a-f0-9]{64}$/.test(manifest.podman.sha256)) {
    throw new Error('release.json repository-built Podman runtime is invalid')
  }
  return manifest as ReleaseManifest
}

const env = process.env
const releaseDirectory = resolvePath(required(env, 'OPENLINK_REMOTE_RELEASE_DIR'))
const manifest = releaseManifest(JSON.parse(await readFile(resolvePath(releaseDirectory, 'release.json'), 'utf8')) as unknown)
const remoteRoot = safeRemotePath(required(env, 'OPENLINK_REMOTE_ROOT'), 'OPENLINK_REMOTE_ROOT')
if (remoteRoot !== safeRemotePath(manifest.remoteRoot, 'release remoteRoot')) throw new Error('Release remoteRoot does not match OPENLINK_REMOTE_ROOT')

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
const plan = buildRemoteProjectVmBootstrapPlan(target, manifest.releaseId, manifest.bundleSha256, {
  bundle: resolvePath(releaseDirectory, 'openlink-agent-bundle.tar.gz'),
  checksum: resolvePath(releaseDirectory, 'bundle.sha256'),
})
await transport.executePlan(plan)

const remoteReleaseDirectory = remoteRoot + '/releases/' + manifest.releaseId
const machineDriver = new RemoteQemuProjectVmDriver({
  transport,
  remoteRoot,
  releaseDirectory: remoteReleaseDirectory,
  podmanBinaryPath: remoteReleaseDirectory + '/' + manifest.podman.path,
  podmanSha256: manifest.podman.sha256,
  baseImageUrl: manifest.projectVmBaseImage.url,
  baseImageSha256: manifest.projectVmBaseImage.sha256,
  httpProxy: env.OPENLINK_REMOTE_HTTP_PROXY,
  httpsProxy: env.OPENLINK_REMOTE_HTTPS_PROXY,
})
const projectVmStateRoot = resolvePath(env.OPENLINK_REMOTE_PROJECT_VM_STATE_ROOT || '.agent-data/remote-project-vms')
const projectVmManager = new ProjectVmManager({
  stateRoot: projectVmStateRoot,
  machineDriver,
  machinePrefix: 'olr',
  backend: 'qemu-kvm',
  guestWorkspaceRoot: safeRemotePath(env.OPENLINK_REMOTE_GUEST_WORKSPACE_ROOT || '/home/openlink/projects', 'OPENLINK_REMOTE_GUEST_WORKSPACE_ROOT'),
  machineSpec: {
    cpus: integer(env.OPENLINK_PROJECT_VM_CPUS, 4, 1, 64),
    memoryMb: integer(env.OPENLINK_PROJECT_VM_MEMORY_MB, 8_192, 512, 262_144),
    diskGb: integer(env.OPENLINK_PROJECT_VM_DISK_GB, 64, 10, 4_096),
    diskMode: 'thin',
  },
})
const imageArchive = 'remote:' + remoteReleaseDirectory + '/images/openlink-agent-images.tar'
const projectRuntimeManager = new ProjectRuntimeManager({
  stateRoot: projectVmStateRoot,
  vmManager: projectVmManager,
  machineDriver,
  // The remote Ubuntu guest is a dedicated QEMU/KVM boundary, so use its
  // rootful Podman socket to preserve OpenSandbox nftables egress enforcement.
  serviceDriver: new PodmanProjectRuntimeServiceDriver(machineDriver, { rootful: true }),
  statusWriter: createSupabaseProjectRuntimeStatusWriter(env),
  opensandboxImage: manifest.images.serverImage,
  browserHostImage: manifest.images.browserHostImage,
  execdImage: manifest.images.execdImage,
  egressImage: manifest.images.egressImage,
  agentWorkerImage: manifest.images.agentWorkerImage,
  agentRpcWorkerImage: manifest.images.rpcImage,
  codeServerImage: manifest.images.codeServerImage,
  imageArchives: {
    [manifest.images.serverImage]: imageArchive,
    [manifest.images.browserHostImage]: imageArchive,
    [manifest.images.codeServerImage]: imageArchive,
    [manifest.images.execdImage]: imageArchive,
    [manifest.images.egressImage]: imageArchive,
    [manifest.images.agentWorkerImage]: imageArchive,
    [manifest.images.rpcImage]: imageArchive,
  },
  projectPortBase: integer(env.OPENLINK_PROJECT_RUNTIME_PORT_BASE, 51_000, 1_024, 65_000),
  projectPortRangeSize: integer(env.OPENLINK_PROJECT_RUNTIME_PORT_RANGE_SIZE, 1_000, 1, 64_000),
  browserAllowedOrigins: env.OPENLINK_BROWSER_ALLOWED_ORIGINS || 'http://localhost:3000',
  publicHost: '127.0.0.1',
})
const provisioningQueue = createSupabaseProjectRuntimeProvisioningQueue(env)
const provisionerId = env.OPENLINK_PROJECT_RUNTIME_PROVISIONER_ID?.trim()
const projectRuntimeProvisioner = provisioningQueue
  ? new ProjectRuntimeProvisioner({
      queue: provisioningQueue,
      runtimeManager: projectRuntimeManager,
      ...(provisionerId ? { workerId: `${provisionerId}-remote` } : {}),
    })
  : undefined

const sessionIdleTtlMs = integer(env.OPENLINK_AGENT_SESSION_IDLE_TTL_MS, 30 * 60_000, 60_000, 24 * 60 * 60_000)
const maxSessions = integer(env.OPENLINK_AGENT_MAX_SESSIONS, 32, 1, 512)
const backend = new RemoteOpenSandboxRpcBackend({
  domain: '127.0.0.1:43122',
  apiKey: required(env, 'OPEN_SANDBOX_API_KEY'),
  image: manifest.images.rpcImage,
  workspaceRoot: safeRemotePath(env.OPENLINK_REMOTE_WORKSPACE_ROOT || '/home/openlink/projects', 'OPENLINK_REMOTE_WORKSPACE_ROOT'),
  storageRoot: remoteRoot + '/sessions',
  // The Agent Host owns session cleanup; do not let OpenSandbox expire a
  // remote workload while its Cloud session is still resumable.
  sessionTtlSeconds: null,
  networkDefaultAction: networkDefaultAction(env.OPENLINK_AGENT_NETWORK_DEFAULT_ACTION),
})
const runtime = await startPromptHttpServer({
  host: env.OPENLINK_REMOTE_AGENT_HOST || '127.0.0.1',
  port: integer(env.OPENLINK_REMOTE_AGENT_PORT, 43124, 1, 65_535),
  apiToken: required(env, 'OPENLINK_REMOTE_AGENT_API_TOKEN'),
  storageRoot: resolvePath(env.OPENLINK_REMOTE_AGENT_STORAGE_ROOT || '.agent-data/remote-host'),
  transport: 'ssh-project-vm-opensandbox-pi-cli-rpc',
  sessionIdleTtlMs,
  maxSessions,
  projectRuntimeManager,
  requireProjectRuntime: true,
  browserGatewayPublicUrl: env.OPENLINK_BROWSER_GATEWAY_PUBLIC_URL?.trim() || env.OPENLINK_AGENT_PUBLIC_URL?.trim() || `http://${env.OPENLINK_REMOTE_AGENT_HOST || '127.0.0.1'}:${integer(env.OPENLINK_REMOTE_AGENT_PORT, 43124, 1, 65_535)}`,
  browserGatewayAllowedOrigins: origins(env.OPENLINK_BROWSER_GATEWAY_ALLOWED_ORIGINS || env.OPENLINK_BROWSER_ALLOWED_ORIGINS),
  browserGatewayUpstreamOrigin: env.OPENLINK_BROWSER_GATEWAY_UPSTREAM_ORIGIN?.trim() || 'http://localhost:3000',
}, {
  // Keep the BrowserAgentSession at the transport boundary.  The remote
  // worker is the same Pi runtime as the local OpenSandbox worker and must
  // receive the user-visible Browser Host capability when a prompt was
  // submitted with a browserSessionId.  Dropping this final argument made
  // browser tools silently disappear only on the SSH/RPC path.
  createSession: (userId, workspaceId, sessionId, runtimeConfiguration, nativeSession, projectId, projectRuntime, browser) =>
    backend.createSession(userId, workspaceId, sessionId, runtimeConfiguration, nativeSession, projectId, projectRuntime, browser),
  close: async () => {
    await projectRuntimeManager.close()
    await backend.close()
  },
})
projectRuntimeProvisioner?.start()

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    runtime.server.close()
    void Promise.resolve(projectRuntimeProvisioner?.close())
      .finally(() => runtime.shutdown())
      .finally(() => process.exit(0))
  })
}
