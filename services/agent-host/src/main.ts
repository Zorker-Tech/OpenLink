import { extname, resolve } from 'node:path'
import { LocalOpenSandboxBackend } from './backends/local-opensandbox.js'
import { PodmanProjectRuntimeServiceDriver, ProjectRuntimeManager } from './project-runtime.js'
import { PodmanMachineDriver, ProjectVmManager } from './project-vm.js'
import { UbuntuQemuProjectVmDriver } from './project-vm-ubuntu.js'
import { ProjectContainerBrokerClient } from './project-container-broker.js'
import { startPromptHttpServer } from './prompt-http-server.js'
import { createSupabaseProjectRuntimeStatusWriter } from './project-runtime-status.js'
import { createSupabaseProjectRuntimeProvisioningQueue, createSupabaseSshProjectRuntimeProvisioningQueue, ProjectRuntimeProvisioner } from './project-runtime-provisioner.js'
import { ProjectRuntimeRouter, RemoteProjectRuntimeFactory, SupabaseProjectExecutionTargetProvider, type ProjectRuntimeController } from './project-runtime-router.js'
import { mintSupabaseMcpToken } from './supabase-mcp.js'
import { mintProjectMemoryMcpToken } from './project-memory-mcp.js'
import { startEmbeddedCivilizationMemoryService } from './civilization-memory-runtime.js'
import { createAccessModeResolver } from './access-mode-resolver.js'
import { createCodexPluginSnapshotProvider } from './codex-plugin-snapshot.js'

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

function imageArchives(value: string | undefined): Record<string, string> | undefined {
  if (!value?.trim()) return undefined
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch { throw new Error('OPENLINK_PROJECT_RUNTIME_IMAGE_ARCHIVES must be valid JSON') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('OPENLINK_PROJECT_RUNTIME_IMAGE_ARCHIVES must be an object')
  const result: Record<string, string> = {}
  for (const [image, archive] of Object.entries(parsed)) {
    if (!image || typeof archive !== 'string' || !archive.trim()) throw new Error('OPENLINK_PROJECT_RUNTIME_IMAGE_ARCHIVES contains an invalid entry')
    result[image] = resolve(archive)
  }
  return result
}

function origins(value: string | undefined): string[] {
  const result = value?.split(',').map((item) => item.trim()).filter(Boolean) ?? ['http://localhost:3000']
  for (const origin of result) {
    const url = new URL(origin)
    if (url.origin !== origin || !['http:', 'https:'].includes(url.protocol)) throw new Error('OPENLINK_BROWSER_GATEWAY_ALLOWED_ORIGINS contains an invalid origin')
  }
  return result
}

function networkDefaultAction(value: string | undefined): 'allow' | 'deny' {
  const action = value?.trim().toLowerCase() || 'allow'
  if (action !== 'allow' && action !== 'deny') throw new Error('OPENLINK_AGENT_NETWORK_DEFAULT_ACTION must be allow or deny')
  return action
}

function desktopRuntimeMode(value: string | undefined): 'ubuntu-container' | 'ubuntu-iso' | 'wayland-rdp' {
  const mode = value?.trim().toLowerCase() || 'ubuntu-container'
  if (mode !== 'ubuntu-container' && mode !== 'ubuntu-iso' && mode !== 'wayland-rdp') {
    throw new Error('OPENLINK_DESKTOP_MODE must be ubuntu-container, ubuntu-iso or wayland-rdp')
  }
  return mode
}

const env = process.env
const desktopMode = desktopRuntimeMode(env.OPENLINK_DESKTOP_MODE)
const remoteProjectVmMemoryDefault = desktopMode === 'ubuntu-iso' ? 16_384 : 8_192
const remoteProjectVmDiskDefault = desktopMode === 'ubuntu-iso' ? 128 : 64
const ubuntuDesktopIsoSource = desktopMode === 'ubuntu-iso'
  ? resolve(env.OPENLINK_UBUNTU_DESKTOP_ISO || '.openlink-runtime/ubuntu/26.10/ubuntu-26.10-desktop-amd64.iso')
  : undefined
const supabaseAccessResolver = createAccessModeResolver(env)
const projectRuntimeBackend = env.OPENLINK_PROJECT_RUNTIME?.trim() || 'vm'
if (!['vm', 'container'].includes(projectRuntimeBackend)) throw new Error('OPENLINK_PROJECT_RUNTIME must be vm or container')
const hostMachineProvider = env.OPENLINK_PODMAN_MACHINE_PROVIDER?.trim()
  || env.CONTAINERS_MACHINE_PROVIDER?.trim()
  || (process.platform === 'win32' ? 'hyperv' : process.platform === 'darwin' ? 'applehv' : 'qemu')
if (projectRuntimeBackend === 'vm' && !['applehv', 'hyperv', 'qemu'].includes(hostMachineProvider)) throw new Error('OpenLink Podman Machine provider is invalid')
const nativeProvider = process.platform === 'win32' ? 'hyperv' : process.platform === 'darwin' ? 'applehv' : process.platform === 'linux' ? 'qemu' : undefined
if (projectRuntimeBackend === 'vm' && (!nativeProvider || hostMachineProvider !== nativeProvider)) throw new Error(`OpenLink requires the native ${nativeProvider ?? 'unsupported'} Project VM provider on ${process.platform}`)
if (projectRuntimeBackend === 'vm' && env.OPENLINK_PODMAN_HELPER_BINARIES_DIR) {
  // Podman machine uses gvproxy/vfkit outside the engine binary. Keep the
  // helper lookup scoped to the bundled toolchain instead of requiring a
  // system Podman installation.
  process.env.CONTAINERS_HELPER_BINARY_DIR = env.OPENLINK_PODMAN_HELPER_BINARIES_DIR
  process.env.CONTAINERS_MACHINE_PROVIDER ??= hostMachineProvider
}
const host = env.OPENLINK_AGENT_HOST || '127.0.0.1'
const port = integer(env.OPENLINK_AGENT_PORT, 43121, 1, 65_535)
const apiToken = required(env, 'OPENLINK_AGENT_API_TOKEN')
const browserGatewayPublicUrl = env.OPENLINK_BROWSER_GATEWAY_PUBLIC_URL?.trim() || env.OPENLINK_AGENT_PUBLIC_URL?.trim() || `http://${host}:${port}`
const workspaceRoot = resolve(env.OPENLINK_AGENT_WORKSPACE_ROOT || process.cwd())
const storageRoot = resolve(env.OPENLINK_AGENT_STORAGE_ROOT || '.agent-data')
const codexPluginSnapshot = createCodexPluginSnapshotProvider({
  codexBin: env.OPENLINK_HOST_CODEX_BIN?.trim() || 'codex',
  codexHome: env.CODEX_HOME?.trim(),
  cacheRoot: resolve(storageRoot, '.codex-plugin-snapshots'),
})
const sessionIdleTtlMs = integer(env.OPENLINK_AGENT_SESSION_IDLE_TTL_MS, 30 * 60_000, 60_000, 24 * 60 * 60_000)
const desktopPrewarm = env.OPENLINK_DESKTOP_PREWARM !== '0'
const desktopPrewarmMax = integer(env.OPENLINK_DESKTOP_PREWARM_MAX, 1, 1, 32)
const desktopIdleTtlMs = integer(env.OPENLINK_DESKTOP_IDLE_TTL_MS, 5 * 60_000, 60_000, 24 * 60 * 60_000)
const maxSessions = integer(env.OPENLINK_AGENT_MAX_SESSIONS, 32, 1, 512)
const projectVmStateRoot = resolve(env.OPENLINK_PROJECT_VM_STATE_ROOT || '.project-vms')
let projectVmManager: ProjectVmManager | undefined
let projectRuntimeManager: ProjectRuntimeController
if (projectRuntimeBackend === 'container') {
  projectRuntimeManager = new ProjectContainerBrokerClient(required(env, 'OPENLINK_PROJECT_CONTAINER_BROKER_SOCKET'))
} else {
  const projectVmDriver = env.OPENLINK_PROJECT_VM_DRIVER?.trim() || 'podman-machine'
  if (!['podman-machine', 'ubuntu-qemu'].includes(projectVmDriver)) throw new Error('OPENLINK_PROJECT_VM_DRIVER must be podman-machine or ubuntu-qemu')
  const requestedArchitecture = env.OPENLINK_ARCHITECTURE?.trim()
    || (projectVmDriver === 'podman-machine' ? 'e1' : 't1')
  if (!['t1', 'e1', 't2'].includes(requestedArchitecture)) throw new Error('OPENLINK_ARCHITECTURE must be t1, e1 or t2')
  const releaseArchitecture = requestedArchitecture as 't1' | 'e1' | 't2'
  if ((releaseArchitecture === 'e1') !== (projectVmDriver === 'podman-machine')) {
    throw new Error(`${releaseArchitecture} requires the ${releaseArchitecture === 'e1' ? 'podman-machine' : 'ubuntu-qemu'} Project VM driver`)
  }
  const projectBaseDisk = resolve(required(env, 'OPENLINK_PROJECT_VM_BASE_DISK'))
  const machineSpec = {
    cpus: integer(env.OPENLINK_PROJECT_VM_CPUS, 4, 1, 64),
    memoryMb: integer(env.OPENLINK_PROJECT_VM_MEMORY_MB, projectVmDriver === 'ubuntu-qemu' ? 12_288 : 8_192, 512, 262_144),
    diskGb: integer(env.OPENLINK_PROJECT_VM_DISK_GB, 64, 10, 4_096),
    diskMode: 'thin' as const,
  }
  if (projectVmDriver === 'ubuntu-qemu') {
    if (process.platform !== 'linux') throw new Error('The T1 Ubuntu Project VM driver requires Linux with QEMU/KVM')
    if (extname(projectBaseDisk).toLowerCase() !== '.qcow2') throw new Error('The T1 Ubuntu Project VM requires a .qcow2 base disk')
    const machineDriver = new UbuntuQemuProjectVmDriver({
      projectBaseDisk,
      kernelPath: resolve(required(env, 'OPENLINK_PROJECT_VM_KERNEL')),
      initrdPath: resolve(required(env, 'OPENLINK_PROJECT_VM_INITRD')),
      rootDevice: env.OPENLINK_PROJECT_VM_ROOT_DEVICE || '/dev/vda',
      ...(env.OPENLINK_PROJECT_VM_BASE_FINGERPRINT ? { baseFingerprint: env.OPENLINK_PROJECT_VM_BASE_FINGERPRINT } : {}),
      stateRoot: projectVmStateRoot,
      qemuCommand: env.OPENLINK_QEMU_SYSTEM_COMMAND || 'qemu-system-x86_64',
      qemuImgCommand: env.OPENLINK_QEMU_IMG_COMMAND || 'qemu-img',
      sshCommand: env.OPENLINK_SSH_COMMAND || '/usr/bin/ssh',
      scpCommand: env.OPENLINK_SCP_COMMAND || '/usr/bin/scp',
      sshKeygenCommand: env.OPENLINK_SSH_KEYGEN_COMMAND || 'ssh-keygen',
      mke2fsCommand: env.OPENLINK_MKE2FS_COMMAND || 'mke2fs',
      gpu: releaseArchitecture === 't2' || env.OPENLINK_PROJECT_VM_GPU === '1',
      guestUser: env.OPENLINK_PROJECT_VM_GUEST_USER || 'openlink',
      bootstrap: env.OPENLINK_PROJECT_VM_BOOTSTRAP !== '0',
      ...(env.OPENLINK_PROJECT_VM_QMP_SOCKET_ROOT ? { socketRoot: env.OPENLINK_PROJECT_VM_QMP_SOCKET_ROOT } : {}),
    })
    projectVmManager = new ProjectVmManager({
      stateRoot: projectVmStateRoot,
      machineDriver,
      backend: 'qemu-kvm',
      guestWorkspaceRoot: env.OPENLINK_PROJECT_VM_GUEST_WORKSPACE_ROOT || '/home/openlink/openlink/projects',
      machineSpec,
    })
    projectRuntimeManager = new ProjectRuntimeManager({
      stateRoot: projectVmStateRoot, vmManager: projectVmManager, machineDriver,
      architecture: releaseArchitecture,
      serviceDriver: new PodmanProjectRuntimeServiceDriver(machineDriver, { rootful: true, publishAddress: '0.0.0.0' }),
      statusWriter: createSupabaseProjectRuntimeStatusWriter(env),
      opensandboxImage: env.OPENLINK_OPENSANDBOX_SERVER_IMAGE || 'openlink/opensandbox-server:dev', browserHostImage: env.OPENLINK_BROWSER_HOST_IMAGE || 'openlink/browser-host:dev',
      execdImage: env.OPENLINK_OPENSANDBOX_EXECD_IMAGE || 'openlink/opensandbox-execd:dev', egressImage: env.OPENLINK_OPENSANDBOX_EGRESS_IMAGE || 'openlink/opensandbox-egress:dev',
      agentWorkerImage: env.OPENLINK_AGENT_WORKER_IMAGE || 'openlink/agent-worker:dev', agentRpcWorkerImage: env.OPENLINK_AGENT_RPC_WORKER_IMAGE || env.OPENLINK_AGENT_WORKER_IMAGE || 'openlink/agent-rpc-worker:dev',
      codeServerImage: env.OPENLINK_CODE_SERVER_IMAGE || 'openlink/code-server:dev', imageArchives: imageArchives(env.OPENLINK_PROJECT_RUNTIME_IMAGE_ARCHIVES),
      ...(env.OPENLINK_PROJECT_SUPABASE_SEED?.trim() ? { projectSupabaseSeed: env.OPENLINK_PROJECT_SUPABASE_SEED.trim() } : {}),
      projectPortBase: integer(env.OPENLINK_PROJECT_RUNTIME_PORT_BASE, 57_000, 1_024, 65_000), projectPortRangeSize: integer(env.OPENLINK_PROJECT_RUNTIME_PORT_RANGE_SIZE, 1_000, 1, 64_000),
      desktopPortOffset: integer(env.OPENLINK_PROJECT_RUNTIME_DESKTOP_PORT_OFFSET, 6_000, 0, 60_000),
      projectDesktop: env.OPENLINK_DESKTOP_SCOPE === 'project',
      browserAllowedOrigins: env.OPENLINK_BROWSER_ALLOWED_ORIGINS || 'http://localhost:3000',
    })
  } else {
    const expectedDiskExtension = hostMachineProvider === 'hyperv' ? '.vhdx' : hostMachineProvider === 'applehv' ? '.raw' : '.qcow2'
    if (extname(projectBaseDisk).toLowerCase() !== expectedDiskExtension) throw new Error(`OpenLink ${hostMachineProvider} Project VM requires a ${expectedDiskExtension} Golden Disk`)
    const machineDriver = new PodmanMachineDriver({
      command: env.OPENLINK_PODMAN_COMMAND || 'podman', bootstrap: env.OPENLINK_PROJECT_VM_BOOTSTRAP !== '0', rootfulPodman: env.OPENLINK_PROJECT_VM_ROOTFUL === '1', projectBaseDisk,
      machineProvider: hostMachineProvider as 'applehv' | 'hyperv' | 'qemu', directAppleHv: process.platform === 'darwin',
      helperBinaryDirectory: env.CONTAINERS_HELPER_BINARY_DIR || resolve('.openlink-runtime/toolchain/bin'),
      ...(hostMachineProvider === 'applehv' ? { directStateRoot: resolve(projectVmStateRoot, 'applehv'), directSocketRoot: env.OPENLINK_PROJECT_VM_APPLEHV_SOCKET_ROOT } : {}),
    })
    projectVmManager = new ProjectVmManager({
      stateRoot: projectVmStateRoot, machineDriver,
      guestWorkspaceRoot: env.OPENLINK_PROJECT_VM_GUEST_WORKSPACE_ROOT || '/home/core/openlink/projects',
      machineSpec,
    })
    projectRuntimeManager = new ProjectRuntimeManager({
      stateRoot: projectVmStateRoot, vmManager: projectVmManager, machineDriver,
      architecture: releaseArchitecture,
      serviceDriver: new PodmanProjectRuntimeServiceDriver(machineDriver, { rootful: env.OPENLINK_PROJECT_VM_ROOTFUL === '1', publishAddress: '0.0.0.0' }),
      statusWriter: createSupabaseProjectRuntimeStatusWriter(env),
      opensandboxImage: env.OPENLINK_OPENSANDBOX_SERVER_IMAGE || 'openlink/opensandbox-server:dev', browserHostImage: env.OPENLINK_BROWSER_HOST_IMAGE || 'openlink/browser-host:dev',
      execdImage: env.OPENLINK_OPENSANDBOX_EXECD_IMAGE || 'openlink/opensandbox-execd:dev', egressImage: env.OPENLINK_OPENSANDBOX_EGRESS_IMAGE || 'openlink/opensandbox-egress:dev',
      agentWorkerImage: env.OPENLINK_AGENT_WORKER_IMAGE || 'openlink/agent-worker:dev', agentRpcWorkerImage: env.OPENLINK_AGENT_RPC_WORKER_IMAGE || env.OPENLINK_AGENT_WORKER_IMAGE || 'openlink/agent-rpc-worker:dev',
      codeServerImage: env.OPENLINK_CODE_SERVER_IMAGE || 'openlink/code-server:dev', imageArchives: imageArchives(env.OPENLINK_PROJECT_RUNTIME_IMAGE_ARCHIVES),
      ...(env.OPENLINK_PROJECT_SUPABASE_SEED?.trim() ? { projectSupabaseSeed: env.OPENLINK_PROJECT_SUPABASE_SEED.trim() } : {}),
      projectPortBase: integer(env.OPENLINK_PROJECT_RUNTIME_PORT_BASE, 57_000, 1_024, 65_000), projectPortRangeSize: integer(env.OPENLINK_PROJECT_RUNTIME_PORT_RANGE_SIZE, 1_000, 1, 64_000),
      desktopPortOffset: integer(env.OPENLINK_PROJECT_RUNTIME_DESKTOP_PORT_OFFSET, 6_000, 0, 60_000),
      projectDesktop: env.OPENLINK_DESKTOP_SCOPE === 'project',
      ...(ubuntuDesktopIsoSource ? { ubuntuDesktopIsoSource } : {}),
      browserAllowedOrigins: env.OPENLINK_BROWSER_ALLOWED_ORIGINS || 'http://localhost:3000',
    })
  }
}
const provisioningQueue = createSupabaseProjectRuntimeProvisioningQueue(env)
const provisionerId = env.OPENLINK_PROJECT_RUNTIME_PROVISIONER_ID?.trim()
const projectRuntimeProvisioner = provisioningQueue
  ? new ProjectRuntimeProvisioner({
      queue: provisioningQueue,
      runtimeManager: projectRuntimeManager,
      ...(provisionerId ? { workerId: `${provisionerId}-local` } : {}),
    })
  : undefined
const sshProvisioningQueue = createSupabaseSshProjectRuntimeProvisioningQueue(env)
const sshTargetProvider = sshProvisioningQueue ? new SupabaseProjectExecutionTargetProvider(env) : undefined
const sshRuntimeRouter = new ProjectRuntimeRouter(
  projectRuntimeManager,
  sshTargetProvider,
  sshTargetProvider
    ? new RemoteProjectRuntimeFactory({
        stateRoot: resolve(env.OPENLINK_SSH_PROJECT_VM_STATE_ROOT || '.agent-data/ssh-project-vms'),
        releaseDirectory: env.OPENLINK_REMOTE_RELEASE_DIR,
        browserAllowedOrigins: env.OPENLINK_BROWSER_ALLOWED_ORIGINS || 'http://localhost:3000',
        statusWriter: createSupabaseProjectRuntimeStatusWriter(env),
        projectVmCpus: integer(env.OPENLINK_PROJECT_VM_CPUS, 4, 1, 64),
        projectVmMemoryMb: integer(env.OPENLINK_PROJECT_VM_MEMORY_MB, remoteProjectVmMemoryDefault, 512, 262_144),
        projectVmDiskGb: integer(env.OPENLINK_PROJECT_VM_DISK_GB, remoteProjectVmDiskDefault, 10, 4_096),
        httpProxy: env.OPENLINK_REMOTE_HTTP_PROXY,
        httpsProxy: env.OPENLINK_REMOTE_HTTPS_PROXY,
        ...(ubuntuDesktopIsoSource ? { ubuntuDesktopIsoSource } : {}),
      })
    : undefined,
)
const sshProjectRuntimeProvisioner = sshProvisioningQueue
  ? new ProjectRuntimeProvisioner({
      queue: sshProvisioningQueue,
      runtimeManager: sshRuntimeRouter,
      ...(provisionerId ? { workerId: `${provisionerId}-ssh` } : {}),
    })
  : undefined
const openSandboxApiKey = required(env, 'OPEN_SANDBOX_API_KEY')
const civilizationMemoryRuntime = await startEmbeddedCivilizationMemoryService({
  stateRoot: resolve(storageRoot, 'civilization-memory'),
})
const backend = new LocalOpenSandboxBackend({
  domain: env.OPEN_SANDBOX_DOMAIN || '127.0.0.1:43122',
  apiKey: openSandboxApiKey,
  image: env.OPENLINK_AGENT_WORKER_IMAGE || 'openlink/agent-worker:dev',
  desktopMode,
  workspaceRoot,
  storageRoot,
  // The Agent Host owns session cleanup. An OpenSandbox TTL can remove a
  // workload while its Cloud session is still open and leave a stale handle
  // in memory, so use explicit cleanup and let the host reaper decide when
  // an idle session is safe to release.
  sessionTtlSeconds: null,
  networkDefaultAction: networkDefaultAction(env.OPENLINK_AGENT_NETWORK_DEFAULT_ACTION),
  allowUnsafeRootlessCredentials: env.OPENLINK_ALLOW_UNSAFE_ROOTLESS_PROVIDER_CREDENTIALS === '1',
  closeAdditionalResources: () => civilizationMemoryRuntime.close(),
  codexPluginSnapshot,
  supabaseMcp: {
    extensionPath: '/opt/openlink/agent-worker/extensions/openlink-supabase.ts',
    urlFor: (projectId) => `http://127.0.0.1:${port}/v1/projects/${projectId}/supabase/mcp`,
    tokenFor: (projectId) => mintSupabaseMcpToken(apiToken, projectId),
  },
  projectMemoryMcp: {
    mode: 'code',
    extensionPath: '/opt/openlink/agent-worker/extensions/openlink-memory.ts',
    urlFor: (projectId, mode) => `http://127.0.0.1:${port}/v1/projects/${projectId}/memory/${mode}/mcp`,
    tokenFor: (projectId, mode) => mintProjectMemoryMcpToken(apiToken, projectId, mode),
  },
})
const runtime = await startPromptHttpServer({
  host,
  port,
  apiToken,
  storageRoot,
  transport: 'opensandbox-node-sdk',
  sessionIdleTtlMs,
  desktopPrewarm,
  desktopPrewarmMax,
  desktopIdleTtlMs,
  maxSessions,
  ...(projectVmManager ? { projectVmManager } : {}),
  projectRuntimeManager: sshRuntimeRouter,
  civilizationMemoryService: civilizationMemoryRuntime.config,
  resolveSupabaseAccessMode: (sessionId) => supabaseAccessResolver?.resolveAccessMode(sessionId) ?? Promise.resolve('restricted'),
  requireProjectRuntime: true,
  preserveSessionsOnShutdown: true,
  invalidateCodexPluginSnapshot: () => codexPluginSnapshot.invalidate(),
  browserGatewayPublicUrl,
  browserGatewayAllowedOrigins: origins(env.OPENLINK_BROWSER_GATEWAY_ALLOWED_ORIGINS || env.OPENLINK_BROWSER_ALLOWED_ORIGINS),
  browserGatewayUpstreamOrigin: env.OPENLINK_BROWSER_GATEWAY_UPSTREAM_ORIGIN?.trim() || 'http://localhost:3000',
}, backend).catch(async (error) => {
  await civilizationMemoryRuntime.close()
  throw error
})
// Project VMs are application-scoped resources, not chat-session resources.
// Start the Agent Host first so the web application can report useful health
// immediately, then reattach persisted local VMs in the background. Each
// project is restored sequentially by the manager; a slow or broken project
// therefore cannot make the whole application look hung at startup.
// A persisted-ready restore and the durable provisioner both call ensure().
// Starting them together lets the queue claim a row while the restore writes
// `ready`, producing a misleading `ready + claimed` state. Finish the restore
// sweep first, then let the queue reconcile anything still not ready.
void sshRuntimeRouter.restorePersistedRuntimes()
  .catch((error) => {
    console.error(`OpenLink persisted Project VM restore sweep failed: ${error instanceof Error ? error.message : String(error)}`)
  })
  .finally(() => {
    projectRuntimeProvisioner?.start()
    sshProjectRuntimeProvisioner?.start()
  })

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    runtime.server.close()
    void Promise.all([projectRuntimeProvisioner?.close(), sshProjectRuntimeProvisioner?.close()])
      .then(() => sshRuntimeRouter.close({ stopRuntimes: false }))
      .finally(() => runtime.shutdown())
      .finally(() => process.exit(0))
  })
}
