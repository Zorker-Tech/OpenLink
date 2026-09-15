import { createDecipheriv } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { AgentHostError } from './errors.js'
import { PodmanProjectRuntimeServiceDriver, ProjectRuntimeManager, type ProjectGitVersion, type ProjectPreviewTarget, type ProjectRuntimeCloseOptions, type ProjectRuntimeDescriptor, type ProjectSupabaseManagementRequest, type ProjectSupabaseStudioProxyRequest, type ProjectSupabaseStudioProxyResponse } from './project-runtime.js'
import type { ProjectRuntimeStatusWriter } from './project-runtime-status.js'
import { ProjectVmManager } from './project-vm.js'
import { RemoteQemuProjectVmDriver } from './remote-project-vm.js'
import { buildRemoteProjectVmBootstrapPlan, SshTransport, type SshTarget } from './ssh.js'

export interface ProjectRuntimeController {
  ensure(projectId: string, requestedDiskMode?: 'thin' | 'thick', scope?: 'all' | 'agent'): Promise<ProjectRuntimeDescriptor>
  describeSupabase(projectId: string): Promise<ProjectRuntimeDescriptor['supabase'] | null>
  manageSupabase(projectId: string, request: ProjectSupabaseManagementRequest): Promise<Record<string, unknown>>
  proxySupabaseStudio(projectId: string, request: ProjectSupabaseStudioProxyRequest): Promise<ProjectSupabaseStudioProxyResponse>
  prepareSessionStorage(projectId: string, userId: string, workspaceId: string, sessionId: string): Promise<string>
  persistCodexThreadId(projectId: string, userId: string, workspaceId: string, sessionId: string, threadId: string): Promise<void>
  ensureProjectGitRepository(projectId: string): Promise<void>
  listGitVersions(projectId: string): Promise<ProjectGitVersion[]>
  listWorkspaceFiles(projectId: string): Promise<string[]>
  checkoutGitVersion(projectId: string, ref: string): Promise<ProjectGitVersion>
  getActive(projectId: string): ProjectRuntimeDescriptor | undefined
  hasPersistedRuntime(projectId: string): Promise<boolean>
  restorePersistedRuntimes(): Promise<void>
  discoverPreviewTarget(projectId: string): Promise<ProjectPreviewTarget | null>
  close(options?: ProjectRuntimeCloseOptions): Promise<void>
}

interface SshTargetRow {
  id: string
  created_by: string
  execution_mode: 'local' | 'ssh'
  ssh_host: string | null
  ssh_port: number | null
  ssh_user: string | null
  ssh_remote_root: string | null
  ssh_known_hosts: string | null
  ssh_encrypted_private_key: string | null
  ssh_private_key_iv: string | null
  ssh_private_key_tag: string | null
  ssh_encryption_version: number | null
}

export interface SshProjectExecutionTarget extends SshTarget {
  privateKey: string
  knownHosts: string
}

function serviceKey(env: NodeJS.ProcessEnv): string | undefined {
  return env.OPENLINK_SUPABASE_SERVICE_ROLE_KEY?.trim()
}

function supabaseUrl(env: NodeJS.ProcessEnv): string | undefined {
  return (env.OPENLINK_SUPABASE_URL?.trim() || env.NEXT_PUBLIC_SUPABASE_URL?.trim())?.replace(/\/$/, '')
}

function encryptionKey(env: NodeJS.ProcessEnv): Buffer {
  const configured = env.OPENLINK_PROVIDER_SECRET_KEY?.trim()
  if (!configured) throw new AgentHostError('BACKEND_NOT_CONFIGURED', 'OPENLINK_PROVIDER_SECRET_KEY is required for SSH projects')
  const key = /^[a-f0-9]{64}$/i.test(configured) ? Buffer.from(configured, 'hex') : Buffer.from(configured, 'base64')
  if (key.length !== 32) throw new AgentHostError('BACKEND_NOT_CONFIGURED', 'OPENLINK_PROVIDER_SECRET_KEY must decode to 32 bytes')
  return key
}

function projectId(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new AgentHostError('INVALID_BODY', 'projectId is invalid')
  }
  return value
}

function requireSshTarget(row: SshTargetRow, env: NodeJS.ProcessEnv): SshProjectExecutionTarget {
  if (row.execution_mode !== 'ssh'
    || !row.ssh_host || !row.ssh_port || !row.ssh_user || !row.ssh_remote_root || !row.ssh_known_hosts
    || !row.ssh_encrypted_private_key || !row.ssh_private_key_iv || !row.ssh_private_key_tag || row.ssh_encryption_version !== 1) {
    throw new AgentHostError('PROVISIONING_FAILED', 'SSH Project target is incomplete', { retryable: false })
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(env), Buffer.from(row.ssh_private_key_iv, 'base64'))
    decipher.setAAD(Buffer.from(`openlink:provider:${row.created_by}:project-ssh:${row.id}:v1`, 'utf8'))
    decipher.setAuthTag(Buffer.from(row.ssh_private_key_tag, 'base64'))
    const privateKey = Buffer.concat([decipher.update(Buffer.from(row.ssh_encrypted_private_key, 'base64')), decipher.final()]).toString('utf8')
    if (!privateKey.includes('PRIVATE KEY')) throw new Error('decrypted key shape is invalid')
    return {
      id: row.id,
      host: row.ssh_host,
      user: row.ssh_user,
      port: row.ssh_port,
      remoteRoot: row.ssh_remote_root,
      knownHosts: row.ssh_known_hosts,
      privateKey,
    }
  } catch (error) {
    throw new AgentHostError('PROVISIONING_FAILED', `SSH Project credential could not be decrypted: ${error instanceof Error ? error.message : String(error)}`, { retryable: false })
  }
}

/** Service-role-only lookup; neither the browser nor an agent workload sees SSH credentials. */
export class SupabaseProjectExecutionTargetProvider {
  private readonly baseUrl: string
  private readonly key: string
  private readonly env: NodeJS.ProcessEnv

  constructor(env: NodeJS.ProcessEnv = process.env) {
    const url = supabaseUrl(env)
    const key = serviceKey(env)
    if (!url || !key) throw new AgentHostError('BACKEND_NOT_CONFIGURED', 'ZOKERBASE service credentials are required for SSH project execution')
    this.baseUrl = url
    this.key = key
    this.env = env
  }

  async get(projectIdValue: string): Promise<SshProjectExecutionTarget | null> {
    const id = projectId(projectIdValue)
    const query = new URLSearchParams({
      select: 'id,created_by,execution_mode,ssh_host,ssh_port,ssh_user,ssh_remote_root,ssh_known_hosts,ssh_encrypted_private_key,ssh_private_key_iv,ssh_private_key_tag,ssh_encryption_version',
      id: `eq.${id}`,
    })
    const response = await fetch(`${this.baseUrl}/rest/v1/projects?${query}`, {
      headers: {
        apikey: this.key,
        Authorization: `Bearer ${this.key}`,
        'Accept-Profile': 'openlink',
      },
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new AgentHostError('PROVISIONING_FAILED', `SSH Project target lookup failed (${response.status})`, { retryable: true })
    const rows = await response.json() as SshTargetRow[]
    const row = rows[0]
    if (!row) throw new AgentHostError('INVALID_BODY', 'Project does not exist')
    if (row.execution_mode === 'local') return null
    return requireSshTarget(row, this.env)
  }
}

interface RemoteReleaseManifest {
  releaseId: string
  bundleSha256: string
  images: { serverImage: string; execdImage: string; egressImage: string; rpcImage: string; agentWorkerImage: string; browserHostImage: string; codeServerImage: string }
  podman: { path: string; sha256: string }
  projectVmBaseImage: { url: string; sha256: string }
}

async function loadRelease(directory: string): Promise<RemoteReleaseManifest> {
  const manifest = JSON.parse(await readFile(resolve(directory, 'release.json'), 'utf8')) as Partial<RemoteReleaseManifest>
  if (!manifest.releaseId || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(manifest.releaseId)
    || !manifest.bundleSha256 || !/^[a-f0-9]{64}$/.test(manifest.bundleSha256)
    || !manifest.images || !manifest.podman || !manifest.projectVmBaseImage
    || !/^[a-f0-9]{64}$/.test(manifest.podman.sha256)
    || !/^[a-f0-9]{64}$/.test(manifest.projectVmBaseImage.sha256)) {
    throw new AgentHostError('BACKEND_NOT_CONFIGURED', 'OpenLink remote release manifest is invalid')
  }
  return manifest as RemoteReleaseManifest
}

export interface RemoteProjectRuntimeFactoryOptions {
  stateRoot: string
  releaseDirectory?: string
  browserAllowedOrigins: string
  statusWriter?: ProjectRuntimeStatusWriter
  projectVmCpus?: number
  projectVmMemoryMb?: number
  projectVmDiskGb?: number
  httpProxy?: string
  httpsProxy?: string
}

/** Creates a separate RemoteQEMU + OpenSandbox runtime manager for every SSH Project. */
export class RemoteProjectRuntimeFactory {
  private readonly stateRoot: string
  private readonly releaseDirectory?: string
  private readonly options: RemoteProjectRuntimeFactoryOptions

  constructor(options: RemoteProjectRuntimeFactoryOptions) {
    this.options = options
    this.stateRoot = resolve(options.stateRoot)
    this.releaseDirectory = options.releaseDirectory?.trim() ? resolve(options.releaseDirectory) : undefined
  }

  async create(target: SshProjectExecutionTarget): Promise<ProjectRuntimeManager> {
    if (!this.releaseDirectory) throw new AgentHostError('BACKEND_NOT_CONFIGURED', 'SSH Projects require a built OpenLink remote release (OPENLINK_REMOTE_RELEASE_DIR)', { retryable: false })
    const release = await loadRelease(this.releaseDirectory)
    const controlRoot = resolve(this.stateRoot, target.id)
    const knownHostsRoot = resolve(this.stateRoot, 'known-hosts')
    await mkdir(knownHostsRoot, { recursive: true, mode: 0o700 })
    const knownHostsFile = resolve(knownHostsRoot, `${target.id}.known_hosts`)
    await writeFile(knownHostsFile, `${target.knownHosts.trim()}\n`, { mode: 0o600 })

    const transport = new SshTransport(target, { knownHostsFile, privateKey: target.privateKey })
    const tempDirectory = await mkdtemp(join(tmpdir(), 'openlink-release-checksum-'))
    const checksumPath = join(tempDirectory, 'bundle.sha256')
    try {
      // The immutable bundle can be installed at the per-project remote root;
      // checksum data is generated for that exact destination, never copied
      // from another host's configured root.
      const remoteArchive = `${target.remoteRoot}/releases/${release.releaseId}/bundle.tar.gz`
      await writeFile(checksumPath, `${release.bundleSha256}  ${remoteArchive}\n`, { mode: 0o600 })
      await transport.executePlan(buildRemoteProjectVmBootstrapPlan(target, release.releaseId, release.bundleSha256, {
        bundle: resolve(this.releaseDirectory, 'openlink-agent-bundle.tar.gz'),
        checksum: checksumPath,
      }))
    } finally {
      await rm(tempDirectory, { recursive: true, force: true })
    }

    const remoteReleaseDirectory = `${target.remoteRoot}/releases/${release.releaseId}`
    const machineDriver = new RemoteQemuProjectVmDriver({
      transport,
      remoteRoot: target.remoteRoot,
      releaseDirectory: remoteReleaseDirectory,
      podmanBinaryPath: `${remoteReleaseDirectory}/${release.podman.path}`,
      podmanSha256: release.podman.sha256,
      baseImageUrl: release.projectVmBaseImage.url,
      baseImageSha256: release.projectVmBaseImage.sha256,
      httpProxy: this.options.httpProxy,
      httpsProxy: this.options.httpsProxy,
    })
    const vmManager = new ProjectVmManager({
      stateRoot: controlRoot,
      machineDriver,
      machinePrefix: 'olr',
      backend: 'qemu-kvm',
      guestWorkspaceRoot: '/home/openlink/projects',
      machineSpec: {
        cpus: this.options.projectVmCpus ?? 4,
        memoryMb: this.options.projectVmMemoryMb ?? 8_192,
        diskGb: this.options.projectVmDiskGb ?? 64,
        diskMode: 'thin',
      },
    })
    const archive = `remote:${remoteReleaseDirectory}/images/openlink-agent-images.tar`
    return new ProjectRuntimeManager({
      stateRoot: controlRoot,
      vmManager,
      machineDriver,
      serviceDriver: new PodmanProjectRuntimeServiceDriver(machineDriver, { rootful: true }),
      statusWriter: this.options.statusWriter,
      opensandboxImage: release.images.serverImage,
      browserHostImage: release.images.browserHostImage,
      execdImage: release.images.execdImage,
      egressImage: release.images.egressImage,
      agentWorkerImage: release.images.agentWorkerImage,
      agentRpcWorkerImage: release.images.rpcImage,
      codeServerImage: release.images.codeServerImage,
      imageArchives: Object.fromEntries(Object.values(release.images).map((image) => [image, archive])),
      browserAllowedOrigins: this.options.browserAllowedOrigins,
      publicHost: '127.0.0.1',
    })
  }
}

/** Routes local project IDs to the local VM manager and SSH IDs to their own remote VM manager. */
export class ProjectRuntimeRouter implements ProjectRuntimeController {
  private readonly remoteManagers = new Map<string, Promise<ProjectRuntimeManager>>()
  private readonly resolvedRemoteManagers = new Map<string, ProjectRuntimeManager>()

  constructor(
    private readonly local: ProjectRuntimeController,
    private readonly targetProvider: SupabaseProjectExecutionTargetProvider | undefined,
    private readonly remoteFactory: RemoteProjectRuntimeFactory | undefined,
  ) {}

  async ensure(projectIdValue: string, diskMode?: 'thin' | 'thick', scope?: 'all' | 'agent') {
    return (await this.manager(projectIdValue)).ensure(projectIdValue, diskMode, scope)
  }

  async prepareSessionStorage(projectIdValue: string, userId: string, workspaceId: string, sessionId: string) {
    return (await this.manager(projectIdValue)).prepareSessionStorage(projectIdValue, userId, workspaceId, sessionId)
  }

  async persistCodexThreadId(projectIdValue: string, userId: string, workspaceId: string, sessionId: string, threadId: string) {
    return (await this.manager(projectIdValue)).persistCodexThreadId(projectIdValue, userId, workspaceId, sessionId, threadId)
  }

  async manageSupabase(projectIdValue: string, request: ProjectSupabaseManagementRequest) {
    return (await this.manager(projectIdValue)).manageSupabase(projectIdValue, request)
  }

  async describeSupabase(projectIdValue: string) {
    return (await this.manager(projectIdValue)).describeSupabase(projectIdValue)
  }

  async proxySupabaseStudio(projectIdValue: string, request: ProjectSupabaseStudioProxyRequest) {
    return (await this.manager(projectIdValue)).proxySupabaseStudio(projectIdValue, request)
  }

  async ensureProjectGitRepository(projectIdValue: string) {
    await (await this.manager(projectIdValue)).ensureProjectGitRepository(projectIdValue)
  }

  async listGitVersions(projectIdValue: string) {
    return (await this.manager(projectIdValue)).listGitVersions(projectIdValue)
  }

  async listWorkspaceFiles(projectIdValue: string) {
    return (await this.manager(projectIdValue)).listWorkspaceFiles(projectIdValue)
  }

  async checkoutGitVersion(projectIdValue: string, ref: string) {
    return (await this.manager(projectIdValue)).checkoutGitVersion(projectIdValue, ref)
  }

  getActive(projectIdValue: string) {
    const local = this.local.getActive(projectIdValue)
    if (local) return local
    return this.resolvedRemoteManagers.get(projectIdValue)?.getActive(projectIdValue)
  }

  async hasPersistedRuntime(projectIdValue: string) {
    const target = this.targetProvider ? await this.targetProvider.get(projectIdValue) : null
    return target ? (await this.managerForTarget(target)).hasPersistedRuntime(projectIdValue) : this.local.hasPersistedRuntime(projectIdValue)
  }

  async restorePersistedRuntimes() {
    // SSH managers are created lazily from the project execution target, so
    // startup restoration covers all local Project VMs. A remote manager is
    // restored as soon as its SSH project is first selected; its own durable
    // VM lifecycle is still independent from local projects.
    await this.local.restorePersistedRuntimes()
  }

  async discoverPreviewTarget(projectIdValue: string) {
    return (await this.manager(projectIdValue)).discoverPreviewTarget(projectIdValue)
  }

  async close(options: ProjectRuntimeCloseOptions = {}) {
    await Promise.allSettled([this.local.close(options), ...[...this.remoteManagers.values()].map(async (item) => (await item).close(options))])
  }

  private async manager(projectIdValue: string): Promise<ProjectRuntimeController> {
    const target = this.targetProvider ? await this.targetProvider.get(projectIdValue) : null
    return target ? this.managerForTarget(target) : this.local
  }

  private managerForTarget(target: SshProjectExecutionTarget): Promise<ProjectRuntimeManager> {
    if (!this.remoteFactory) throw new AgentHostError('BACKEND_NOT_CONFIGURED', 'SSH Project runtime factory is unavailable')
    const existing = this.remoteManagers.get(target.id)
    if (existing) return existing
    const created = this.remoteFactory.create(target).then((manager) => {
      this.resolvedRemoteManagers.set(target.id, manager)
      return manager
    })
    this.remoteManagers.set(target.id, created)
    void created.catch(() => {
      if (this.remoteManagers.get(target.id) === created) this.remoteManagers.delete(target.id)
      this.resolvedRemoteManagers.delete(target.id)
    })
    return created
  }
}
