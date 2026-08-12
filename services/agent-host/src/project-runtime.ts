import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { AgentHostError } from './errors.js'
import { isProjectId, type ProjectVmDescriptor, type ProjectVmDiskMode, type ProjectVmManager, type ProjectVmMachineDriver, type ProjectVmCommandResult, type ProjectVmPortForward } from './project-vm.js'
import type { ProjectRuntimeStatusUpdate, ProjectRuntimeStatusWriter } from './project-runtime-status.js'

export interface ProjectRuntimeServicePorts {
  opensandbox: number
  browserHost: number
  /** Project-local code-server. It is published only to the VM loopback. */
  codeServer: number
}

export interface ProjectRuntimeDescriptor extends ProjectVmDescriptor {
  status: 'ready'
  /** Guest service ports reserved for this project for the lifetime of its VM. */
  servicePorts: ProjectRuntimeServicePorts
  opensandboxEndpoint: string
  opensandboxApiKey: string
  browserHostEndpoint: string
  browserApiToken: string
  browserTokenSecret: string
  /** Private Agent Host endpoint for the project's code-server workbench. */
  codeServerEndpoint: string
  sessionStorageRoot: string
  agentWorkerImage: string
  agentRpcWorkerImage: string
  codeServerImage: string
  /** Whether session sandboxes can use the OpenSandbox egress sidecar. */
  egressMode: 'sidecar' | 'disabled'
}

/** A verified HTTP service running inside one of a Project's session sandboxes. */
export interface ProjectPreviewTarget {
  url: string
  headers: Record<string, string>
  port: number
  sandboxId: string
}

export interface ProjectGitVersion {
  ref: string
  shortRef: string
  message: string
  timestamp: string
  current: boolean
}

export interface ProjectRuntimeServiceInput {
  projectId: string
  machineName: string
  workspacePath: string
  sessionStorageRoot: string
  ports: ProjectRuntimeServicePorts
  opensandboxApiKey: string
  browserApiToken: string
  browserTokenSecret: string
  /** Parent origins accepted by Browser Host for iframe/inspector sockets. */
  browserAllowedOrigins: string
  opensandboxImage: string
  browserHostImage: string
  execdImage: string
  egressImage: string
  agentWorkerImage: string
  agentRpcWorkerImage: string
  codeServerImage: string
  imageArchives?: Record<string, string>
  /** Local development image revisions that must replace a same-tag image. */
  imageArchiveVersions?: Record<string, string>
}

export interface ProjectRuntimeServiceDriver {
  ensureServices(input: ProjectRuntimeServiceInput): Promise<void>
  stopServices(input: ProjectRuntimeServiceInput): Promise<void>
  removeServices(input: ProjectRuntimeServiceInput): Promise<void>
  readonly supportsEgress?: boolean
}

export interface PodmanProjectRuntimeServiceDriverOptions {
  /** Run the Project VM engine through its rootful system socket. */
  rootful?: boolean
}

export interface ProjectRuntimeManagerOptions {
  stateRoot: string
  vmManager: ProjectVmManager
  machineDriver: ProjectVmMachineDriver
  serviceDriver: ProjectRuntimeServiceDriver
  opensandboxImage: string
  browserHostImage: string
  execdImage: string
  egressImage: string
  agentWorkerImage: string
  agentRpcWorkerImage?: string
  codeServerImage?: string
  imageArchives?: Record<string, string>
  projectPortBase?: number
  opensandboxPortOffset?: number
  browserPortOffset?: number
  codeServerPortOffset?: number
  publicHost?: string
  browserAllowedOrigins?: string
  statusWriter?: ProjectRuntimeStatusWriter
}

export interface ProjectRuntimeCloseOptions {
  /**
   * Stop the physical Project VMs. The application supervisor passes false
   * during a normal Agent Host restart so durable VMs stay running and the
   * next process can reattach to them. Explicit maintenance/validation paths
   * keep the historical destructive shutdown by passing true.
   */
  stopRuntimes?: boolean
}

interface PersistedRuntimeSecrets {
  opensandboxApiKey: string
  browserApiToken: string
  browserTokenSecret: string
}

interface PersistedProjectPorts {
  projectId: string
  opensandbox: number
  browserHost: number
  codeServer?: number
  allocatedAt: string
}

function port(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1024 || value > 65_000) throw new AgentHostError('INVALID_BODY', `${label} is invalid`)
  return value
}

function hashProject(projectId: string): number {
  let hash = 2166136261
  for (const character of projectId) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619)
  return hash >>> 0
}

function randomSecret(): string {
  return randomBytes(32).toString('base64url')
}

function projectDiskMode(value: unknown): ProjectVmDiskMode | undefined {
  return value === 'thin' || value === 'thick' ? value : undefined
}

/**
 * ProjectRuntimeManager is the boundary between durable project VMs and
 * ephemeral session workloads. It never exposes a host path supplied by a
 * caller and serializes concurrent provisioning for the same project.
 */
export class ProjectRuntimeManager {
  private readonly stateRoot: string
  private readonly vmManager: ProjectVmManager
  private readonly machineDriver: ProjectVmMachineDriver
  private readonly serviceDriver: ProjectRuntimeServiceDriver
  private readonly images: {
    opensandboxImage: string
    browserHostImage: string
    execdImage: string
    egressImage: string
    agentWorkerImage: string
    agentRpcWorkerImage: string
    codeServerImage: string
    imageArchives?: Record<string, string>
  }
  private readonly projectPortBase: number
  private readonly opensandboxPortOffset: number
  private readonly browserPortOffset: number
  private readonly codeServerPortOffset: number
  private readonly publicHost: string
  private readonly browserAllowedOrigins: string
  private readonly statusWriter?: ProjectRuntimeStatusWriter
  private readonly active = new Map<string, ProjectRuntimeDescriptor>()
  private readonly pending = new Map<string, Promise<ProjectRuntimeDescriptor>>()
  private readonly forwards = new Map<string, ProjectVmPortForward[]>()
  private readonly portAllocations = new Map<string, ProjectRuntimeServicePorts>()
  /** Git initialization is independent from service provisioning, but must be
   * serialized because two first prompts can arrive for the same project. */
  private readonly gitInitializations = new Map<string, Promise<void>>()
  // Health recovery, stop, and remove all mutate the same VM/service/tunnel
  // tuple. Serialize them per project so a failed health check cannot evict an
  // active descriptor while a concurrent stop observes the gap and returns
  // without cleaning the durable VM.
  private readonly lifecycleLocks = new Map<string, Promise<void>>()
  private portAllocationLock: Promise<void> = Promise.resolve()
  private closing = false

  constructor(options: ProjectRuntimeManagerOptions) {
    this.stateRoot = resolve(options.stateRoot)
    this.vmManager = options.vmManager
    this.machineDriver = options.machineDriver
    this.serviceDriver = options.serviceDriver
    this.images = {
      opensandboxImage: options.opensandboxImage,
      browserHostImage: options.browserHostImage,
      execdImage: options.execdImage,
      egressImage: options.egressImage,
      agentWorkerImage: options.agentWorkerImage,
      agentRpcWorkerImage: options.agentRpcWorkerImage ?? options.agentWorkerImage,
      codeServerImage: options.codeServerImage ?? 'openlink/code-server:dev',
      imageArchives: options.imageArchives,
    }
    // OpenSandbox allocates sandbox ingress ports from 44000-50000 inside the
    // project VM. Keep the two long-lived control-plane endpoints outside that
    // range so a session cannot collide with its own OpenSandbox/Browser Host.
    this.projectPortBase = port(options.projectPortBase ?? 51_000, 'projectPortBase')
    this.opensandboxPortOffset = options.opensandboxPortOffset ?? 0
    this.browserPortOffset = options.browserPortOffset ?? 1_000
    this.codeServerPortOffset = options.codeServerPortOffset ?? 2_000
    if (!Number.isSafeInteger(this.opensandboxPortOffset) || !Number.isSafeInteger(this.browserPortOffset) || !Number.isSafeInteger(this.codeServerPortOffset) || this.opensandboxPortOffset < 0 || this.browserPortOffset < 0 || this.codeServerPortOffset < 0) {
      throw new AgentHostError('INVALID_BODY', 'Project runtime port offsets are invalid')
    }
    this.publicHost = options.publicHost ?? '127.0.0.1'
    this.browserAllowedOrigins = options.browserAllowedOrigins?.trim() || 'http://localhost:3000'
    this.statusWriter = options.statusWriter
    if (!this.images.opensandboxImage || !this.images.browserHostImage || !this.images.execdImage || !this.images.egressImage) {
      throw new AgentHostError('BACKEND_NOT_CONFIGURED', 'Project runtime images are required')
    }
  }

  async ensure(projectId: string, requestedDiskMode?: ProjectVmDiskMode): Promise<ProjectRuntimeDescriptor> {
    if (!isProjectId(projectId)) throw new AgentHostError('INVALID_BODY', 'projectId is invalid')
    return this.withLifecycleLock(projectId, async () => {
      if (this.closing) throw new AgentHostError('BACKEND_NOT_CONFIGURED', 'Project runtime manager is shutting down', { retryable: true })
      const existing = this.active.get(projectId)
      if (existing) {
        if (requestedDiskMode && existing.diskMode !== requestedDiskMode) {
          throw new AgentHostError('PROVISIONING_FAILED', `Project runtime disk mode is immutable (${existing.diskMode} != ${requestedDiskMode})`)
        }
        try {
          await this.assertRuntimeHealthy(existing)
          return existing
        } catch (error) {
          // A VM/container can disappear outside this process while the in-memory
          // descriptor remains. Evict the stale descriptor and rebuild it on the
          // same durable Project VM before the caller reaches a dead endpoint.
          if (this.active.get(projectId) === existing) this.active.delete(projectId)
          await this.closeForwards(projectId)
          console.error(`OpenLink project runtime ${projectId} failed health check: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      const pending = this.pending.get(projectId)
      if (pending) {
        const descriptor = await pending
        if (requestedDiskMode && descriptor.diskMode !== requestedDiskMode) {
          throw new AgentHostError('PROVISIONING_FAILED', `Project runtime disk mode is immutable (${descriptor.diskMode} != ${requestedDiskMode})`)
        }
        return descriptor
      }
      const diskMode = await this.resolveDiskMode(projectId, requestedDiskMode)
      const task = this.provision(projectId, diskMode)
      this.pending.set(projectId, task)
      try {
        const descriptor = await task
        this.active.set(projectId, descriptor)
        return descriptor
      } finally {
        this.pending.delete(projectId)
      }
    })
  }

  /**
   * Return the descriptor already owned by this Agent Host without starting
   * health checks or provisioning a Project VM. Destructive/session cleanup
   * paths use this deliberately: cleanup must be idempotent and must never
   * turn a stopped project back on just to send a DELETE request.
   */
  getActive(projectId: string): ProjectRuntimeDescriptor | undefined {
    if (!isProjectId(projectId)) throw new AgentHostError('INVALID_BODY', 'projectId is invalid')
    return this.active.get(projectId)
  }

  /**
   * Check whether this host has a durable Project runtime record without
   * starting the VM. Cleanup APIs use this to distinguish an old browser or
   * agent session that belongs to a real Project from an arbitrary id. The
   * record intentionally contains no runtime credentials; it is only a
   * restart-safe existence marker.
   */
  async hasPersistedRuntime(projectId: string): Promise<boolean> {
    if (!isProjectId(projectId)) throw new AgentHostError('INVALID_BODY', 'projectId is invalid')
    try {
      const value = JSON.parse(await readFile(resolve(this.stateRoot, 'projects', projectId, 'runtime.json'), 'utf8')) as Record<string, unknown>
      // `stopped` is an intentional terminal marker. Browser/agent cleanup
      // must not boot a VM that was explicitly stopped just to discover that
      // its old workload is already gone. A runtime in `error`/`deleting`
      // state, however, may still have a live machine or tunnel after a
      // failed cleanup and must be rehydrated so the retry can reclaim it.
      return value.projectId === projectId && ['ready', 'error', 'deleting'].includes(String(value.status))
    } catch {
      return false
    }
  }

  /**
   * Reattach every locally persisted Project VM during Agent Host startup.
   * Project VMs are long-lived application resources, so a process restart
   * must not leave them physically powered off until the user happens to
   * click a project again. Provisioning is serialized here to avoid starting
   * multiple 8 GiB VMs at once on a development host. A single broken project
   * is reported and skipped so it cannot prevent the rest of the application
   * from becoming available.
   */
  async restorePersistedRuntimes(): Promise<void> {
    const projectsRoot = resolve(this.stateRoot, 'projects')
    let entries
    try {
      entries = await readdir(projectsRoot, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    const projectIds = entries
      .filter((entry) => entry.isDirectory() && isProjectId(entry.name))
      .map((entry) => entry.name)
      .sort()
    for (const projectId of projectIds) {
      let status: unknown
      try {
        const persisted = JSON.parse(await readFile(resolve(projectsRoot, projectId, 'runtime.json'), 'utf8')) as Record<string, unknown>
        status = persisted.status
      } catch {
        continue
      }
      // `deleting` is an explicit terminal cleanup state. All other durable
      // runtime states represent a Project that must be brought back to a
      // usable, resident VM when the application starts.
      if (status === 'deleting') continue
      try {
        await this.ensure(projectId)
      } catch (error) {
        console.error(`OpenLink persisted Project VM restore failed for ${projectId}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  async stop(projectId: string): Promise<void> {
    if (!isProjectId(projectId)) throw new AgentHostError('INVALID_BODY', 'projectId is invalid')
    await this.withLifecycleLock(projectId, async () => {
      const descriptor = this.active.get(projectId)
        ?? (this.pending.get(projectId) ? await this.pending.get(projectId) : undefined)
      // Stopping an absent runtime must never provision a brand-new VM just to
      // stop it. This is common during shutdown and after an Agent Host restart.
      if (!descriptor) return
      let failure: unknown
      let machineStopped = false
      try {
        await this.serviceDriver.stopServices(this.serviceInput(descriptor))
      } catch (error) {
        failure = error
      }
      try {
        await this.vmManager.stop(projectId)
        machineStopped = true
      } catch (error) {
        failure ??= error
      }
      // A failed service stop must not keep a host-side tunnel open forever.
      // Closing it is independent from the guest cleanup outcome, but a failed
      // tunnel close is still part of the operation result and remains tracked
      // for a later retry.
      try {
        await this.closeForwards(projectId)
      } catch (error) {
        failure ??= error
      }
      if (machineStopped) this.active.delete(projectId)
      try {
        await this.persistDescriptorState(descriptor, machineStopped && !failure ? 'stopped' : 'error', failure)
      } catch (error) {
        failure ??= error
      }
      await this.writeStatus({
        projectId: descriptor.projectId,
        backend: descriptor.backend,
        machineName: descriptor.machineName,
        workspacePath: descriptor.workspacePath,
        status: failure ? 'error' : 'stopped',
        opensandboxEndpoint: descriptor.opensandboxEndpoint,
        browserHostEndpoint: descriptor.browserHostEndpoint,
        ...(failure ? { lastError: failure instanceof Error ? failure.message : String(failure) } : {}),
      })
      if (failure) throw failure
    })
  }

  async prepareSessionStorage(projectId: string, userId: string, workspaceId: string, sessionId: string): Promise<string> {
    const descriptor = await this.ensure(projectId)
    for (const [value, label] of [[userId, 'userId'], [workspaceId, 'workspaceId'], [sessionId, 'sessionId']] as const) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new AgentHostError('INVALID_BODY', `${label} is invalid`)
    }
    const root = `${descriptor.sessionStorageRoot}/${userId}/${workspaceId}/${sessionId}`
    if (!this.machineDriver.runInMachine) return root
    await this.machineDriver.runInMachine(descriptor.machineName, 'mkdir', ['-p', root, `${root}/workspace`, `${root}/pi-sessions`, `${root}/artifacts`, `${root}/logs`, `${root}/worker`])
    // OpenSandbox execd runs the worker as uid 1000, while the Project VM
    // driver creates this bind-mounted session directory as root.  Keep the
    // project/session parent private, but make the per-session mount writable
    // so Pi can append its native JSONL log and runtime artifacts.
    await this.machineDriver.runInMachine(descriptor.machineName, 'chmod', ['777', root])
    return root
  }

  /**
   * Establish the Project workspace as the durable source-control boundary.
   *
   * This deliberately happens immediately before the first real agent
   * session, rather than during VM provisioning: the workspace may be seeded
   * by the project creator between provisioning and its first use.  The
   * resulting initial commit is a baseline only; agent edits stay uncommitted
   * so the UI can accurately represent Git's working-tree diff.
   */
  async ensureProjectGitRepository(projectId: string): Promise<void> {
    // The prompt path has already provisioned the runtime. Reuse that live
    // descriptor so first-session setup does not add another health-probe
    // round-trip to a just-created VM.
    const descriptor = this.active.get(projectId) ?? await this.ensure(projectId)
    if (!this.machineDriver.runInMachine) return
    const existing = this.gitInitializations.get(projectId)
    if (existing) return existing

    const task = this.initializeProjectGitRepository(descriptor)
    this.gitInitializations.set(projectId, task)
    try {
      await task
    } catch (error) {
      // Do not cache a failed setup indefinitely: a transient VM command
      // failure should be retried by the next session creation.
      if (this.gitInitializations.get(projectId) === task) this.gitInitializations.delete(projectId)
      throw error
    }
  }

  async listGitVersions(projectId: string): Promise<ProjectGitVersion[]> {
    const descriptor = await this.ensure(projectId)
    if (!this.machineDriver.runInMachine) return []
    const [log, head] = await Promise.all([
      this.machineDriver.runInMachine(descriptor.machineName, 'git', [
        '-C', descriptor.workspacePath,
        'log', '--max-count=100', '--format=%H%x09%h%x09%ct%x09%s',
      ]),
      this.machineDriver.runInMachine(descriptor.machineName, 'git', ['-C', descriptor.workspacePath, 'rev-parse', 'HEAD']),
    ])
    const currentRef = head.stdout.trim()
    return log.stdout.split(/\r?\n/).flatMap((line) => {
      const [ref, shortRef, seconds, ...messageParts] = line.split('\t')
      if (!ref || !/^[0-9a-f]{40}$/i.test(ref) || !/^[0-9a-f]{7,40}$/i.test(shortRef ?? '')) return []
      const timestamp = Number(seconds)
      if (!Number.isSafeInteger(timestamp)) return []
      return [{
        ref,
        shortRef: shortRef!,
        message: messageParts.join('\t').trim() || '未命名版本',
        timestamp: new Date(timestamp * 1000).toISOString(),
        current: ref === currentRef,
      }]
    })
  }

  async checkoutGitVersion(projectId: string, ref: string): Promise<ProjectGitVersion> {
    const descriptor = await this.ensure(projectId)
    if (!this.machineDriver.runInMachine) throw new AgentHostError('BACKEND_NOT_CONFIGURED', 'Project VM command runner is unavailable')
    if (ref !== 'latest' && !/^[0-9a-f]{7,40}$/i.test(ref)) throw new AgentHostError('GIT_REF_INVALID', 'Git version reference is invalid')
    const status = await this.machineDriver.runInMachine(descriptor.machineName, 'git', ['-C', descriptor.workspacePath, 'status', '--porcelain'])
    if (status.stdout.trim()) {
      throw new AgentHostError('GIT_WORKTREE_DIRTY', '请先保存或提交当前工作区改动，再切换版本')
    }
    try {
      const target = ref === 'latest' ? 'main' : ref
      await this.machineDriver.runInMachine(descriptor.machineName, 'git', ['-C', descriptor.workspacePath, 'cat-file', '-e', `${target}^{commit}`])
      await this.machineDriver.runInMachine(descriptor.machineName, 'git', ['-C', descriptor.workspacePath, 'checkout', ...(ref === 'latest' ? ['main'] : ['--detach', '--force', ref])])
    } catch (error) {
      throw new AgentHostError('GIT_CHECKOUT_FAILED', `Git 版本切换失败：${error instanceof Error ? error.message : String(error)}`, { retryable: true })
    }
    const versions = await this.listGitVersions(projectId)
    const selected = versions.find((version) => version.current)
    if (!selected) throw new AgentHostError('GIT_CHECKOUT_FAILED', 'Git 版本切换后无法读取版本信息', { retryable: true })
    return selected
  }

  private async initializeProjectGitRepository(descriptor: ProjectRuntimeDescriptor): Promise<void> {
    if (!this.machineDriver.runInMachine) return
    // The command has no interpolated shell data. The generated workspace
    // path is passed as $1 so project metadata can never alter the script.
    const script = [
      'set -eu',
      'workspace="$1"',
      'if ! git -C "$workspace" rev-parse --is-inside-work-tree >/dev/null 2>&1; then',
      '  git -C "$workspace" init --initial-branch=main',
      'fi',
      'git -C "$workspace" config user.name "OpenLink"',
      'git -C "$workspace" config user.email "noreply@openlink.local"',
      'if [ -f "$workspace/.gitignore" ]; then',
      '  grep -Fxq ".openlink/" "$workspace/.gitignore" || printf "\\n# OpenLink runtime metadata\\n.openlink/\\n" >> "$workspace/.gitignore"',
      'elif [ ! -e "$workspace/.gitignore" ]; then',
      '  printf "# OpenLink runtime metadata\\n.openlink/\\n" > "$workspace/.gitignore"',
      'fi',
      'if ! git -C "$workspace" rev-parse --verify HEAD >/dev/null 2>&1; then',
      '  git -C "$workspace" add -A',
      '  git -C "$workspace" commit --allow-empty -m "chore: initialize OpenLink project"',
      'fi',
    ].join('\n')
    await this.machineDriver.runInMachine(descriptor.machineName, 'sh', ['-lc', script, 'openlink-project-git-init', descriptor.workspacePath])
  }

  /**
   * Locate a live development server without exposing the Project VM's
   * network to the web client. OpenSandbox's authenticated in-VM proxy is
   * the only upstream returned to Browser Host.
   */
  async discoverPreviewTarget(projectId: string): Promise<ProjectPreviewTarget | null> {
    const descriptor = await this.ensure(projectId)
    const listUrl = new URL('/v1/sandboxes', descriptor.opensandboxEndpoint)
    listUrl.searchParams.set('metadata', `openlink.project_id=${projectId}`)
    listUrl.searchParams.set('pageSize', '200')
    const headers = { 'OPEN-SANDBOX-API-KEY': descriptor.opensandboxApiKey }
    const listed = await fetch(listUrl, { headers, signal: AbortSignal.timeout(5_000), cache: 'no-store' })
    if (!listed.ok) throw new AgentHostError('PROVISIONING_FAILED', `Could not inspect Project preview services (${listed.status})`, { retryable: true })
    const body = await listed.json() as { items?: Array<{ id?: unknown; status?: { state?: unknown } }> }
    const sandboxIds = (body.items ?? [])
      .filter((item) => typeof item.id === 'string' && !/failed|deleted|stopped/i.test(String(item.status?.state ?? '')))
      .map((item) => item.id as string)
    // Prefer conventional development-server ports. The fallback range covers
    // common framework defaults while keeping discovery bounded and fast.
    const ports = [5173, 3000, 3001, 4173, 8080, 8000, 4200, 4321, 8787, 4000]
    for (const sandboxId of sandboxIds) {
      for (const port of ports) {
        const probe = new URL(`/v1/sandboxes/${encodeURIComponent(sandboxId)}/proxy/${port}/`, descriptor.opensandboxEndpoint)
        try {
          const response = await fetch(probe, { headers, signal: AbortSignal.timeout(2_500), redirect: 'manual', cache: 'no-store' })
          // A redirect is a valid dev server response. 4xx/5xx means this is
          // not an application listener (or it has not finished starting).
          if (response.status < 200 || response.status >= 400) continue
          if (response.body) await response.body.cancel().catch(() => undefined)
          return {
            // Browser Host is inside the Project VM and reaches the
            // OpenSandbox service by its VM-published loopback gateway.
            url: `http://host.containers.internal:${descriptor.servicePorts.opensandbox}/v1/sandboxes/${encodeURIComponent(sandboxId)}/proxy/${port}/`,
            headers,
            port,
            sandboxId,
          }
        } catch {
          // A port probe is expected to fail until the app starts; continue
          // scanning instead of treating that as a Project VM failure.
        }
      }
    }
    return null
  }

  async remove(projectId: string): Promise<void> {
    if (!isProjectId(projectId)) throw new AgentHostError('INVALID_BODY', 'projectId is invalid')
    await this.withLifecycleLock(projectId, async () => {
      const descriptor = this.active.get(projectId)
        ?? (this.pending.get(projectId) ? await this.pending.get(projectId) : undefined)
      if (!descriptor) {
      // A persisted/externally-created VM may still exist after a process
      // restart. Remove it directly, without creating a new runtime first.
      try {
        await this.vmManager.remove(projectId)
      } catch (error) {
        // Deletion is idempotent for a project that never reached runtime
        // provisioning. Preserve real driver failures, but do not turn a
        // missing machine into a failed project delete.
        if (!/not found|does not exist|no such machine/i.test(error instanceof Error ? error.message : String(error))) throw error
      }
      await this.closeForwards(projectId)
      // Runtime secrets are disposable with the VM. Leaving them behind
      // after an Agent Host restart would retain Browser Host and OpenSandbox
      // credentials for a project that no longer exists.
      await rm(resolve(this.stateRoot, 'projects', projectId), { recursive: true, force: true })
      this.portAllocations.delete(projectId)
        return
      }
      await this.writeStatus({
      projectId: descriptor.projectId,
      backend: descriptor.backend,
      machineName: descriptor.machineName,
      workspacePath: descriptor.workspacePath,
      status: 'deleting',
    })
    await this.persistDescriptorState(descriptor, 'deleting')
    let failure: unknown
    let vmRemoved = false
    let stateRemoved = false
    try {
      await this.serviceDriver.removeServices(this.serviceInput(descriptor))
    } catch (error) {
      failure = error
    }
    // Even if a service container is already broken, the VM must still be
    // removed. Otherwise a failed delete leaves a durable Project VM and its
    // provider credentials behind while the API reports a failure.
    try {
      await this.closeForwards(projectId)
    } catch (error) {
      failure ??= error
    }
    try {
      await this.vmManager.remove(projectId)
      vmRemoved = true
    } catch (error) {
      failure ??= error
    }
    if (vmRemoved) {
      try {
        await rm(resolve(this.stateRoot, 'projects', projectId), { recursive: true, force: true })
        this.active.delete(projectId)
        this.portAllocations.delete(projectId)
        stateRemoved = true
      } catch (error) {
        failure = error
      }
    }
    if (!stateRemoved) {
      await this.persistDescriptorState(descriptor, 'error', failure).catch((error) => {
        failure ??= error
      })
    }
    await this.writeStatus({
      projectId: descriptor.projectId,
      backend: descriptor.backend,
      machineName: descriptor.machineName,
      workspacePath: descriptor.workspacePath,
      status: failure ? 'error' : 'stopped',
      ...(failure ? { lastError: failure instanceof Error ? failure.message : String(failure) } : {}),
    })
      if (failure) throw failure
    })
  }

  /**
   * Close host-side lifecycle handles. Physical VM shutdown is optional: the
   * application supervisor preserves resident Project VMs across a process
   * restart, while explicit maintenance callers can request the old stop
   * behavior with `{ stopRuntimes: true }`.
   */
  async close(options: ProjectRuntimeCloseOptions = {}): Promise<void> {
    this.closing = true
    await Promise.allSettled([...this.pending.values()])
    const projectIds = [...this.active.keys()]
    if (options.stopRuntimes === false) {
      const results = await Promise.allSettled(projectIds.map((projectId) => this.closeForwards(projectId)))
      for (const result of results) {
        if (result.status === 'rejected') {
          console.error(`OpenLink Project VM tunnel close failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`)
        }
      }
      this.active.clear()
      return
    }
    const results = await Promise.allSettled(projectIds.map((projectId) => this.stop(projectId)))
    for (const result of results) {
      if (result.status === 'rejected') {
        console.error(`OpenLink Project VM shutdown cleanup failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`)
      }
    }
  }

  private async withLifecycleLock<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.lifecycleLocks.get(projectId) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolveRelease) => { release = resolveRelease })
    const queued = previous.then(() => current)
    this.lifecycleLocks.set(projectId, queued)
    try {
      await previous
      return await operation()
    } finally {
      release()
      if (this.lifecycleLocks.get(projectId) === queued) this.lifecycleLocks.delete(projectId)
    }
  }

  private async assertRuntimeHealthy(descriptor: ProjectRuntimeDescriptor): Promise<void> {
    const checks: Array<[string, string]> = [
      [descriptor.opensandboxEndpoint, '/health'],
      [descriptor.browserHostEndpoint, '/healthz'],
      [descriptor.codeServerEndpoint, '/healthz'],
    ]
    for (const [endpoint, path] of checks) {
      const response = await fetch(`${endpoint}${path}`, { signal: AbortSignal.timeout(1_500), cache: 'no-store' })
      if (!response.ok) throw new Error(`${endpoint}${path} returned HTTP ${response.status}`)
      if (response.body) await response.body.cancel().catch(() => undefined)
    }
  }

  private async resolveDiskMode(projectId: string, requested?: ProjectVmDiskMode): Promise<ProjectVmDiskMode> {
    const descriptorPath = resolve(this.stateRoot, 'projects', projectId, 'runtime.json')
    try {
      const persisted = JSON.parse(await readFile(descriptorPath, 'utf8')) as Record<string, unknown>
      // Runtimes created before disk-mode governance were all sparse images;
      // migrate that durable state deterministically to `thin`.
      const persistedMode = projectDiskMode(persisted.diskMode) ?? 'thin'
      if (requested && requested !== persistedMode) {
        throw new AgentHostError('PROVISIONING_FAILED', `Project runtime disk mode is immutable (${persistedMode} != ${requested})`)
      }
      return requested ?? persistedMode
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (requested) return requested
    throw new AgentHostError(
      'PROVISIONING_FAILED',
      'Project disk mode is required for initial runtime provisioning',
      { retryable: true },
    )
  }

  private async provision(projectId: string, diskMode: ProjectVmDiskMode): Promise<ProjectRuntimeDescriptor> {
    // Reserve the host-facing pair before creating the VM. A hash-only port
    // scheme can collide as soon as two Projects are provisioned, and a crash
    // between VM creation and service startup would otherwise lose the chosen
    // port. The allocation is durable under the Project state directory and
    // reused when the Agent Host is restarted.
    const ports = await this.allocateProjectPorts(projectId)
    let vm: ProjectVmDescriptor
    try {
      vm = await this.vmManager.ensure(projectId, {
        diskMode,
        servicePorts: [ports.opensandbox, ports.browserHost, ports.codeServer],
        sshPort: this.vmSshPort(ports),
      })
      // A previous stop/rebuild may have retained a tunnel whose close failed.
      // Never overwrite that handle with a fresh pair of tunnels: doing so
      // would make the old SSH processes impossible to reclaim.
      if (this.forwards.get(projectId)?.length) await this.closeForwards(projectId)
    } catch (error) {
      // VM creation/bootstrap can fail before the service lifecycle enters its
      // main try/catch. Stop a partially booted machine and leave an explicit
      // error projection instead of leaking a half-created VM that looks
      // provisionable on the next request.
      const machineName = this.vmManager.machineName(projectId)
      const workspacePath = this.vmManager.workspacePath(projectId)
      await Promise.allSettled([
        this.vmManager.stop(projectId),
        this.closeForwards(projectId),
      ]).then((results) => {
        for (const result of results) {
          if (result.status === 'rejected') {
            console.error(`OpenLink project VM ${projectId} bootstrap cleanup failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`)
          }
        }
      })
      await this.writeStatus({
        projectId,
        backend: this.vmManager.runtimeBackend,
        machineName,
        workspacePath,
        status: 'error',
        diskMode,
        lastError: error instanceof Error ? error.message : String(error),
      })
      throw new AgentHostError('PROVISIONING_FAILED', `Project VM ${projectId} failed: ${error instanceof Error ? error.message : String(error)}`, { retryable: true })
    }
    await this.writeStatus({
      projectId,
      backend: vm.backend,
      machineName: vm.machineName,
      workspacePath: vm.workspacePath,
      status: 'provisioning',
      diskMode,
    })
    let input: ProjectRuntimeServiceInput | undefined
    try {
      const secrets = await this.loadOrCreateSecrets(projectId)
      input = {
        projectId,
        machineName: vm.machineName,
        workspacePath: vm.workspacePath,
        sessionStorageRoot: resolve(vm.workspacePath, '.openlink', 'sessions'),
        ports,
        ...secrets,
        browserAllowedOrigins: this.browserAllowedOrigins,
        ...this.images,
        imageArchiveVersions: this.imageArchiveVersions(),
      }
      if (this.machineDriver.runInMachine) {
        await this.machineDriver.runInMachine(vm.machineName, 'mkdir', ['-p', input.sessionStorageRoot])
        await this.machineDriver.runInMachine(vm.machineName, 'chmod', ['700', input.sessionStorageRoot])
      } else {
        // Injectable test drivers may not model a guest shell; production
        // Podman drivers always take the guest-path branch above.
        await mkdir(input.sessionStorageRoot, { recursive: true, mode: 0o700 })
      }
      await this.serviceDriver.ensureServices(input)
      const forwards: ProjectVmPortForward[] = []
      if (this.machineDriver.forwardPort) {
        try {
          forwards.push(await this.machineDriver.forwardPort(vm.machineName, ports.opensandbox))
          forwards.push(await this.machineDriver.forwardPort(vm.machineName, ports.browserHost))
          forwards.push(await this.machineDriver.forwardPort(vm.machineName, ports.codeServer))
        } catch (error) {
          // Register partial forwards before attempting cleanup. If a tunnel
          // refuses to close, the next provisioning/retry can find and close
          // the same handle instead of allocating another leaked tunnel.
          this.forwards.set(projectId, forwards)
          await this.closeForwards(projectId).catch((cleanupError) => {
            console.error(`OpenLink Project VM port-forward cleanup failed for ${projectId}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`)
          })
          throw error
        }
      }
      this.forwards.set(projectId, forwards)
      const endpointPorts = {
        opensandbox: forwards[0]?.localPort ?? ports.opensandbox,
        browserHost: forwards[1]?.localPort ?? ports.browserHost,
        codeServer: forwards[2]?.localPort ?? ports.codeServer,
      }
      const descriptor: ProjectRuntimeDescriptor = {
        ...vm,
        status: 'ready',
        servicePorts: ports,
        opensandboxEndpoint: `http://${this.publicHost}:${endpointPorts.opensandbox}`,
        opensandboxApiKey: secrets.opensandboxApiKey,
        browserHostEndpoint: `http://${this.publicHost}:${endpointPorts.browserHost}`,
        browserApiToken: secrets.browserApiToken,
        browserTokenSecret: secrets.browserTokenSecret,
        codeServerEndpoint: `http://${this.publicHost}:${endpointPorts.codeServer}`,
        sessionStorageRoot: input.sessionStorageRoot,
        agentWorkerImage: input.agentWorkerImage,
        agentRpcWorkerImage: input.agentRpcWorkerImage,
        codeServerImage: input.codeServerImage,
        egressMode: this.serviceDriver.supportsEgress === false ? 'disabled' : 'sidecar',
      }
      await this.persistDescriptorState(descriptor, 'ready')
      await this.writeStatus({
        projectId: descriptor.projectId,
        backend: descriptor.backend,
        machineName: descriptor.machineName,
        workspacePath: descriptor.workspacePath,
        status: 'ready',
        opensandboxEndpoint: descriptor.opensandboxEndpoint,
        browserHostEndpoint: descriptor.browserHostEndpoint,
        diskMode: descriptor.diskMode,
        lastError: null,
      })
      return descriptor
    } catch (error) {
      await this.writeStatus({
        projectId: vm.projectId,
        backend: vm.backend,
        machineName: vm.machineName,
        workspacePath: vm.workspacePath,
        status: 'error',
        diskMode: vm.diskMode,
        lastError: error instanceof Error ? error.message : String(error),
      })
      const cleanupResults = await Promise.allSettled([
        ...(input ? [this.serviceDriver.removeServices(input)] : []),
        this.closeForwards(projectId),
        this.vmManager.stop(projectId),
      ])
      for (const result of cleanupResults) {
        if (result.status === 'rejected') {
          console.error(`OpenLink project runtime ${projectId} provisioning cleanup failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`)
        }
      }
      const vmStopResult = cleanupResults.at(-1)
      await this.markPersistedRuntimeState(
        projectId,
        vmStopResult?.status === 'fulfilled' ? 'stopped' : 'error',
        error,
      ).catch((markerError) => {
        console.error(`OpenLink project runtime ${projectId} state marker update failed: ${markerError instanceof Error ? markerError.message : String(markerError)}`)
      })
      throw new AgentHostError('PROVISIONING_FAILED', `Project runtime ${projectId} failed: ${error instanceof Error ? error.message : String(error)}`, { retryable: true })
    }
  }

  private async writeStatus(update: ProjectRuntimeStatusUpdate): Promise<void> {
    if (!this.statusWriter) return
    try {
      await this.statusWriter.update(update)
    } catch (error) {
      // Runtime availability must not depend on a projection write. Keep the
      // failure visible to the Agent Host operator without exposing secrets or
      // failing a request after the VM has become usable.
      console.error(`OpenLink project runtime status write failed for ${update.projectId}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private serviceInput(descriptor: ProjectRuntimeDescriptor): ProjectRuntimeServiceInput {
    return {
      projectId: descriptor.projectId,
      machineName: descriptor.machineName,
      workspacePath: descriptor.workspacePath,
      sessionStorageRoot: descriptor.sessionStorageRoot,
      ports: descriptor.servicePorts,
      opensandboxApiKey: descriptor.opensandboxApiKey,
      browserApiToken: descriptor.browserApiToken,
      browserTokenSecret: descriptor.browserTokenSecret,
      browserAllowedOrigins: this.browserAllowedOrigins,
      ...this.images,
      imageArchiveVersions: this.imageArchiveVersions(),
    }
  }

  private imageArchiveVersions(): Record<string, string> | undefined {
    const versions = Object.entries(this.images.imageArchives ?? {}).flatMap(([image, archive]) => {
      if (!archive || archive.startsWith('remote:')) return []
      try {
        const metadata = statSync(archive)
        // Local archives are generated atomically by the OpenLink image
        // builder. Size + mtime make a cheap revision marker without hashing
        // multi-gigabyte tarballs on every session. Tracking every image is
        // important: a new Agent Worker image must replace the VM's same-tag
        // image just as a Browser Host update does.
        return [[image, `${metadata.size}:${Math.floor(metadata.mtimeMs)}`] as const]
      } catch {
        return []
      }
    })
    return versions.length ? Object.fromEntries(versions) : undefined
  }

  private vmSshPort(ports: ProjectRuntimeServicePorts): number {
    return port(ports.browserHost + 101, 'Project VM SSH port')
  }

  private async closeForwards(projectId: string): Promise<void> {
    const forwards = this.forwards.get(projectId) ?? []
    if (!forwards.length) {
      this.forwards.delete(projectId)
      return
    }
    const results = await Promise.allSettled(forwards.map((forward) => forward.close()))
    const failedForwards = forwards.filter((_forward, index) => results[index]?.status === 'rejected')
    if (failedForwards.length) this.forwards.set(projectId, failedForwards)
    else this.forwards.delete(projectId)
    for (const result of results) {
      if (result.status === 'rejected') {
        console.error(`OpenLink Project VM port-forward cleanup failed for ${projectId}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`)
      }
    }
    if (failedForwards.length) {
      throw new AggregateError(
        results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map((result) => result.reason),
        `Project VM port-forward cleanup failed for ${projectId}`,
      )
    }
  }

  private async persistDescriptorState(
    descriptor: ProjectRuntimeDescriptor,
    status: 'ready' | 'stopped' | 'error' | 'deleting',
    error?: unknown,
  ): Promise<void> {
    // Keep durable VM identity and public control endpoints together. Runtime
    // credentials remain in the separate 0600 runtime-secrets.json file.
    await writeFile(resolve(this.stateRoot, 'projects', descriptor.projectId, 'runtime.json'), `${JSON.stringify({
      projectId: descriptor.projectId,
      machineName: descriptor.machineName,
      workspacePath: descriptor.workspacePath,
      backend: descriptor.backend,
      diskMode: descriptor.diskMode,
      status,
      servicePorts: descriptor.servicePorts,
      opensandboxEndpoint: descriptor.opensandboxEndpoint,
      browserHostEndpoint: descriptor.browserHostEndpoint,
      codeServerEndpoint: descriptor.codeServerEndpoint,
      sessionStorageRoot: descriptor.sessionStorageRoot,
      agentWorkerImage: descriptor.agentWorkerImage,
      agentRpcWorkerImage: descriptor.agentRpcWorkerImage,
      codeServerImage: descriptor.codeServerImage,
      egressMode: descriptor.egressMode,
      ...(error ? { lastError: error instanceof Error ? error.message : String(error) } : {}),
    })}\n`, { mode: 0o600 })
  }

  private async markPersistedRuntimeState(
    projectId: string,
    status: 'stopped' | 'error',
    error?: unknown,
  ): Promise<void> {
    const path = resolve(this.stateRoot, 'projects', projectId, 'runtime.json')
    const current = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    await writeFile(path, `${JSON.stringify({
      ...current,
      status,
      ...(error ? { lastError: error instanceof Error ? error.message : String(error) } : {}),
    })}\n`, { mode: 0o600 })
  }

  private async allocateProjectPorts(projectId: string): Promise<ProjectRuntimeServicePorts> {
    const previous = this.portAllocationLock
    let release!: () => void
    const current = new Promise<void>((resolveRelease) => { release = resolveRelease })
    this.portAllocationLock = previous.then(() => current)
    await previous
    try {
      const inMemory = this.portAllocations.get(projectId)
      if (inMemory) return inMemory
      const persisted = await this.readPersistedProjectPorts(projectId)
      if (persisted) {
        this.portAllocations.set(projectId, persisted)
        return persisted
      }

      const used = await this.readUsedProjectPorts(projectId)
      const maxStart = 65_000 - Math.max(this.opensandboxPortOffset, this.browserPortOffset + 101, this.codeServerPortOffset)
      const capacity = maxStart - this.projectPortBase + 1
      if (capacity < 1) throw new AgentHostError('BACKEND_NOT_CONFIGURED', 'Project runtime port range is exhausted')
      const initial = hashProject(projectId) % capacity
      for (let offset = 0; offset < capacity; offset += 1) {
        const openSandbox = this.projectPortBase + ((initial + offset) % capacity) + this.opensandboxPortOffset
        const browserHost = openSandbox - this.opensandboxPortOffset + this.browserPortOffset
        const codeServer = openSandbox - this.opensandboxPortOffset + this.codeServerPortOffset
        const sshPort = browserHost + 101
        const candidates = [openSandbox, browserHost, codeServer, sshPort]
        if (candidates.some((candidate) => !Number.isSafeInteger(candidate) || candidate < 1_024 || candidate > 65_000 || used.has(candidate))) continue
        const allocation: ProjectRuntimeServicePorts = { opensandbox: openSandbox, browserHost, codeServer }
        await this.persistProjectPorts(projectId, allocation)
        this.portAllocations.set(projectId, allocation)
        return allocation
      }
      throw new AgentHostError('BACKEND_NOT_CONFIGURED', 'No free Project runtime service port pair is available', { retryable: true })
    } finally {
      release()
    }
  }

  private async readPersistedProjectPorts(projectId: string): Promise<ProjectRuntimeServicePorts | undefined> {
    try {
      const value = JSON.parse(await readFile(resolve(this.stateRoot, 'projects', projectId, 'ports.json'), 'utf8')) as Partial<PersistedProjectPorts>
      const opensandbox = value.opensandbox
      const browserHost = value.browserHost
      if (value.projectId !== projectId || typeof opensandbox !== 'number' || typeof browserHost !== 'number') return undefined
      const codeServer = typeof value.codeServer === 'number'
        ? value.codeServer
        // Project VMs created before the editor service receive a stable
        // deterministic third port during the upgrade; their existing
        // OpenSandbox, Browser Host, and SSH mappings remain unchanged.
        : opensandbox - this.opensandboxPortOffset + this.codeServerPortOffset
      if (this.isValidPortSet(opensandbox, browserHost, codeServer)) {
        const ports = { opensandbox, browserHost, codeServer }
        if (value.codeServer !== codeServer) await this.persistProjectPorts(projectId, ports)
        return ports
      }
    } catch {}
    return undefined
  }

  private async readUsedProjectPorts(excludeProjectId: string): Promise<Set<number>> {
    const used = new Set<number>()
    const root = resolve(this.stateRoot, 'projects')
    for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory() || entry.name === excludeProjectId || !isProjectId(entry.name)) continue
      const allocation = await this.readPersistedProjectPorts(entry.name)
      if (allocation) {
        used.add(allocation.opensandbox)
        used.add(allocation.browserHost)
        used.add(allocation.codeServer)
        used.add(allocation.browserHost + 101)
        continue
      }
      // Older runtime descriptors did not persist the guest service ports.
      // Recover their endpoint ports where possible so an upgrade cannot
      // silently bind a second Project VM to the same host port.
      try {
        const descriptor = JSON.parse(await readFile(resolve(root, entry.name, 'runtime.json'), 'utf8')) as Record<string, unknown>
        for (const endpoint of [descriptor.opensandboxEndpoint, descriptor.browserHostEndpoint]) {
          if (typeof endpoint !== 'string') continue
          const parsed = new URL(endpoint)
          const value = Number(parsed.port)
          if (Number.isSafeInteger(value) && value > 0) used.add(value)
        }
      } catch {}
    }
    return used
  }

  private isValidPortSet(opensandbox: unknown, browserHost: unknown, codeServer: unknown): boolean {
    if (typeof opensandbox !== 'number' || typeof browserHost !== 'number' || typeof codeServer !== 'number') return false
    return Number.isSafeInteger(opensandbox)
      && Number.isSafeInteger(browserHost)
      && opensandbox >= 1_024
      && browserHost >= 1_024
      && codeServer >= 1_024
      && opensandbox <= 65_000
      && browserHost <= 65_000
      && codeServer <= 65_000
      && opensandbox !== browserHost
      && opensandbox !== codeServer
      && browserHost !== codeServer
      && browserHost + 101 <= 65_000
  }

  private async persistProjectPorts(projectId: string, ports: ProjectRuntimeServicePorts): Promise<void> {
    const directory = resolve(this.stateRoot, 'projects', projectId)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const path = resolve(directory, 'ports.json')
    const temporary = `${path}.tmp-${process.pid}-${Date.now()}`
    const value: PersistedProjectPorts = { projectId, ...ports, allocatedAt: new Date().toISOString() }
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 })
    await rename(temporary, path)
  }

  private async loadOrCreateSecrets(projectId: string): Promise<PersistedRuntimeSecrets> {
    const path = resolve(this.stateRoot, 'projects', projectId, 'runtime-secrets.json')
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<PersistedRuntimeSecrets>
      if (parsed.opensandboxApiKey && parsed.browserApiToken && parsed.browserTokenSecret) return parsed as PersistedRuntimeSecrets
    } catch {}
    const secrets: PersistedRuntimeSecrets = {
      opensandboxApiKey: randomSecret(),
      browserApiToken: randomSecret(),
      browserTokenSecret: randomSecret(),
    }
    await mkdir(resolve(this.stateRoot, 'projects', projectId), { recursive: true, mode: 0o700 })
    await writeFile(path, `${JSON.stringify(secrets)}\n`, { mode: 0o600 })
    return secrets
  }
}

/** Podman-backed project runtime service lifecycle. */
export class PodmanProjectRuntimeServiceDriver implements ProjectRuntimeServiceDriver {
  private readonly rootful: boolean
  readonly supportsEgress: boolean

  constructor(
    private readonly machineDriver: ProjectVmMachineDriver,
    options: PodmanProjectRuntimeServiceDriverOptions = {},
  ) {
    // Rootful here means rootful *inside the Project VM*. The VM remains the
    // hard host boundary, while rootful Podman is required for OpenSandbox's
    // egress sidecars to install their nftables/NET_ADMIN policy.
    this.rootful = options.rootful ?? true
    this.supportsEgress = this.rootful
  }

  async ensureServices(input: ProjectRuntimeServiceInput): Promise<void> {
    const runInMachine = this.requireRunner()
    const network = `openlink-project-${input.projectId.replaceAll('-', '').slice(0, 16)}`
    await this.prepareRootlessWorkspace(runInMachine, input.machineName, input.workspacePath)
    await this.ensureImages(input)
    await this.ensureNetwork(runInMachine, input.machineName, network)
    const podmanSocketPath = await this.ensurePodmanSocket(runInMachine, input.machineName)
    const openSandboxConfig = this.openSandboxConfig(input)
    await this.writeOpenSandboxConfig(runInMachine, input, openSandboxConfig)
    // Only purge session containers when the OpenSandbox control plane itself
    // had to be recreated. A normal health check/reuse must never destroy a
    // still-running session in the same Project VM just because another
    // request asked the manager to ensure the durable services.
    const openSandboxRecreated = await this.ensureContainer(runInMachine, input.machineName, {
      name: `${network}-opensandbox`,
      image: input.opensandboxImage,
      port: input.ports.opensandbox,
      containerPort: 43122,
      // Workloads created by OpenSandbox use the engine's default bridge.
      // The control plane must share it for server-side endpoint proxying;
      // the Browser Host remains on the project network below.
      network: 'bridge',
      env: {
        OPENSANDBOX_SERVER_API_KEY: input.opensandboxApiKey,
        OPENLINK_PROJECT_ID: input.projectId,
        OPENLINK_PROJECT_WORKSPACE: input.workspacePath,
        OPENLINK_OPENSANDBOX_EXECD_IMAGE: input.execdImage,
        OPENLINK_OPENSANDBOX_EGRESS_IMAGE: input.egressImage,
        // The OpenSandbox image runs as an unprivileged Python process in
        // some releases. Passing the non-secret config through an environment
        // variable and materialising it inside the container avoids SELinux
        // denial on a single-file bind mount from Fedora CoreOS.
        OPENLINK_OPENSANDBOX_CONFIG_B64: Buffer.from(openSandboxConfig, 'utf8').toString('base64'),
        SANDBOX_CONFIG_PATH: '/tmp/openlink/opensandbox.toml',
        DOCKER_HOST: 'unix:///var/run/docker.sock',
        // The development host exports a Surge/HTTP proxy. OpenSandbox's
        // internal server-proxy requests target bridge IPs and must never be
        // sent through that external proxy (it turns a local health check
        // into a 503 HTML response). Session workers receive their own
        // provider networking policy separately.
        HTTP_PROXY: '',
        HTTPS_PROXY: '',
        ALL_PROXY: '',
        http_proxy: '',
        https_proxy: '',
        all_proxy: '',
        NO_PROXY: '*',
        no_proxy: '*',
      },
      volumes: [
        // Project VM guests may enforce SELinux labels on bind mounts. Keep
        // each service's view private to this Project while preserving the
        // guest filesystem boundary.
        // Do not use Podman's `:Z` relabel mode on the project workspace.
        // This directory contains durable session trees created by previous
        // rootless user namespaces; recursive relabeling walks those trees
        // and fails on entries owned by an old subordinate UID. The service
        // container already runs with SELinux labeling disabled, so a plain
        // bind mount keeps the VM boundary without mutating the workspace.
        `${input.workspacePath}:/workspace:rw`,
        // Do not relabel the Podman API socket. SELinux's `:Z` relabeling
        // changes the socket context and causes the rootless Podman service
        // to reject connects even when the numeric owner is correct.
        `${podmanSocketPath}:/var/run/docker.sock:rw`,
      ],
      // Project VMs use rootless Podman. UID 0 inside a rootless container is
      // mapped to the guest's unprivileged Podman user, so it can open the
      // 0660 socket while never becoming host root. Passing the guest UID
      // directly would be remapped into the subordinate UID range and lose
      // access to the socket.
      user: '0:0',
      securityOpts: ['label=disable'],
      entrypoint: ['/bin/sh'],
      command: ['-lc', 'set -eu; mkdir -p "$(dirname "$SANDBOX_CONFIG_PATH")"; printf %s "$OPENLINK_OPENSANDBOX_CONFIG_B64" | base64 -d > "$SANDBOX_CONFIG_PATH"; exec /app/.venv/bin/opensandbox-server --config "$SANDBOX_CONFIG_PATH"'],
    })
    await this.ensureContainer(runInMachine, input.machineName, {
      name: `${network}-browser`,
      image: input.browserHostImage,
      port: input.ports.browserHost,
      containerPort: 43120,
      network,
      env: {
        OPENLINK_BROWSER_API_TOKEN: input.browserApiToken,
        OPENLINK_BROWSER_TOKEN_SECRET: input.browserTokenSecret,
        OPENLINK_BROWSER_ALLOWED_ORIGINS: input.browserAllowedOrigins,
        OPENLINK_BROWSER_PUBLIC_URL: `http://127.0.0.1:${input.ports.browserHost}`,
        OPENLINK_BROWSER_HOST: '0.0.0.0',
        OPENLINK_BROWSER_PORT: '43120',
        OPENLINK_BROWSER_STORAGE_ROOT: '/workspace/.openlink/browser',
        OPENLINK_CHROME_EXECUTABLE: '/usr/bin/chromium',
        // Debian Chromium starts its crashpad helper before Playwright's
        // profile directory is applied.  The image's application directory
        // is not writable by the keep-id service user, so Chromium cannot
        // create its crashpad database there and exits with
        // `chrome_crashpad_handler: --database is required`.  Keep all
        // browser-owned config/cache state inside the project workspace,
        // whose ownership is the same keep-id user as this container.
        HOME: '/workspace',
        XDG_CONFIG_HOME: '/workspace/.openlink/browser/config',
        XDG_CACHE_HOME: '/workspace/.openlink/browser/cache',
      },
      volumes: [`${input.workspacePath}:/workspace:rw`],
      // The project workspace is intentionally not recursively relabeled;
      // disable the container SELinux label for this VM-local bind mount just
      // like the OpenSandbox control plane above.
      securityOpts: ['label=disable'],
      // The Browser Host writes persistent Chromium profiles below the
      // project workspace. Rootless Podman otherwise maps container root to
      // a subordinate UID which cannot traverse the 0700 project directory.
      // Keep the mapping tied to the Project VM owner instead of weakening
      // the workspace permissions.
      ...(!this.rootful ? { usernsMode: 'keep-id' } : {}),
    })
    const workspaceUid = (await runInMachine(input.machineName, 'id', ['-u'])).stdout.trim()
    const workspaceGid = (await runInMachine(input.machineName, 'id', ['-g'])).stdout.trim()
    if (!/^\d+$/.test(workspaceUid) || !/^\d+$/.test(workspaceGid)) {
      throw new AgentHostError('PROVISIONING_FAILED', 'Project VM returned an invalid workspace owner')
    }
    await this.ensureContainer(runInMachine, input.machineName, {
      name: `${network}-code-server`,
      image: input.codeServerImage,
      port: input.ports.codeServer,
      containerPort: 43140,
      network,
      env: {
        HOME: '/workspace',
        USER: 'openlink',
        XDG_CONFIG_HOME: '/workspace/.openlink/code-server/config',
        XDG_CACHE_HOME: '/workspace/.openlink/code-server/cache',
      },
      volumes: [`${input.workspacePath}:/workspace:rw`],
      // The Project VM is the isolation boundary. Keep the service confined to
      // the VM owner's uid/gid so the editor can write the same workspace as
      // the project tooling without running as container root.
      user: `${workspaceUid}:${workspaceGid}`,
      securityOpts: ['label=disable'],
      ...(!this.rootful ? { usernsMode: 'keep-id' } : {}),
    })
    if (openSandboxRecreated) await this.cleanupSessionWorkloads(runInMachine, input.machineName)
    if (this.machineDriver.forwardPort) {
      try {
        await this.waitForMachineEndpoint(runInMachine, input.machineName, input.ports.opensandbox, '/health')
      } catch (error) {
        const diagnostics = await runInMachine(input.machineName, 'podman', ['logs', '--tail', '120', `${network}-opensandbox`]).then((result) => result.stdout + result.stderr).catch(() => '')
        throw new AgentHostError('PROVISIONING_FAILED', `${error instanceof Error ? error.message : String(error)}${diagnostics.trim() ? `; OpenSandbox logs: ${diagnostics.trim().slice(-12_000)}` : ''}`, { retryable: true })
      }
      try {
        await this.waitForMachineEndpoint(runInMachine, input.machineName, input.ports.browserHost, '/healthz')
      } catch (error) {
        const diagnostics = await runInMachine(input.machineName, 'podman', ['logs', '--tail', '120', `${network}-browser`]).then((result) => result.stdout + result.stderr).catch(() => '')
          throw new AgentHostError('PROVISIONING_FAILED', `${error instanceof Error ? error.message : String(error)}${diagnostics.trim() ? `; Browser Host logs: ${diagnostics.trim().slice(-12_000)}` : ''}`, { retryable: true })
      }
      try {
        await this.waitForMachineEndpoint(runInMachine, input.machineName, input.ports.codeServer, '/healthz')
      } catch (error) {
        const diagnostics = await runInMachine(input.machineName, 'podman', ['logs', '--tail', '120', `${network}-code-server`]).then((result) => result.stdout + result.stderr).catch(() => '')
        throw new AgentHostError('PROVISIONING_FAILED', `${error instanceof Error ? error.message : String(error)}${diagnostics.trim() ? `; code-server logs: ${diagnostics.trim().slice(-12_000)}` : ''}`, { retryable: true })
      }
    } else {
      await this.waitForEndpoint(`http://127.0.0.1:${input.ports.opensandbox}`, '/health')
      await this.waitForEndpoint(`http://127.0.0.1:${input.ports.browserHost}`, '/healthz')
      await this.waitForEndpoint(`http://127.0.0.1:${input.ports.codeServer}`, '/healthz')
    }
  }

  async stopServices(input: ProjectRuntimeServiceInput): Promise<void> {
    const runInMachine = this.requireRunner()
    const network = `openlink-project-${input.projectId.replaceAll('-', '').slice(0, 16)}`
    await this.cleanupSessionWorkloads(runInMachine, input.machineName)
    await Promise.all([
      this.ignoreMissingContainer(runInMachine(input.machineName, 'podman', ['stop', `${network}-opensandbox`])),
      this.ignoreMissingContainer(runInMachine(input.machineName, 'podman', ['stop', `${network}-browser`])),
      this.ignoreMissingContainer(runInMachine(input.machineName, 'podman', ['stop', `${network}-code-server`])),
    ])
  }

  async removeServices(input: ProjectRuntimeServiceInput): Promise<void> {
    const runInMachine = this.requireRunner()
    const network = `openlink-project-${input.projectId.replaceAll('-', '').slice(0, 16)}`
    await this.cleanupSessionWorkloads(runInMachine, input.machineName)
    await Promise.all([
      this.ignoreMissingContainer(runInMachine(input.machineName, 'podman', ['rm', '--force', `${network}-opensandbox`])),
      this.ignoreMissingContainer(runInMachine(input.machineName, 'podman', ['rm', '--force', `${network}-browser`])),
      this.ignoreMissingContainer(runInMachine(input.machineName, 'podman', ['rm', '--force', `${network}-code-server`])),
      this.ignoreMissingContainer(runInMachine(input.machineName, 'podman', ['network', 'rm', network])),
    ])
  }

  private async ignoreMissingContainer(operation: Promise<ProjectVmCommandResult>): Promise<void> {
    try {
      await operation
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!/not found|no such|does not exist|cannot find/i.test(message)) throw error
    }
  }

  private async cleanupSessionWorkloads(
    runInMachine: (name: string, command: string, args?: string[]) => Promise<ProjectVmCommandResult>,
    machine: string,
  ): Promise<void> {
    const labels = ['opensandbox.io/id', 'opensandbox.io/egress-sidecar-for']
    for (const label of labels) {
      const result = await runInMachine(machine, 'podman', ['ps', '--all', '--quiet', '--filter', `label=${label}`])
      const ids = result.stdout.split(/\s+/).map((value) => value.trim()).filter((value) => /^[A-Za-z0-9]+$/.test(value))
      if (ids.length) await this.ignoreMissingContainer(runInMachine(machine, 'podman', ['rm', '--force', ...ids]))
    }
  }

  /**
   * Migrate the project-owned control-plane tree from older rootless user
   * namespaces before any service bind-mounts it. Earlier runtime versions
   * could leave entries owned by a subordinate UID; the current keep-id
   * mapping must be able to traverse and append to those durable sessions.
   * The migration is confined to `.openlink` inside this Project VM and never
   * touches the user's source tree.
   */
  private async prepareRootlessWorkspace(
    runInMachine: (name: string, command: string, args?: string[]) => Promise<ProjectVmCommandResult>,
    machine: string,
    workspacePath: string,
  ): Promise<void> {
    if (this.rootful) return
    const uid = (await runInMachine(machine, 'id', ['-u'])).stdout.trim()
    const gid = (await runInMachine(machine, 'id', ['-g'])).stdout.trim()
    if (!/^[0-9]+$/.test(uid) || !/^[0-9]+$/.test(gid)) {
      throw new AgentHostError('PROVISIONING_FAILED', 'Project VM returned an invalid workspace owner')
    }
    const owner = `${uid}:${gid}`
    const controlRoot = `${workspacePath}/.openlink`
    const browserRoot = `${controlRoot}/browser`
    const sessionRoot = `${controlRoot}/sessions`
    const canSudo = await runInMachine(machine, 'sudo', ['-n', 'true']).then(() => true).catch(() => false)
    if (canSudo) {
      await runInMachine(machine, 'sudo', ['-n', 'mkdir', '-p', browserRoot, sessionRoot])
      await runInMachine(machine, 'sudo', ['-n', 'chown', '-R', owner, controlRoot])
    } else {
      await runInMachine(machine, 'mkdir', ['-p', browserRoot, sessionRoot])
      await runInMachine(machine, 'chown', ['-R', owner, controlRoot]).catch(() => undefined)
    }
    await runInMachine(machine, 'chmod', ['700', controlRoot])
  }

  private requireRunner(): (name: string, command: string, args?: string[]) => Promise<ProjectVmCommandResult> {
    const runner = this.machineDriver.runInMachine?.bind(this.machineDriver)
    if (!runner) throw new AgentHostError('BACKEND_NOT_CONFIGURED', 'Project VM driver cannot execute services')
    return (name, command, args = []) => {
      if (this.rootful && command === 'podman') return runner(name, 'sudo', ['-n', 'podman', ...args])
      return runner(name, command, args)
    }
  }

  private async ensureImages(input: ProjectRuntimeServiceInput): Promise<void> {
    const runInMachine = this.requireRunner()
    const copyToMachine = this.machineDriver.copyToMachine?.bind(this.machineDriver)
    const copyRemoteToMachine = this.machineDriver.copyRemoteToMachine?.bind(this.machineDriver)
    const loadedArchives = new Set<string>()
    // Recover from a host/process interruption during an earlier import. The
    // staging directory is tmpfs on the Project VM, so even a few abandoned
    // archives can block the next complete image set before retry begins.
    await runInMachine(input.machineName, 'find', ['/tmp', '-maxdepth', '1', '-type', 'f', '-name', 'openlink-image-*.tar', '-delete'])
    const imageNames = [input.opensandboxImage, input.browserHostImage, input.execdImage, input.egressImage, input.agentWorkerImage, input.agentRpcWorkerImage, input.codeServerImage]
    for (const image of imageNames) {
      const archive = input.imageArchives?.[image]
      const requestedRevision = input.imageArchiveVersions?.[image]
      const revisionPath = `${input.workspacePath}/.openlink/runtime-image-revisions/${image.replace(/[^A-Za-z0-9_.-]/g, '_')}.txt`
      let refreshExistingImage = false
      if (archive && requestedRevision) {
        const recorded = await runInMachine(input.machineName, 'cat', [revisionPath]).then((result) => result.stdout.trim()).catch(() => '')
        refreshExistingImage = recorded !== requestedRevision
      }
      const candidates = [image, `localhost/${image}`, `docker.io/${image}`]
      let existingImage: string | undefined
      for (const candidate of candidates) {
        if (await runInMachine(input.machineName, 'podman', ['image', 'exists', candidate]).then(() => true).catch(() => false)) {
          existingImage = candidate
          break
        }
      }
      if (existingImage && !refreshExistingImage) {
        // `podman load` preserves the repository name embedded in an archive.
        // Images built by Docker/Podman therefore commonly arrive as
        // localhost/<name> or docker.io/<name>, while the runtime contract
        // intentionally uses the engine-neutral short name. Tag the alias
        // once so subsequent service creation never re-imports the archive.
        if (existingImage !== image) {
          await runInMachine(input.machineName, 'podman', ['tag', existingImage, image]).catch(() => undefined)
        }
        continue
      }
      if (!archive) throw new AgentHostError('BACKEND_NOT_CONFIGURED', 'Image ' + image + ' is not loaded into project VM and no image archive is configured')
      if (loadedArchives.has(archive)) continue
      const filename = '/tmp/openlink-image-' + image.replace(/[^A-Za-z0-9_.-]/g, '_') + '.tar'
      if (archive.startsWith('remote:')) {
        if (!copyRemoteToMachine) throw new AgentHostError('BACKEND_NOT_CONFIGURED', 'Remote image archive ' + archive + ' cannot be copied into project VM')
        await copyRemoteToMachine(input.machineName, archive.slice('remote:'.length), filename)
      } else {
        if (!copyToMachine) throw new AgentHostError('BACKEND_NOT_CONFIGURED', 'Image ' + image + ' is not loaded into project VM and no local image copier is configured')
        await copyToMachine(input.machineName, archive, filename)
      }
      try {
        await runInMachine(input.machineName, 'podman', ['load', '--input', filename])
      } finally {
        // Image archives are staging artifacts, not runtime state. Keeping all
        // seven tarballs in /tmp can exhaust a fresh 64 GB Project VM before
        // code-server is imported, even though the loaded layers themselves
        // still fit. Always remove complete and partial uploads immediately.
        await runInMachine(input.machineName, 'rm', ['-f', filename]).catch(() => undefined)
      }
      for (const candidate of [`localhost/${image}`, `docker.io/${image}`]) {
        if (await runInMachine(input.machineName, 'podman', ['image', 'exists', candidate]).then(() => true).catch(() => false)) {
          await runInMachine(input.machineName, 'podman', ['tag', candidate, image]).catch(() => undefined)
          break
        }
      }
      if (requestedRevision) {
        await runInMachine(input.machineName, 'mkdir', ['-p', `${input.workspacePath}/.openlink/runtime-image-revisions`])
        await runInMachine(input.machineName, 'bash', ['-lc', `printf %s ${JSON.stringify(requestedRevision)} > ${JSON.stringify(revisionPath)}`])
      }
      loadedArchives.add(archive)
    }
  }

  private async ensureNetwork(runInMachine: (name: string, command: string, args?: string[]) => Promise<ProjectVmCommandResult>, machine: string, network: string): Promise<void> {
    try {
      await runInMachine(machine, 'podman', ['network', 'inspect', network])
    } catch {
      await runInMachine(machine, 'podman', ['network', 'create', network])
    }
  }

  private async ensurePodmanSocket(
    runInMachine: (name: string, command: string, args?: string[]) => Promise<ProjectVmCommandResult>,
    machine: string,
  ): Promise<string> {
    const socketPath = this.rootful ? '/run/podman/podman.sock' : await this.rootlessSocketPath(runInMachine, machine)
    await runInMachine(machine, 'test', ['-S', socketPath])
    return socketPath
  }

  private async rootlessSocketPath(
    runInMachine: (name: string, command: string, args?: string[]) => Promise<ProjectVmCommandResult>,
    machine: string,
  ): Promise<string> {
    const uid = (await runInMachine(machine, 'id', ['-u'])).stdout.trim()
    if (!/^[0-9]+$/.test(uid)) throw new AgentHostError('PROVISIONING_FAILED', 'Project VM returned an invalid Podman user id')
    return `/run/user/${uid}/podman/podman.sock`
  }

  private openSandboxConfig(input: ProjectRuntimeServiceInput): string {
    return [
      '[server]',
      'host = "0.0.0.0"',
      'port = 43122',
      'max_sandbox_timeout_seconds = 86400',
      '',
      '[runtime]',
      'type = "docker"',
      `execd_image = "${input.execdImage}"`,
      '',
      '[storage]',
      `allowed_host_paths = ["${input.workspacePath}", "${input.sessionStorageRoot}"]`,
      'volume_default_size = "1Gi"',
      '',
      '[store]',
      'type = "sqlite"',
      'path = "/workspace/.openlink/opensandbox.db"',
      '',
      '[docker]',
      'network_mode = "bridge"',
      // Rootless Podman maps container root to a subordinate UID by default.
      // The Project VM keeps session roots mode 0700, so ask Podman to map the
      // VM owner into the sandbox instead of weakening those permissions.
      ...(!this.rootful ? ['userns_mode = "keep-id"'] : []),
      // The OpenSandbox server runs in its own Project VM container. Its
      // server-proxy route must reach host-published execd ports through the
      // Podman gateway rather than the server container's own 127.0.0.1.
      'host_ip = "host.containers.internal"',
      'port_range_min = 44000',
      'port_range_max = 50000',
      // Fedora CoreOS labels bind mounts by default. The Project VM is the
      // isolation boundary, so disable only the inner SELinux label check for
      // session containers in both rootful and rootless Podman modes. Without
      // this, a bind mount created from the VM workspace keeps its
      // `user_home_t` label and even uid 0 inside the sandbox is denied write
      // access; Pi then fails when it appends its native JSONL session. The VM
      // boundary and the OpenSandbox capability policy remain enforced.
      'security_opts = ["label=disable"]',
      // The agent worker opts into the execd bubblewrap bootstrap extension,
      // which intentionally adds CAP_SYS_ADMIN to the main container. Podman
      // rejects a capability that appears in both CapDrop and CapAdd, so keep
      // SYS_ADMIN out of the drop list here. It is still unavailable to normal
      // workloads because it is not granted unless that explicit extension is
      // present; the remaining capabilities stay dropped for every sandbox.
      'drop_capabilities = ["AUDIT_WRITE", "MKNOD", "NET_ADMIN", "NET_RAW", "SYS_MODULE", "SYS_PTRACE", "SYS_TIME", "SYS_TTY_CONFIG"]',
      'no_new_privileges = true',
      'pids_limit = 4096',
      '',
      '[egress]',
      `image = "${input.egressImage}"`,
      'mode = "dns+nft"',
      'disable_ipv6 = true',
      '',
      '[ingress]',
      'mode = "direct"',
      '',
    ].join('\n')
  }

  private async writeOpenSandboxConfig(
    runInMachine: (name: string, command: string, args?: string[]) => Promise<ProjectVmCommandResult>,
    input: ProjectRuntimeServiceInput,
    config: string,
  ): Promise<void> {
    const encoded = Buffer.from(config, 'utf8').toString('base64')
    const path = `${input.workspacePath}/.openlink/opensandbox.toml`
    await runInMachine(input.machineName, 'bash', ['-lc', `mkdir -p ${input.workspacePath}/.openlink && printf %s ${encoded} | base64 -d > ${path} && chmod 644 ${path}`])
  }

  private async ensureContainer(
    runInMachine: (name: string, command: string, args?: string[]) => Promise<ProjectVmCommandResult>,
    machine: string,
    input: {
      name: string
      image: string
      port: number
      containerPort: number
      network: string
      env: Record<string, string>
      volumes: string[]
      user?: string
      securityOpts?: string[]
      usernsMode?: string
      entrypoint?: string[]
      command?: string[]
    },
  ): Promise<boolean> {
    let exists = false
    try {
      await runInMachine(machine, 'podman', ['container', 'inspect', input.name])
      exists = true
    } catch {}
    if (exists) {
      const state = await runInMachine(machine, 'podman', ['inspect', '--format', '{{.State.Status}}', input.name])
      const imageId = await runInMachine(machine, 'podman', ['image', 'inspect', '--format', '{{.Id}}', input.image])
      const containerImageId = await runInMachine(machine, 'podman', ['inspect', '--format', '{{.Image}}', input.name])
      const expectedConfigHash = this.containerConfigHash(input)
      const containerConfigHash = await runInMachine(machine, 'podman', ['inspect', '--format', '{{index .Config.Labels "io.openlink.project-runtime-config"}}', input.name])
      // A stopped container may contain a failed bootstrap or stale mounts;
      // restarting it hides the original failure and can preserve an old
      // image/configuration. Recreate every non-running, image-mismatched, or
      // definition-mismatched service container from the current Project VM.
      if (state.stdout.trim() !== 'running'
        || containerImageId.stdout.trim() !== imageId.stdout.trim()
        || containerConfigHash.stdout.trim() !== expectedConfigHash) {
        await runInMachine(machine, 'podman', ['rm', '--force', input.name])
      } else {
        return false
      }
    }
    const expectedConfigHash = this.containerConfigHash(input)
    const args = ['run', '--detach', '--name', input.name, '--network', input.network, '--publish', `127.0.0.1:${input.port}:${input.containerPort}`]
    args.push('--label', `io.openlink.project-runtime-config=${expectedConfigHash}`)
    if (input.usernsMode) args.push('--userns', input.usernsMode)
    if (input.user) args.push('--user', input.user)
    for (const securityOpt of input.securityOpts ?? []) args.push('--security-opt', securityOpt)
    for (const value of input.entrypoint ?? []) args.push('--entrypoint', value)
    for (const [key, value] of Object.entries(input.env)) args.push('--env', `${key}=${value}`)
    for (const volume of input.volumes) args.push('--volume', volume)
    args.push(input.image, ...(input.command ?? []))
    await runInMachine(machine, 'podman', args)
    return true
  }

  private containerConfigHash(input: {
    name: string
    image: string
    port: number
    containerPort: number
    network: string
    env: Record<string, string>
    volumes: string[]
    user?: string
    securityOpts?: string[]
    usernsMode?: string
    entrypoint?: string[]
    command?: string[]
  }): string {
    const canonical = JSON.stringify({
      image: input.image,
      port: input.port,
      containerPort: input.containerPort,
      network: input.network,
      env: Object.fromEntries(Object.entries(input.env).sort(([left], [right]) => left.localeCompare(right))),
      volumes: input.volumes,
      user: input.user ?? null,
      securityOpts: input.securityOpts ?? [],
      usernsMode: input.usernsMode ?? null,
      entrypoint: input.entrypoint ?? [],
      command: input.command ?? [],
    })
    return createHash('sha256').update(canonical).digest('hex')
  }

  private async waitForEndpoint(url: string, path: string): Promise<void> {
    const deadline = Date.now() + 120_000
    let lastError: unknown
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`${url}${path}`, { signal: AbortSignal.timeout(2_000) })
        if (response.ok) return
        lastError = new Error(`HTTP ${response.status}`)
      } catch (error) {
        lastError = error
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 250))
    }
    throw new AgentHostError('PROVISIONING_FAILED', `Project runtime endpoint ${url} did not become ready: ${lastError instanceof Error ? lastError.message : String(lastError)}`, { retryable: true })
  }

  private async waitForMachineEndpoint(
    runInMachine: (name: string, command: string, args?: string[]) => Promise<ProjectVmCommandResult>,
    machine: string,
    port: number,
    path: string,
  ): Promise<void> {
    const deadline = Date.now() + 120_000
    let lastError: unknown
    while (Date.now() < deadline) {
      try {
        // Health endpoints are VM-local control-plane services. Never let a
        // developer or remote-host HTTP proxy turn a loopback probe into an
        // external request (or a proxy-generated 503 page).
        await runInMachine(machine, 'curl', ['--noproxy', '*', '--fail', '--silent', '--show-error', '--max-time', '2', `http://127.0.0.1:${port}${path}`])
        return
      } catch (error) {
        lastError = error
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 500))
    }
    throw new AgentHostError('PROVISIONING_FAILED', `Project VM endpoint ${port}${path} did not become ready: ${lastError instanceof Error ? lastError.message : String(lastError)}`, { retryable: true })
  }
}
