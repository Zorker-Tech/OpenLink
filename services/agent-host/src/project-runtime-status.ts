import type { ProjectVmBackend, ProjectVmDiskMode } from './project-vm.js'

export type ProjectRuntimeStatus = 'provisioning' | 'ready' | 'stopped' | 'error' | 'deleting'
export type ProjectRuntimeProvisioningPhase = 'queued' | 'claimed' | 'starting_vm' | 'configuring_runtime'
  | 'starting_project_database' | 'starting_agent_services' | 'connecting_services'
  | 'retry_wait' | 'ready' | 'stopped' | 'deleting' | 'failed'

export interface ProjectRuntimeStatusUpdate {
  projectId: string
  backend: ProjectVmBackend
  machineName: string
  workspacePath: string
  status: ProjectRuntimeStatus
  phase?: ProjectRuntimeProvisioningPhase
  opensandboxEndpoint?: string
  browserHostEndpoint?: string
  desiredCpus?: number
  desiredMemoryMb?: number
  desiredDiskGb?: number
  diskMode?: ProjectVmDiskMode
  lastError?: string | null
}

export interface ProjectRuntimeStatusWriter {
  update(update: ProjectRuntimeStatusUpdate): Promise<void>
}

export interface SupabaseProjectRuntimeStatusWriterOptions {
  url: string
  serviceRoleKey: string
  fetch?: typeof globalThis.fetch
  timeoutMs?: number
}

function normalizeUrl(value: string): string {
  return value.trim().replace(/\/$/, '')
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000)
}

/**
 * Privileged Agent Host writer for the project_runtimes projection.
 *
 * The browser never receives this key. The writer is intentionally injected
 * into the runtime manager so the manager remains usable with local tests and
 * installations that do not expose Supabase service-role credentials.
 */
export class SupabaseProjectRuntimeStatusWriter implements ProjectRuntimeStatusWriter {
  private readonly baseUrl: string
  private readonly serviceRoleKey: string
  private readonly fetchImpl: typeof globalThis.fetch
  private readonly timeoutMs: number

  constructor(options: SupabaseProjectRuntimeStatusWriterOptions) {
    if (!options.url.trim()) throw new Error('Supabase URL is required')
    if (!options.serviceRoleKey.trim()) throw new Error('Supabase service-role key is required')
    this.baseUrl = normalizeUrl(options.url)
    this.serviceRoleKey = options.serviceRoleKey.trim()
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.timeoutMs = Math.max(1_000, options.timeoutMs ?? 10_000)
  }

  async update(update: ProjectRuntimeStatusUpdate): Promise<void> {
    const phase = update.phase ?? (update.status === 'ready' ? 'ready'
      : update.status === 'stopped' ? 'stopped'
        : update.status === 'deleting' ? 'deleting'
          : update.status === 'error' ? 'failed'
            : 'configuring_runtime')
    const payload = {
      project_id: update.projectId,
      backend: update.backend,
      machine_name: update.machineName,
      workspace_path: update.workspacePath,
      status: update.status,
      provisioning_phase: phase,
      provisioning_phase_updated_at: new Date().toISOString(),
      ...(update.opensandboxEndpoint !== undefined ? { opensandbox_endpoint: update.opensandboxEndpoint } : {}),
      ...(update.browserHostEndpoint !== undefined ? { browser_host_endpoint: update.browserHostEndpoint } : {}),
      ...(update.desiredCpus !== undefined ? { desired_cpus: update.desiredCpus } : {}),
      ...(update.desiredMemoryMb !== undefined ? { desired_memory_mb: update.desiredMemoryMb } : {}),
      ...(update.desiredDiskGb !== undefined ? { desired_disk_gb: update.desiredDiskGb } : {}),
      ...(update.diskMode !== undefined ? { disk_mode: update.diskMode } : {}),
      ...(update.lastError !== undefined ? { last_error: update.lastError } : {}),
      updated_at: new Date().toISOString(),
      ...(update.status === 'ready' ? {
        started_at: new Date().toISOString(),
        stopped_at: null,
        provisioning_claimed_by: null,
        provisioning_lease_expires_at: null,
        provisioning_next_attempt_at: null,
      } : {}),
      ...(update.status === 'stopped' ? { stopped_at: new Date().toISOString() } : {}),
    }
    const response = await this.fetchImpl(`${this.baseUrl}/rest/v1/project_runtimes?on_conflict=project_id`, {
      method: 'POST',
      headers: {
        apikey: this.serviceRoleKey,
        Authorization: `Bearer ${this.serviceRoleKey}`,
        'Content-Type': 'application/json',
        'Accept-Profile': 'openlink',
        'Content-Profile': 'openlink',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(`Supabase project runtime status update failed (${response.status}): ${detail.slice(0, 500)}`)
    }
  }
}

export function createSupabaseProjectRuntimeStatusWriter(env: NodeJS.ProcessEnv = process.env): ProjectRuntimeStatusWriter | undefined {
  const url = env.OPENLINK_SUPABASE_URL?.trim() || env.NEXT_PUBLIC_SUPABASE_URL?.trim()
  const serviceRoleKey = env.OPENLINK_SUPABASE_SERVICE_ROLE_KEY?.trim()
  if (!url || !serviceRoleKey) return undefined
  try {
    return new SupabaseProjectRuntimeStatusWriter({ url, serviceRoleKey })
  } catch (error) {
    console.warn(`OpenLink Supabase runtime status writer disabled: ${safeError(error)}`)
    return undefined
  }
}
