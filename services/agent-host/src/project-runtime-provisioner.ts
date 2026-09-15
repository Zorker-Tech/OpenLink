import { createHash, randomUUID } from 'node:crypto'
import type { ProjectRuntimeManager } from './project-runtime.js'
import type { ProjectVmDiskMode } from './project-vm.js'

export type ProjectRuntimeExecutionMode = 'local' | 'ssh'

// Match project_runtimes_provisioning_claim_check. Older launchers persisted
// base64url identities (including '_' and non-alphanumeric first characters).
// Map those deterministically, without rotating valid identities or leases.
const provisionerIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
export function normalizeProjectRuntimeProvisionerId(value: string): string {
  const id = value.trim()
  if (!id) throw new Error('Project runtime provisioner worker ID is empty')
  return provisionerIdPattern.test(id)
    ? id
    : `agent-${createHash('sha256').update(id).digest('hex')}`
}

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
  /** Records a terminal failure so the row is never re-claimed automatically. */
  terminalFail(projectId: string, workerId: string, message: string): Promise<void>
}

export interface ProjectRuntimeProvisionerOptions {
  queue: ProjectRuntimeProvisioningQueue
  runtimeManager: Pick<ProjectRuntimeManager, 'ensure'>
  workerId?: string
  pollIntervalMs?: number
  leaseMs?: number
  retryBaseMs?: number
  /** Exponential backoff ceiling in milliseconds. */
  retryMaxMs?: number
  /** Random jitter fraction applied to each backoff step (0 disables jitter). */
  jitterFactor?: number
  /** Maximum automatic attempts before the row enters a terminal error state. */
  maxAttempts?: number
}

/** Reconciles durable Project runtime desired state without blocking web UI. */
export class ProjectRuntimeProvisioner {
  private readonly queue: ProjectRuntimeProvisioningQueue
  private readonly runtimeManager: Pick<ProjectRuntimeManager, 'ensure'>
  private readonly workerId: string
  private readonly pollIntervalMs: number
  private readonly leaseMs: number
  private readonly retryBaseMs: number
  private readonly retryMaxMs: number
  private readonly maxExponent: number
  private readonly jitterFactor: number
  private readonly maxAttempts: number
  private timer?: NodeJS.Timeout
  private active?: Promise<boolean>
  private closing = false

  constructor(options: ProjectRuntimeProvisionerOptions) {
    this.queue = options.queue
    this.runtimeManager = options.runtimeManager
    this.workerId = normalizeProjectRuntimeProvisionerId(options.workerId ?? `agent-${randomUUID()}`)
    this.pollIntervalMs = Math.max(250, options.pollIntervalMs ?? 2_000)
    this.leaseMs = Math.max(10_000, options.leaseMs ?? 5 * 60_000)
    this.retryBaseMs = Math.max(1_000, options.retryBaseMs ?? 5_000)
    this.retryMaxMs = Math.max(this.retryBaseMs, options.retryMaxMs ?? 5 * 60_000)
    // Largest exponent whose backoff stays at or under the ceiling.
    this.maxExponent = Math.max(0, Math.ceil(Math.log2(this.retryMaxMs / this.retryBaseMs)))
    this.jitterFactor = Math.max(0, Math.min(1, options.jitterFactor ?? 0.25))
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 50)
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
      // `ensure()` writes ready before returning. A renewal can therefore
      // observe status != provisioning and set leaseLost even though a ready
      // row cannot be claimed by another worker. Always conditionally release
      // this worker id; release itself cannot clear another worker's claim.
      await this.queue.complete(claim.projectId, this.workerId)
      return true
    } catch (error) {
      const message = safeError(error)
      if (claim.attempt >= this.maxAttempts) {
        // Exhausted: record a terminal error so the row is excluded from the
        // claim filter and cannot be retried automatically. A human must reset
        // the runtime (or its lease) to attempt again.
        // The conditional release is safe even after a lost lease: it can
        // clear only this worker's own claim. Always attempt it so a concurrent
        // ready projection cannot strand a `ready + claimed` contradiction.
        await this.queue.terminalFail(claim.projectId, this.workerId, message)
        console.error(`OpenLink Project runtime provisioning exhausted after ${claim.attempt} attempts for ${claim.projectId}: ${message}`)
        return true
      }
      const exponent = Math.min(this.maxExponent, Math.max(0, claim.attempt - 1))
      const baseDelay = this.retryBaseMs * 2 ** exponent
      const jittered = baseDelay + Math.round((Math.random() * 2 - 1) * this.jitterFactor * baseDelay)
      const retryAt = new Date(Date.now() + Math.min(this.retryMaxMs, Math.max(0, jittered)))
      if (!leaseLost) await this.queue.fail(claim.projectId, this.workerId, retryAt)
      console.error(`OpenLink eager Project runtime provisioning failed for ${claim.projectId}: ${message}`)
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
    if (!provisionerIdPattern.test(workerId)) throw new Error('Project runtime provisioner worker ID is invalid')
    // PostgREST's `and` query parameter accepts a parenthesized logic list;
    // including another `and(...)` wrapper makes the logic-tree parser reject
    // the request with PGRST100.
    // A stable worker identity may immediately reclaim its own lease after a
    // supervisor restart. Without this branch every clean application restart
    // leaves active Projects cold until the old five-minute lease expires.
    const eligibility = `(or(provisioning_lease_expires_at.is.null,provisioning_lease_expires_at.lt.${now.toISOString()},provisioning_claimed_by.eq.${workerId}),or(provisioning_next_attempt_at.is.null,provisioning_next_attempt_at.lte.${now.toISOString()}))`
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
          provisioning_phase: 'claimed',
          provisioning_phase_updated_at: now.toISOString(),
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
    await this.release(projectId, workerId, null, undefined, false, 'ready')
  }

  async fail(projectId: string, workerId: string, retryAt: Date): Promise<void> {
    await this.release(projectId, workerId, retryAt, undefined, false, 'retry_wait')
  }

  async terminalFail(projectId: string, workerId: string, message: string): Promise<void> {
    await this.release(projectId, workerId, null, message, true, 'failed')
  }

  private async release(projectId: string, workerId: string, retryAt: Date | null, lastError?: string, terminal = false, phase?: 'ready' | 'retry_wait' | 'failed'): Promise<void> {
    const now = new Date()
    const patch: Record<string, unknown> = {
      ...(phase === 'ready' ? { status: 'ready' }
        : phase === 'retry_wait' || phase === 'failed' ? { status: 'error' }
          : {}),
      provisioning_claimed_by: null,
      provisioning_lease_expires_at: null,
      // A terminal failure parks the row a year out so the claim filter
      // (`provisioning_next_attempt_at.lte.now`) never selects it again;
      // operators can reset it explicitly to attempt a manual recovery.
      provisioning_next_attempt_at: terminal
        ? new Date(now.getTime() + 365 * 24 * 60 * 60 * 1_000).toISOString()
        : retryAt?.toISOString() ?? null,
      ...(phase ? { provisioning_phase: phase, provisioning_phase_updated_at: now.toISOString() } : {}),
      updated_at: now.toISOString(),
    }
    if (lastError !== undefined) patch.last_error = lastError.slice(0, 2_000)
    const params = new URLSearchParams({
      project_id: `eq.${projectId}`,
      provisioning_claimed_by: `eq.${workerId}`,
    })
    await this.request(`?${params.toString()}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
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
      // Postgres details may embed a full row including the private lease ID.
      // Keep only the structured error code/message, never row details.
      const error = await response.json().catch(() => null) as { code?: unknown; message?: unknown } | null
      const code = typeof error?.code === 'string' ? error.code.slice(0, 32) : 'UNKNOWN'
      const message = typeof error?.message === 'string' ? safeError(new Error(error.message)).slice(0, 300) : 'Request failed'
      throw new Error(`Project runtime provisioning queue failed (${response.status}): ${code} ${message}`)
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
