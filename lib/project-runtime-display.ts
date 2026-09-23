import type { Translator } from '@/lib/i18n/messages'

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

function phaseLabel(phase: NonNullable<ProjectRuntimeDisplayInput['runtime_phase']>, t: Translator): string {
  return {
    queued: t("等待调度"),
    claimed: t("调度器已认领"),
    starting_vm: t("正在启动 VM"),
    configuring_runtime: t("正在配置运行环境"),
    starting_project_database: t("正在启动项目数据库"),
    starting_agent_services: t("正在启动 Agent 服务"),
    connecting_services: t("正在连接项目服务"),
    retry_wait: t("等待自动重试"),
    ready: t("运行环境已就绪"),
    stopped: t("运行环境已停止"),
    deleting: t("正在删除运行环境"),
    failed: t("运行环境初始化失败"),
  }[phase]
}

function relativeFuture(value: string, now: number, t: Translator): string {
  const milliseconds = new Date(value).getTime() - now
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return t("即将重试")
  const seconds = Math.ceil(milliseconds / 1_000)
  if (seconds < 60) return t("{count} 秒后重试", { count: seconds })
  const minutes = Math.ceil(seconds / 60)
  return minutes < 60
    ? t("{count} 分钟后重试", { count: minutes })
    : t("{count} 小时后重试", { count: Math.ceil(minutes / 60) })
}

function diagnosticSummary(value: string | null): string | null {
  if (!value?.trim()) return null
  return value.trim().replace(/(bearer|token|password|secret|api[_-]?key)\s*[=:]\s*\S+/gi, '$1=<redacted>').slice(0, 240)
}

export function projectRuntimeDisplay(project: ProjectRuntimeDisplayInput, t: Translator, now = Date.now()): ProjectRuntimeDisplay {
  const ready = project.status === 'active' && project.runtime_status === 'ready' && !project.runtime_claimed
  if (ready) return { ready: true, failed: false, spinning: false, label: t("运行环境已就绪"), detail: t("项目可创建对话"), diagnostic: null }
  if (project.status === "archived") return { ready: false, failed: false, spinning: false, label: t("项目已归档"), detail: t("恢复项目后才能创建对话"), diagnostic: null }
  if (!project.runtime_status) return { ready: false, failed: true, spinning: false, label: t("尚未进入初始化队列"), detail: t("运行环境记录缺失，需要重新初始化"), diagnostic: null }

  const attempt = project.runtime_provisioning_attempts > 0
    ? t("第 {count} 次尝试", { count: project.runtime_provisioning_attempts })
    : t("尚未开始尝试")
  const diagnostic = diagnosticSummary(project.runtime_error)
  if (project.runtime_phase === "failed") return { ready: false, failed: true, spinning: false, label: t("初始化失败，已停止自动重试"), detail: attempt, diagnostic }
  if (project.runtime_status === 'ready' && project.runtime_claimed) {
    const leaseExpired = project.runtime_provisioning_lease_expires_at
      ? new Date(project.runtime_provisioning_lease_expires_at).getTime() <= now
      : false
    return leaseExpired
      ? { ready: false, failed: true, spinning: false, label: t("运行状态冲突，调度租约已过期"), detail: t("{attempt} · Ready 状态仍被调度器占用", { attempt }), diagnostic }
      : { ready: false, failed: false, spinning: true, label: t("运行环境已上报就绪，正在完成调度"), detail: attempt, diagnostic }
  }
  if (project.runtime_status === "ready") return { ready: false, failed: false, spinning: true, label: t("运行环境已就绪，项目状态同步中"), detail: attempt, diagnostic }
  if (project.runtime_status === 'deleting') return { ready: false, failed: false, spinning: true, label: phaseLabel('deleting', t), detail: attempt, diagnostic }
  if (project.runtime_status === "stopped") return { ready: false, failed: false, spinning: false, label: t("运行环境已停止"), detail: t("等待重新调度"), diagnostic }
  if (project.runtime_status === 'error') {
    const retryAt = project.runtime_provisioning_next_attempt_at
    const terminal = retryAt ? new Date(retryAt).getTime() - now > 180 * 24 * 60 * 60 * 1_000 : false
    if (terminal) return { ready: false, failed: true, spinning: false, label: t("初始化失败，已停止自动重试"), detail: attempt, diagnostic }
    return { ready: false, failed: false, spinning: true, label: t("初始化失败，等待自动重试"), detail: retryAt ? `${attempt} · ${relativeFuture(retryAt, now, t)}` : t("{attempt} · 即将重试", { attempt }), diagnostic }
  }

  const leaseExpired = project.runtime_provisioning_lease_expires_at
    ? new Date(project.runtime_provisioning_lease_expires_at).getTime() <= now
    : false
  if (project.runtime_claimed && leaseExpired) return { ready: false, failed: true, spinning: false, label: t("初始化任务租约已过期"), detail: t("{attempt} · 等待其他调度器接管", { attempt }), diagnostic }
  const phase = project.runtime_phase ?? (project.runtime_claimed ? 'claimed' : 'queued')
  return { ready: false, failed: false, spinning: true, label: phaseLabel(phase, t), detail: attempt, diagnostic }
}
