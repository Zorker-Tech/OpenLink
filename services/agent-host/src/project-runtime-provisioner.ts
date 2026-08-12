import { randomUUID } from 'node:crypto'
import type { ProjectRuntimeManager } from './project-runtime.js'
import type { ProjectVmDiskMode } from './project-vm.js'

export type ProjectRuntimeExecutionMode = 'local' | 'ssh'

export interface ProjectRuntimeProvisioningClaim {
  projectId: string
  attempt: number
  diskMode: ProjectVmDiskMode
}

export interface ProjectRuntimeProvisioningQueue {
  claim(workerId: string, leaseMs: number): Promise<ProjectRuntimeProvisioningClaim | null>
  renew(projectId: string, workerId: string, leaseMs: number): Promise<boolean>
  complete(projectId: string, workerId: string): Promise<void>
  fail(projectId: string, workerId: string, retryAt: Date): Promise<void>
}

export interface ProjectRuntimeProvisionerOptions {
  queue: ProjectRuntimeProvisioningQueue
  runtimeManager: Pick<ProjectRuntimeManager, 'ensure'>
  workerId?: string
  pollIntervalMs?: number
  leaseMs?: number
  retryBaseMs?: number
}

/** Reconciles durable Project runtime desired state without blocking web UI. */
export class ProjectRuntimeProvisioner {
  private readonly queue: ProjectRuntimeProvisioningQueue
  private readonly runtimeManager: Pick<ProjectRuntimeManager, 'ensure'>
  private readonly workerId: string
  private readonly pollIntervalMs: number
  private readonly leaseMs: number
  private readonly retryBaseMs: number
  private timer?: NodeJS.Timeout
  private active?: Promise<boolean>
  private closing = false

  constructor(options: ProjectRuntimeProvisionerOptions) {
    this.queue = options.queue
    this.runtimeManager = options.runtimeManager
    this.workerId = options.workerId ?? `agent-${randomUUID()}`
    this.pollIntervalMs = Math.max(250, options.pollIntervalMs ?? 2_000)
    this.leaseMs = Math.max(10_000, options.leaseMs ?? 5 * 60_000)
    this.retryBaseMs = Math.max(1_000, options.retryBaseMs ?? 5_000)
  }

  start(): void {
    if (this.closing || this.timer || this.active) return
    this.schedule(0)
  }

  async runOnce(): Promise<boolean> {
    if (this.closing) return false
    const claim = await this.queue.claim(this.workerId, this.leaseMs)
    if (!claim) return false

    let leaseLost = false
    const heartbeat = setInterval(() => {
      void this.queue.renew(claim.projectId, this.workerId, this.leaseMs)
        .then((renewed) => { if (!renewed) leaseLost = true })
        .catch((error) => {
          leaseLost = true
          console.error(`OpenLink Project runtime lease renewal failed for ${claim.projectId}: ${safeError(error)}`)
        })
    }, Math.max(5_000, Math.floor(this.leaseMs / 3)))
    heartbeat.unref?.()

    try {
      await this.runtimeManager.ensure(claim.projectId, claim.diskMode)
      // Provisioning itself is idempotent, but never let a host which lost its
      // claim clear a newer host's lease.
      if (!leaseLost) await this.queue.complete(claim.projectId, this.workerId)
      return true
    } catch (error) {
      const exponent = Math.min(6, Math.max(0, claim.attempt - 1))
      const retryAt = new Date(Date.now() + this.retryBaseMs * 2 ** exponent)
      if (!leaseLost) await this.queue.fail(claim.projectId, this.workerId, retryAt)
      console.error(`OpenLink eager Project runtime provisioning failed for ${claim.projectId}: ${safeError(error)}`)
      return true
    } finally {
      clearInterval(heartbeat)
    }
  }

  async close(): Promise<void> {
    this.closing = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    await this.active?.catch(() => undefined)
  }

  private schedule(delayMs: number): void {
    if (this.closing) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.active = this.runOnce()
      void this.active
        .then((claimed) => this.schedule(claimed ? 0 : this.pollIntervalMs))
        .catch((error) => {
          console.error(`OpenLink Project runtime provisioner poll failed: ${safeError(error)}`)
          this.schedule(this.pollIntervalMs)
        })
        .finally(() => { this.active = undefined })
    }, delayMs)
    this.timer.unref?.()
  }
}

export interface SupabaseProjectRuntimeProvisioningQueueOptions {
  url: string
  serviceRoleKey: string
  fetch?: typeof globalThis.fetch
  timeoutMs?: number
  /** Each Agent Host consumes only the execution target it owns. */
  executionMode?: ProjectRuntimeExecutionMode
}

interface ProvisioningRow {
  project_id: string
  provisioning_attempts: number
  disk_mode: ProjectVmDiskMode
}

export class SupabaseProjectRuntimeProvisioningQueue implements ProjectRuntimeProvisioningQueue {
  private readonly baseUrl: string
  private readonly serviceRoleKey: string
  private readonly fetchImpl: typeof globalThis.fetch
  private readonly timeoutMs: number
  private readonly executionMode: ProjectRuntimeExecutionMode

  constructor(options: SupabaseProjectRuntimeProvisioningQueueOptions) {
    if (!options.url.trim()) throw new Error('Supabase URL is required')
    if (!options.serviceRoleKey.trim()) throw new Error('Supabase service-role key is required')
    this.baseUrl = options.url.trim().replace(/\/$/, '')
    this.serviceRoleKey = options.serviceRoleKey.trim()
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.timeoutMs = Math.max(1_000, options.timeoutMs ?? 10_000)
    this.executionMode = options.executionMode ?? 'local'
  }

  async claim(workerId: string, leaseMs: number): Promise<ProjectRuntimeProvisioningClaim | null> {
    const now = new Date()
    // PostgREST's `and` query parameter accepts a parenthesized logic list;
    // including another `and(...)` wrapper makes the logic-tree parser reject
    // the request with PGRST100.
    const eligibility = `(or(provisioning_lease_expires_at.is.null,provisioning_lease_expires_at.lt.${now.toISOString()}),or(provisioning_next_attempt_at.is.null,provisioning_next_attempt_at.lte.${now.toISOString()}))`
    const candidates = new URLSearchParams({
      select: 'project_id,provisioning_attempts,disk_mode',
      status: 'in.(provisioning,stopped,error)',
      execution_mode: `eq.${this.executionMode}`,
      and: eligibility,
      order: 'created_at.asc',
      limit: '8',
    })
    const response = await this.request(`?${candidates.toString()}`, { method: 'GET' })
    const rows = await response.json() as ProvisioningRow[]

    for (const row of rows) {
      const attempt = Math.max(0, Number(row.provisioning_attempts) || 0) + 1
      const filters = this.claimFilters(row.project_id, eligibility)
      const claimed = await this.request(`?${filters.toString()}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          status: 'provisioning',
          provisioning_claimed_by: workerId,
          provisioning_lease_expires_at: new Date(now.getTime() + leaseMs).toISOString(),
          provisioning_attempts: attempt,
          provisioning_next_attempt_at: null,
          updated_at: now.toISOString(),
        }),
      })
      const claimedRows = await claimed.json() as ProvisioningRow[]
      if (claimedRows.length) return { projectId: row.project_id, attempt, diskMode: row.disk_mode }
    }
    return null
  }

  async renew(projectId: string, workerId: string, leaseMs: number): Promise<boolean> {
    const params = new URLSearchParams({
      project_id: `eq.${projectId}`,
      provisioning_claimed_by: `eq.${workerId}`,
      status: 'eq.provisioning',
      select: 'project_id',
    })
    const response = await this.request(`?${params.toString()}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        provisioning_lease_expires_at: new Date(Date.now() + leaseMs).toISOString(),
        updated_at: new Date().toISOString(),
      }),
    })
    return ((await response.json()) as unknown[]).length === 1
  }

  async complete(projectId: string, workerId: string): Promise<void> {
    await this.release(projectId, workerId, null)
  }

  async fail(projectId: string, workerId: string, retryAt: Date): Promise<void> {
    await this.release(projectId, workerId, retryAt)
  }

  private async release(projectId: string, workerId: string, retryAt: Date | null): Promise<void> {
    const params = new URLSearchParams({
      project_id: `eq.${projectId}`,
      provisioning_claimed_by: `eq.${workerId}`,
    })
    await this.request(`?${params.toString()}`, {
      method: 'PATCH',
      body: JSON.stringify({
        provisioning_claimed_by: null,
        provisioning_lease_expires_at: null,
        provisioning_next_attempt_at: retryAt?.toISOString() ?? null,
        updated_at: new Date().toISOString(),
      }),
    })
  }

  private claimFilters(projectId: string, eligibility: string): URLSearchParams {
    const filters = new URLSearchParams()
    filters.set('project_id', `eq.${projectId}`)
    filters.set('status', 'in.(provisioning,stopped,error)')
    filters.set('execution_mode', `eq.${this.executionMode}`)
    filters.set('and', eligibility)
    filters.set('select', 'project_id,provisioning_attempts,disk_mode')
    return filters
  }

  private async request(query: string, init: RequestInit): Promise<Response> {
    const response = await this.fetchImpl(`${this.baseUrl}/rest/v1/project_runtimes${query}`, {
      ...init,
      headers: {
        apikey: this.serviceRoleKey,
        Authorization: `Bearer ${this.serviceRoleKey}`,
        'Content-Type': 'application/json',
        'Accept-Profile': 'openlink',
        'Content-Profile': 'openlink',
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(`Project runtime provisioning queue failed (${response.status}): ${detail.slice(0, 500)}`)
    }
    return response
  }
}

export function createSupabaseProjectRuntimeProvisioningQueue(
  env: NodeJS.ProcessEnv = process.env,
): SupabaseProjectRuntimeProvisioningQueue | undefined {
  const url = env.OPENLINK_SUPABASE_URL?.trim() || env.NEXT_PUBLIC_SUPABASE_URL?.trim()
  const serviceRoleKey = env.OPENLINK_SUPABASE_SERVICE_ROLE_KEY?.trim()
  if (!url || !serviceRoleKey) return undefined
  return new SupabaseProjectRuntimeProvisioningQueue({ url, serviceRoleKey })
}

/** Queue for project-scoped strict SSH provisioners; never falls back local. */
export function createSupabaseSshProjectRuntimeProvisioningQueue(
  env: NodeJS.ProcessEnv = process.env,
): SupabaseProjectRuntimeProvisioningQueue | undefined {
  const url = env.OPENLINK_SUPABASE_URL?.trim() || env.NEXT_PUBLIC_SUPABASE_URL?.trim()
  const serviceRoleKey = env.OPENLINK_SUPABASE_SERVICE_ROLE_KEY?.trim()
  if (!url || !serviceRoleKey) return undefined
  try {
    return new SupabaseProjectRuntimeProvisioningQueue({ url, serviceRoleKey, executionMode: 'ssh' })
  } catch (error) {
    console.warn(`OpenLink SSH project runtime provisioning queue disabled: ${safeError(error)}`)
    return undefined
  }
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000)
}
