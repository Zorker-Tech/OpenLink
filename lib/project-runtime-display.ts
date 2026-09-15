export interface ProjectRuntimeDisplayInput {
  status: 'waiting' | 'active' | 'archived'
  runtime_status: 'provisioning' | 'ready' | 'stopped' | 'error' | 'deleting' | null
  runtime_phase: 'queued' | 'claimed' | 'starting_vm' | 'configuring_runtime'
    | 'starting_project_database' | 'starting_agent_services' | 'connecting_services'
    | 'retry_wait' | 'ready' | 'stopped' | 'deleting' | 'failed' | null
  runtime_phase_updated_at: string | null
  runtime_provisioning_attempts: number
  runtime_provisioning_next_attempt_at: string | null
  runtime_provisioning_lease_expires_at: string | null
  runtime_claimed: boolean
  runtime_error: string | null
}

export interface ProjectRuntimeDisplay {
  ready: boolean
  failed: boolean
  spinning: boolean
  label: string
  detail: string
  diagnostic: string | null
}

const phaseLabels: Record<NonNullable<ProjectRuntimeDisplayInput['runtime_phase']>, string> = {
  queued: '等待调度',
  claimed: '调度器已认领',
  starting_vm: '正在启动 VM',
  configuring_runtime: '正在配置运行环境',
  starting_project_database: '正在启动项目数据库',
  starting_agent_services: '正在启动 Agent 服务',
  connecting_services: '正在连接项目服务',
  retry_wait: '等待自动重试',
  ready: '运行环境已就绪',
  stopped: '运行环境已停止',
  deleting: '正在删除运行环境',
  failed: '运行环境初始化失败',
}

function relativeFuture(value: string, now: number): string {
  const milliseconds = new Date(value).getTime() - now
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return '即将重试'
  const seconds = Math.ceil(milliseconds / 1_000)
  if (seconds < 60) return `${seconds} 秒后重试`
  const minutes = Math.ceil(seconds / 60)
  return minutes < 60 ? `${minutes} 分钟后重试` : `${Math.ceil(minutes / 60)} 小时后重试`
}

function diagnosticSummary(value: string | null): string | null {
  if (!value?.trim()) return null
  return value.trim().replace(/(bearer|token|password|secret|api[_-]?key)\s*[=:]\s*\S+/gi, '$1=<redacted>').slice(0, 240)
}

export function projectRuntimeDisplay(project: ProjectRuntimeDisplayInput, now = Date.now()): ProjectRuntimeDisplay {
  const ready = project.status === 'active' && project.runtime_status === 'ready' && !project.runtime_claimed
  if (ready) return { ready: true, failed: false, spinning: false, label: '运行环境已就绪', detail: '项目可创建对话', diagnostic: null }
  if (project.status === 'archived') return { ready: false, failed: false, spinning: false, label: '项目已归档', detail: '恢复项目后才能创建对话', diagnostic: null }
  if (!project.runtime_status) return { ready: false, failed: true, spinning: false, label: '尚未进入初始化队列', detail: '运行环境记录缺失，需要重新初始化', diagnostic: null }

  const attempt = project.runtime_provisioning_attempts > 0 ? `第 ${project.runtime_provisioning_attempts} 次尝试` : '尚未开始尝试'
  const diagnostic = diagnosticSummary(project.runtime_error)
  if (project.runtime_phase === 'failed') return { ready: false, failed: true, spinning: false, label: '初始化失败，已停止自动重试', detail: attempt, diagnostic }
  if (project.runtime_status === 'ready' && project.runtime_claimed) {
    const leaseExpired = project.runtime_provisioning_lease_expires_at
      ? new Date(project.runtime_provisioning_lease_expires_at).getTime() <= now
      : false
    return leaseExpired
      ? { ready: false, failed: true, spinning: false, label: '运行状态冲突，调度租约已过期', detail: `${attempt} · Ready 状态仍被调度器占用`, diagnostic }
      : { ready: false, failed: false, spinning: true, label: '运行环境已上报就绪，正在完成调度', detail: attempt, diagnostic }
  }
  if (project.runtime_status === 'ready') return { ready: false, failed: false, spinning: true, label: '运行环境已就绪，项目状态同步中', detail: attempt, diagnostic }
  if (project.runtime_status === 'deleting') return { ready: false, failed: false, spinning: true, label: phaseLabels.deleting, detail: attempt, diagnostic }
  if (project.runtime_status === 'stopped') return { ready: false, failed: false, spinning: false, label: '运行环境已停止', detail: '等待重新调度', diagnostic }
  if (project.runtime_status === 'error') {
    const retryAt = project.runtime_provisioning_next_attempt_at
    const terminal = retryAt ? new Date(retryAt).getTime() - now > 180 * 24 * 60 * 60 * 1_000 : false
    if (terminal) return { ready: false, failed: true, spinning: false, label: '初始化失败，已停止自动重试', detail: attempt, diagnostic }
    return { ready: false, failed: false, spinning: true, label: '初始化失败，等待自动重试', detail: retryAt ? `${attempt} · ${relativeFuture(retryAt, now)}` : `${attempt} · 即将重试`, diagnostic }
  }

  const leaseExpired = project.runtime_provisioning_lease_expires_at
    ? new Date(project.runtime_provisioning_lease_expires_at).getTime() <= now
    : false
  if (project.runtime_claimed && leaseExpired) return { ready: false, failed: true, spinning: false, label: '初始化任务租约已过期', detail: `${attempt} · 等待其他调度器接管`, diagnostic }
  const phase = project.runtime_phase ?? (project.runtime_claimed ? 'claimed' : 'queued')
  return { ready: false, failed: false, spinning: true, label: phaseLabels[phase], detail: attempt, diagnostic }
}
