'use client'

import { Sidebar } from '@/components/app-workspace'
import { deleteChatSessionAction } from '@/app/chat/actions'
import type { ThemeMode } from '@/components/account-drawer'
import { OpenLinkThemeProvider } from '@/components/ui/theme-scope'
import type { ActiveWorkspaceSummary, PersonalWorkspaceSummary } from '@/components/workspace-switcher'
import type { OrganizationSummary } from '@/lib/organizations'
import type { ChatSessionSummary } from '@/lib/chat-session-types'
import { useT } from '@/lib/i18n/client'
import type { Translator } from '@/lib/i18n/messages'
import { theme } from '@/lib/theme'
import {
  Activity,
  ArrowLeft,
  Braces,
  ChevronRight,
  Code2,
  Database,
  Files,
  Gauge,
  KeyRound,
  Link2,
  Loader2,
  LockKeyhole,
  Radio,
  ScrollText,
  Search,
  Settings2,
  ShieldCheck,
  Table2,
  TerminalSquare,
  UsersRound,
} from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useMemo, useState } from 'react'

type DataSection = 'overview' | 'table-editor' | 'sql-editor' | 'database' | 'auth' | 'storage' | 'functions' | 'realtime' | 'api' | 'logs' | 'settings'

interface ProjectSupabaseDescriptor {
  url: string
  publishableKey: string
  anonKey: string
  revision: string
}

type ManagementOperation = 'tables' | 'database' | 'query' | 'auth-users' | 'storage-buckets' | 'functions' | 'realtime' | 'services' | 'logs'
type ManagementResult = {
  operation: ManagementOperation
  tables?: Array<{ schema: string; name: string; kind: string }>
  database?: { version?: string; size?: string; connections?: number }
  users?: Array<{ id: string; email?: string; phone?: string; createdAt?: string; lastSignInAt?: string; confirmed: boolean }>
  buckets?: Array<{ id: string; name: string; public: boolean; createdAt?: string; updatedAt?: string }>
  functions?: Array<{ name: string }>
  services?: Array<{ name: string; status: string; running: boolean }>
  service?: string
  log?: string
  query?: string
  csv?: string
}

interface ProjectSupabasePanelProps {
  activeWorkspace: ActiveWorkspaceSummary
  avatarUrl: string | null
  chatSessions: ChatSessionSummary[]
  email: string
  nickname: string
  organizations: OrganizationSummary[]
  personalWorkspace: PersonalWorkspaceSummary
  projectId: string
  projectName: string
  sessionId: string
  userId: string
  /** Render inside the chat workspace without taking over the application shell. */
  embedded?: boolean
}

function navigationItems(t: Translator): Array<{ id: DataSection; label: string; icon: React.ComponentType<{ className?: string }> }> {
  return [
    { id: "overview", label: t("概览"), icon: Gauge },
    { id: "table-editor", label: t("表编辑器"), icon: Table2 },
    { id: "sql-editor", label: t("SQL 编辑器"), icon: TerminalSquare },
    { id: "database", label: t("数据库"), icon: Database },
    { id: "auth", label: t("认证"), icon: UsersRound },
    { id: "storage", label: t("存储"), icon: Files },
    { id: 'functions', label: t('Edge Functions'), icon: Code2 },
    { id: 'realtime', label: t('Realtime'), icon: Radio },
    { id: "api", label: t("API 文档"), icon: Braces },
    { id: "logs", label: t("日志"), icon: ScrollText },
    { id: "settings", label: t("项目设置"), icon: Settings2 },
  ]
}

function sectionCopyFor(t: Translator): Record<DataSection, { eyebrow: string; title: string; description: string }> {
  return {
    overview: { eyebrow: "PROJECT BACKEND", title: t("后端概览"), description: t("项目级 Supabase 服务在独立 VM 内运行；OpenLink 只展示经过授权的运行信息。") },
    "table-editor": { eyebrow: "DATABASE", title: t("表编辑器"), description: t("读取 Project VM 内真实 PostgreSQL 的表目录。字段和行编辑将在受控写入审计接入后开放。") },
    "sql-editor": { eyebrow: "DATABASE", title: t("SQL 编辑器"), description: t("通过 Project VM 管理网关执行单条只读 SQL 查询；写入语句会被服务端拒绝。") },
    database: { eyebrow: "DATABASE", title: t("数据库"), description: t("检查 PostgreSQL 运行状态、连接池、扩展、索引和迁移。") },
    auth: { eyebrow: "IDENTITY", title: t("认证"), description: t("管理项目应用的用户、身份提供方、会话与访问策略。") },
    storage: { eyebrow: "OBJECT STORAGE", title: t("存储"), description: t("读取 Project VM 内真实 Storage buckets 和公开性配置。对象写入将在上传策略接入后开放。") },
    functions: { eyebrow: "EDGE RUNTIME", title: t("Edge Functions"), description: t("读取 Project VM 工作区内真实 Edge Functions 目录和入口。部署操作将在发布流水线接入后开放。") },
    realtime: { eyebrow: "STREAMING", title: t("Realtime"), description: t("管理数据库变更、广播和 Presence 实时通道。") },
    api: { eyebrow: "PROJECT API", title: t("API 文档"), description: t("项目 API 连接信息、SDK 配置与 OpenAPI/GraphQL 接口。") },
    logs: { eyebrow: "OBSERVABILITY", title: t("日志"), description: t("按服务、请求和时间范围检索项目后端日志。") },
    settings: { eyebrow: "RUNTIME", title: t("项目设置"), description: t("查看当前后端 release、运行时版本和升级状态。") },
  }
}

function maskKey(value: string, t: Translator) {
  if (value.length < 16) return t("已配置")
  return `${value.slice(0, 12)}••••${value.slice(-4)}`
}

function StatusDot({ ready }: { ready: boolean }) {
  const t = useT()
  return <span aria-label={ready ? t("运行正常") : t("正在连接")} className={`size-2 rounded-full ${ready ? "bg-[var(--app-success)]" : "bg-[var(--app-warning)]"}`} />
}

function Metric({ icon: Icon, label, value, detail }: { icon: React.ComponentType<{ className?: string }>; label: string; value: string; detail: string }) {
  return <article className="rounded-xl border border-[var(--app-control-border)] bg-[var(--app-surface)] p-4 shadow-[0_1px_2px_var(--app-shadow)]">
    <div className="flex items-center justify-between text-[var(--app-muted)]"><span className="text-xs font-medium">{label}</span><Icon className="size-4" /></div>
    <p className="mt-3 text-lg font-semibold tracking-[-0.35px] text-[var(--app-foreground)]">{value}</p>
    <p className="mt-1 text-xs leading-5 text-[var(--app-subtle-foreground)]">{detail}</p>
  </article>
}

export function ProjectSupabasePanel(props: ProjectSupabasePanelProps) {
  const router = useRouter()
  const t = useT()
  const navigation = navigationItems(t)
  const [section, setSection] = useState<DataSection>('overview')
  const [themeMode, setThemeMode] = useState<ThemeMode>('dark')
  const [systemLight, setSystemLight] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [descriptor, setDescriptor] = useState<ProjectSupabaseDescriptor | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [management, setManagement] = useState<ManagementResult | null>(null)
  const [managementLoading, setManagementLoading] = useState(false)
  const [managementError, setManagementError] = useState<string | null>(null)
  const [query, setQuery] = useState('select table_schema, table_name from information_schema.tables where table_schema = \'public\' order by table_name')
  const [queryResult, setQueryResult] = useState<ManagementResult | null>(null)
  const content = sectionCopyFor(t)[section]

  const deleteChat = useCallback(async (chatId: string) => {
    if (!window.confirm(t("确定要删除这个会话吗？删除后不可恢复。"))) return
    const result = await deleteChatSessionAction(chatId)
    if (!result.ok) {
      console.error('OpenLink session delete failed:', result.error)
      return
    }
    if (chatId === props.sessionId) router.replace(`/app/${props.activeWorkspace.slug}`)
    router.refresh()
  }, [props.activeWorkspace.slug, props.sessionId, router, t])

  const activeTheme = themeMode === 'light' || (themeMode === 'system' && systemLight) ? 'light' : 'dark'
  const descriptorLabel = useMemo(() => descriptor?.revision.replace(/^self-hosted\//, "") ?? t("正在连接"), [descriptor, t])

  useEffect(() => {
    const savedTheme = window.localStorage.getItem('openlink-theme') as ThemeMode | null
    if (savedTheme === 'system' || savedTheme === 'light' || savedTheme === 'dark') setThemeMode(savedTheme)
    const media = window.matchMedia('(prefers-color-scheme: light)')
    const update = () => setSystemLight(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  useEffect(() => {
    document.documentElement.classList.toggle('dark', activeTheme === 'dark')
  }, [activeTheme])

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    void fetch(`/api/chat/${encodeURIComponent(props.sessionId)}/supabase`, { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json().catch(() => null) as { supabase?: unknown; error?: { code?: unknown } } | null
        if (!response.ok) throw new Error(typeof payload?.error?.code === 'string' ? payload.error.code : 'PROJECT_BACKEND_UNAVAILABLE')
        const value = payload?.supabase
        if (!value || typeof value !== 'object') return null
        const candidate = value as Record<string, unknown>
        if (typeof candidate.url !== 'string' || typeof candidate.publishableKey !== 'string' || typeof candidate.anonKey !== 'string' || typeof candidate.revision !== 'string') {
          throw new Error('PROJECT_BACKEND_UNAVAILABLE')
        }
        return candidate as ProjectSupabaseDescriptor
      })
      .then((value) => { if (!controller.signal.aborted) { setDescriptor(value); setError(value ? null : 'PROJECT_BACKEND_UNAVAILABLE') } })
      .catch((reason) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'PROJECT_BACKEND_UNAVAILABLE') })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [props.sessionId])

  const requestManagement = useCallback(async (operation: ManagementOperation, extra: Record<string, string> = {}) => {
    setManagementLoading(true)
    setManagementError(null)
    try {
      const response = await fetch(`/api/chat/${encodeURIComponent(props.sessionId)}/supabase/management`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operation, ...extra }),
        cache: 'no-store',
      })
      const payload = await response.json().catch(() => null) as ManagementResult & { error?: { message?: unknown; code?: unknown } } | null
      if (!response.ok) throw new Error(typeof payload?.error?.message === 'string' ? payload.error.message : typeof payload?.error?.code === 'string' ? payload.error.code : 'PROJECT_BACKEND_UNAVAILABLE')
      setManagement(payload)
      return payload
    } catch (reason) {
      setManagement(null)
      setManagementError(reason instanceof Error ? reason.message : 'PROJECT_BACKEND_UNAVAILABLE')
      return null
    } finally {
      setManagementLoading(false)
    }
  }, [props.sessionId])

  useEffect(() => {
    const operation: ManagementOperation | undefined = {
      'table-editor': 'tables',
      database: 'database',
      auth: 'auth-users',
      storage: 'storage-buckets',
      functions: 'functions',
      realtime: 'realtime',
      logs: 'logs',
    }[section]
    if (!operation) return
    void requestManagement(operation, section === 'logs' ? { service: 'rest' } : {})
  }, [requestManagement, section])

  const runQuery = async () => {
    const result = await requestManagement('query', { query })
    if (result) setQueryResult(result)
  }

  return (
    <OpenLinkThemeProvider theme={activeTheme}>
      <div className={`openlink-app-shell flex ${props.embedded ? 'h-full min-h-0' : 'h-dvh min-h-[520px]'} overflow-hidden bg-[var(--app-background)] text-[var(--app-foreground)]`} data-theme={activeTheme}>
        {!props.embedded && <Sidebar
          activeChatId={props.sessionId}
          activeChatLabel={props.projectName}
          activeNavLabel={t("项目")}
          activeWorkspace={props.activeWorkspace}
          avatarUrl={props.avatarUrl}
          chatSessions={props.chatSessions}
          collapsed={collapsed}
          email={props.email}
          mobileOpen={mobileOpen}
          nickname={props.nickname}
          onCloseMobile={() => setMobileOpen(false)}
          onNewChat={() => router.push(`/app/${props.activeWorkspace.slug}`)}
          onDeleteChat={(chatId) => { void deleteChat(chatId) }}
          onThemeChange={(mode) => { setThemeMode(mode); window.localStorage.setItem('openlink-theme', mode) }}
          onToggle={() => setCollapsed((value) => !value)}
          organizations={props.organizations}
          personalWorkspace={props.personalWorkspace}
          themeMode={themeMode}
        />}

        <main className="flex min-w-0 flex-1 flex-col bg-[var(--app-background)]">
          {!props.embedded && <header className="flex h-[50px] shrink-0 items-center border-b border-[var(--app-border)] px-3">
            <button aria-label={t("打开侧边栏")} className="mr-1 flex size-8 items-center justify-center rounded-md text-[var(--app-muted)] hover:bg-[var(--app-hover)] md:hidden" onClick={() => { setCollapsed(false); setMobileOpen(true) }} type="button"><ChevronRight className="size-4 rotate-180" /></button>
            {collapsed && <button aria-label={t("展开侧边栏")} className="mr-1 hidden size-8 items-center justify-center rounded-md text-[var(--app-muted)] hover:bg-[var(--app-hover)] md:flex" onClick={() => setCollapsed(false)} type="button"><ChevronRight className="size-4 rotate-180" /></button>}
            <button className="flex h-8 items-center gap-1.5 rounded-md px-2 text-sm text-[var(--app-muted)] hover:bg-[var(--app-hover)] hover:text-[var(--app-foreground)]" onClick={() => router.push(`/${props.userId}/chat/${props.sessionId}`)} type="button"><ArrowLeft className="size-4" />{t("聊天")}</button>
            <ChevronRight className="size-3.5 text-[var(--app-subtle-foreground)]" />
            <span className="min-w-0 truncate px-2 text-sm font-medium">{props.projectName}</span>
            <span className="ml-1 hidden items-center gap-1.5 rounded-full bg-[var(--app-active)] px-2 py-1 text-[11px] font-medium text-[var(--app-muted)] sm:flex"><StatusDot ready={Boolean(descriptor)} />{loading ? t("连接中") : descriptor ? t("后端就绪") : t("后端不可用")}</span>
            <div className="ml-auto flex items-center gap-2">
              <span className="hidden rounded-md border border-[var(--app-control-border)] bg-[var(--app-surface)] px-2 py-1 font-mono text-[11px] text-[var(--app-muted)] md:block">{descriptorLabel}</span>
              <button className="flex h-8 items-center gap-1.5 rounded-md border border-[var(--app-control-border)] bg-[var(--app-surface)] px-2.5 text-xs font-medium text-[var(--app-foreground)] hover:bg-[var(--app-hover)]" onClick={() => setSection("settings")} type="button"><Settings2 className="size-3.5" />{t("运行时")}</button>
            </div>
          </header>}

          <div className="flex min-h-0 flex-1 overflow-hidden">
            <aside className="hidden w-[216px] shrink-0 border-r border-[var(--app-border)] bg-[var(--app-surface)] lg:flex lg:flex-col">
              <div className="border-b border-[var(--app-border)] p-3">
                <div className="flex items-center gap-2"><span className="flex size-7 items-center justify-center rounded-lg bg-[var(--app-active)] text-[var(--app-foreground)]"><Database className="size-4" /></span><div className="min-w-0"><p className="truncate text-sm font-semibold">{props.projectName}</p><p className="mt-0.5 text-[11px] text-[var(--app-subtle-foreground)]">Project backend</p></div></div>
              </div>
              <nav aria-label={t("项目数据导航")} className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2">
                {navigation.map((item, index) => {
                  const Icon = item.icon
                  const selected = item.id === section
                  const split = index === 4 || index === 8
                  return <div key={item.id}>{split && <div className="my-2 border-t border-[var(--app-border)]" />}<button aria-current={selected ? 'page' : undefined} className={`flex h-8 w-full items-center gap-2 rounded-md px-2 text-sm transition-colors ${selected ? 'bg-[var(--app-selected)] text-[var(--app-foreground)]' : 'text-[var(--app-muted)] hover:bg-[var(--app-hover)] hover:text-[var(--app-foreground)]'}`} onClick={() => setSection(item.id)} type="button"><Icon className="size-4" /><span className="truncate">{t(item.label)}</span></button></div>
                })}
              </nav>
            </aside>

            <section className="min-w-0 flex-1 overflow-y-auto">
              <div className="mx-auto w-full max-w-6xl px-5 py-7 sm:px-8">
                <div className="flex flex-wrap items-end justify-between gap-4">
                  <div><p className="text-[10px] font-semibold tracking-[0.16em] text-[var(--app-subtle-foreground)]">{content.eyebrow}</p><h1 className="mt-2 text-2xl font-semibold tracking-[-0.55px]">{content.title}</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--app-muted)]">{content.description}</p></div>
                </div>

                {section === 'overview' && <>
                  <div className="mt-7 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                    <Metric detail={descriptor ? `revision ${descriptor.revision}` : t("正在验证项目后端")} icon={Activity} label={t("后端运行时")} value={descriptor ? "Ready" : "Connecting"} />
                    <Metric detail={t("项目独立 PostgreSQL 数据域")} icon={Database} label={t("数据库")} value="PostgreSQL" />
                    <Metric detail={t("Auth、RLS 与应用身份")} icon={ShieldCheck} label={t("认证与安全")} value="Supabase Auth" />
                    <Metric detail={t("对象、上传与访问策略")} icon={Files} label={t("存储")} value="Object Storage" />
                  </div>
                  <section className="mt-6 grid gap-4 lg:grid-cols-[1.35fr_0.65fr]">
                    <article className="rounded-xl border border-[var(--app-control-border)] bg-[var(--app-surface)] p-5 shadow-[0_1px_2px_var(--app-shadow)]"><div className="flex items-start justify-between gap-4"><div><h2 className="text-sm font-semibold">{t("项目 API")}</h2><p className="mt-1 text-sm leading-5 text-[var(--app-muted)]">{t("供项目应用连接 Auth、REST、Realtime、Storage 和 Functions 的受控入口。")}</p></div><Link2 className="size-4 text-[var(--app-muted)]" /></div>{loading ? <div className="mt-5 flex items-center gap-2 text-sm text-[var(--app-muted)]"><Loader2 className="size-4 animate-spin" />{t("正在获取连接状态…")}</div> : descriptor ? <dl className="mt-5 divide-y divide-[var(--app-border)] rounded-lg border border-[var(--app-border)] bg-[var(--app-background)] text-sm"><div className="flex items-center justify-between gap-4 px-3 py-2.5"><dt className="text-[var(--app-muted)]">Gateway</dt><dd className="truncate font-mono text-xs text-[var(--app-foreground)]">{descriptor.url}</dd></div><div className="flex items-center justify-between gap-4 px-3 py-2.5"><dt className="text-[var(--app-muted)]">Publishable key</dt><dd className="font-mono text-xs text-[var(--app-foreground)]">{maskKey(descriptor.publishableKey, t)}</dd></div><div className="flex items-center justify-between gap-4 px-3 py-2.5"><dt className="text-[var(--app-muted)]">Release</dt><dd className="font-mono text-xs text-[var(--app-foreground)]">{descriptor.revision}</dd></div></dl> : <p className="mt-5 rounded-lg border border-[var(--app-danger)] bg-[var(--app-background)] px-3 py-2.5 text-sm text-[var(--app-danger)]">{error === "PROJECT_BACKEND_UNAVAILABLE" ? t("项目后端暂不可用，请稍后重试。") : t("无法读取项目后端状态。")}</p>}</article>
                    <article className="rounded-xl border border-[var(--app-control-border)] bg-[var(--app-surface)] p-5 shadow-[0_1px_2px_var(--app-shadow)]"><h2 className="text-sm font-semibold">{t("安全边界")}</h2><ul className="mt-4 space-y-3 text-sm leading-5 text-[var(--app-muted)]"><li className="flex gap-2"><KeyRound className="mt-0.5 size-3.5 shrink-0 text-[var(--app-success)]" />{t("浏览器只接收 publishable 连接材料")}</li><li className="flex gap-2"><LockKeyhole className="mt-0.5 size-3.5 shrink-0 text-[var(--app-success)]" />{t("管理密钥和数据库密码不离开 VM")}</li><li className="flex gap-2"><ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-[var(--app-success)]" />{t("项目间数据和运行时完全隔离")}</li></ul></article>
                  </section>
                  <section className="mt-6"><h2 className="text-sm font-semibold">{t("后端能力")}</h2><div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{navigation.slice(1, 10).map((item) => { const Icon = item.icon; return <button className="group flex min-h-24 items-start gap-3 rounded-xl border border-[var(--app-control-border)] bg-[var(--app-surface)] p-4 text-left transition-colors hover:bg-[var(--app-hover)]" key={item.id} onClick={() => setSection(item.id)} type="button"><span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-[var(--app-active)] text-[var(--app-foreground)] group-hover:bg-[var(--app-selected)]"><Icon className="size-4" /></span><span><strong className="block text-sm font-medium">{t(item.label)}</strong><span className="mt-1 block text-xs leading-5 text-[var(--app-muted)]">{t("OpenLink 项目级控制入口")}</span></span></button> })}</div></section>
                </>}

                {section === 'table-editor' && <section className="mt-6 rounded-xl border border-[var(--app-control-border)] bg-[var(--app-surface)] p-5">
                  <div className="flex items-center justify-between gap-3"><div><h2 className="text-sm font-semibold">{t("真实表目录")}</h2><p className="mt-1 text-xs text-[var(--app-muted)]">{t("来源：Project VM PostgreSQL information_schema")}</p></div><button className="rounded-md border border-[var(--app-control-border)] px-3 py-1.5 text-xs text-[var(--app-foreground)] hover:bg-[var(--app-hover)]" onClick={() => { void requestManagement("tables") }} type="button">{t("刷新")}</button></div>
                  {managementLoading && <p className="mt-5 text-sm text-[var(--app-muted)]">{t("正在读取真实表目录…")}</p>}
                  {managementError && <p className="mt-5 text-sm text-[var(--app-danger)]">{managementError}</p>}
                  {!managementLoading && !managementError && <div className="mt-5 overflow-hidden rounded-lg border border-[var(--app-border)]"><div className="grid grid-cols-[1fr_2fr_1fr] border-b border-[var(--app-border)] bg-[var(--app-background)] px-3 py-2 text-xs font-medium text-[var(--app-muted)]"><span>Schema</span><span>Table</span><span>Type</span></div>{(management?.tables ?? []).length ? management!.tables!.map((table) => <div className="grid grid-cols-[1fr_2fr_1fr] px-3 py-2.5 text-sm" key={`${table.schema}.${table.name}`}><span className="font-mono text-xs text-[var(--app-muted)]">{table.schema}</span><span>{table.name}</span><span className="text-xs text-[var(--app-muted)]">{table.kind}</span></div>) : <p className="px-3 py-6 text-sm text-[var(--app-muted)]">{t("Project VM 当前没有可见表。")}</p>}</div>}
                </section>}

                {section === 'database' && <section className="mt-6 grid gap-4 lg:grid-cols-2">
                  <article className="rounded-xl border border-[var(--app-control-border)] bg-[var(--app-surface)] p-5"><div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-sm font-semibold">{t("PostgreSQL 实例")}</h2></div>{managementLoading ? <p className="mt-4 text-sm text-[var(--app-muted)]">{t("正在读取数据库状态…")}</p> : managementError ? <p className="mt-4 text-sm text-[var(--app-danger)]">{managementError}</p> : <dl className="mt-4 space-y-3 text-sm"><div className="flex justify-between gap-4"><dt className="text-[var(--app-muted)]">{t("版本")}</dt><dd className="font-mono text-xs">{management?.database?.version ?? t("未知")}</dd></div><div className="flex justify-between gap-4"><dt className="text-[var(--app-muted)]">{t("数据库大小")}</dt><dd>{management?.database?.size ?? t("未知")}</dd></div><div className="flex justify-between gap-4"><dt className="text-[var(--app-muted)]">{t("活动连接")}</dt><dd>{management?.database?.connections ?? t("未知")}</dd></div></dl>}</article>
                  <article className="rounded-xl border border-[var(--app-control-border)] bg-[var(--app-surface)] p-5"><h2 className="text-sm font-semibold">{t("运行时版本")}</h2><p className="mt-3 font-mono text-xs text-[var(--app-muted)]">{descriptor?.revision ?? t("等待 Project VM")}</p><p className="mt-2 text-xs leading-5 text-[var(--app-muted)]">{t("该信息来自 VM 内 Supabase runtime 控制器。")}</p></article>
                </section>}

                {section === "auth" && <section className="mt-6 rounded-xl border border-[var(--app-control-border)] bg-[var(--app-surface)] p-5"><div className="flex items-center justify-between gap-3"><div><h2 className="text-sm font-semibold">{t("Auth 用户")}</h2><p className="mt-1 text-xs text-[var(--app-muted)]">{t("来源：Project VM GoTrue Admin API；只返回脱敏用户资料。")}</p></div><button className="rounded-md border border-[var(--app-control-border)] px-3 py-1.5 text-xs hover:bg-[var(--app-hover)]" onClick={() => { void requestManagement("auth-users") }} type="button">{t("刷新")}</button></div>{managementLoading ? <p className="mt-5 text-sm text-[var(--app-muted)]">{t("正在读取 Auth 用户…")}</p> : managementError ? <p className="mt-5 text-sm text-[var(--app-danger)]">{managementError}</p> : <div className="mt-5 overflow-x-auto rounded-lg border border-[var(--app-border)]"><div className="grid min-w-[600px] grid-cols-[1.4fr_1.4fr_1fr_0.7fr] border-b border-[var(--app-border)] bg-[var(--app-background)] px-3 py-2 text-xs font-medium text-[var(--app-muted)]"><span>Email</span><span>ID</span><span>{t("创建时间")}</span><span>{t("状态")}</span></div>{(management?.users ?? []).length ? management!.users!.map((user) => <div className="grid min-w-[600px] grid-cols-[1.4fr_1.4fr_1fr_0.7fr] px-3 py-2.5 text-xs" key={user.id}><span>{user.email ?? user.phone ?? t("未设置")}</span><span className="font-mono text-[var(--app-muted)]">{user.id.slice(0, 12)}…</span><span className="text-[var(--app-muted)]">{user.createdAt ? new Date(user.createdAt).toLocaleDateString() : "—"}</span><span className={user.confirmed ? "text-[var(--app-success)]" : "text-[var(--app-warning)]"}>{user.confirmed ? t("已确认") : t("待确认")}</span></div>) : <p className="px-3 py-6 text-sm text-[var(--app-muted)]">{t("暂无 Auth 用户。")}</p>}</div>}</section>}

                {section === "storage" && <section className="mt-6 rounded-xl border border-[var(--app-control-border)] bg-[var(--app-surface)] p-5"><div className="flex items-center justify-between gap-3"><div><h2 className="text-sm font-semibold">Storage buckets</h2><p className="mt-1 text-xs text-[var(--app-muted)]">{t("来源：Project VM Storage API。")}</p></div><button className="rounded-md border border-[var(--app-control-border)] px-3 py-1.5 text-xs hover:bg-[var(--app-hover)]" onClick={() => { void requestManagement("storage-buckets") }} type="button">{t("刷新")}</button></div>{managementLoading ? <p className="mt-5 text-sm text-[var(--app-muted)]">{t("正在读取 buckets…")}</p> : managementError ? <p className="mt-5 text-sm text-[var(--app-danger)]">{managementError}</p> : <div className="mt-5 overflow-hidden rounded-lg border border-[var(--app-border)]"><div className="grid grid-cols-[2fr_1fr_1fr] border-b border-[var(--app-border)] bg-[var(--app-background)] px-3 py-2 text-xs font-medium text-[var(--app-muted)]"><span>Name</span><span>Visibility</span><span>Updated</span></div>{(management?.buckets ?? []).length ? management!.buckets!.map((bucket) => <div className="grid grid-cols-[2fr_1fr_1fr] px-3 py-2.5 text-sm" key={bucket.id}><span>{bucket.name}</span><span className={bucket.public ? "text-[var(--app-success)]" : "text-[var(--app-muted)]"}>{bucket.public ? "Public" : "Private"}</span><span className="text-xs text-[var(--app-muted)]">{bucket.updatedAt ? new Date(bucket.updatedAt).toLocaleDateString() : "—"}</span></div>) : <p className="px-3 py-6 text-sm text-[var(--app-muted)]">{t("暂无 Storage bucket。")}</p>}</div>}</section>}

                {section === "functions" && <section className="mt-6 rounded-xl border border-[var(--app-control-border)] bg-[var(--app-surface)] p-5"><h2 className="text-sm font-semibold">{t("Edge Functions 工作区")}</h2><p className="mt-1 text-xs text-[var(--app-muted)]">{t("来源：Project VM workspace/supabase/functions。")}</p>{managementLoading ? <p className="mt-5 text-sm text-[var(--app-muted)]">{t("正在读取函数目录…")}</p> : managementError ? <p className="mt-5 text-sm text-[var(--app-danger)]">{managementError}</p> : <div className="mt-5 grid gap-2 sm:grid-cols-2">{(management?.functions ?? []).length ? management!.functions!.map((fn) => <div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-background)] p-3" key={fn.name}><p className="text-sm font-medium">{fn.name}</p></div>) : <p className="text-sm text-[var(--app-muted)]">{t("暂无 Edge Functions。")}</p>}</div>}</section>}

                {section === "realtime" && <section className="mt-6 rounded-xl border border-[var(--app-control-border)] bg-[var(--app-surface)] p-5"><h2 className="text-sm font-semibold">{t("Realtime 服务")}</h2><p className="mt-1 text-xs text-[var(--app-muted)]">{t("来源：Project VM 内受管 Supabase service health。")}</p>{managementLoading ? <p className="mt-5 text-sm text-[var(--app-muted)]">{t("正在读取服务状态…")}</p> : managementError ? <p className="mt-5 text-sm text-[var(--app-danger)]">{managementError}</p> : <div className="mt-5 grid gap-2 sm:grid-cols-2">{(management?.services ?? []).map((service) => <div className="flex items-center justify-between rounded-lg border border-[var(--app-border)] px-3 py-2.5 text-sm" key={service.name}><span>{service.name}</span><span className={service.running && service.status === "healthy" ? "text-[var(--app-success)]" : "text-[var(--app-warning)]"}>{service.status}</span></div>)}</div>}</section>}

                {section === "logs" && <section className="mt-6 rounded-xl border border-[var(--app-control-border)] bg-[var(--app-surface)] p-5"><div className="flex items-center justify-between gap-3"><div><h2 className="text-sm font-semibold">{t("服务日志")}</h2><p className="mt-1 text-xs text-[var(--app-muted)]">{t("当前显示 REST 服务最近 100 行，密钥已在 VM 内脱敏。")}</p></div><button className="rounded-md border border-[var(--app-control-border)] px-3 py-1.5 text-xs hover:bg-[var(--app-hover)]" onClick={() => { void requestManagement("logs", { service: "rest" }) }} type="button">{t("刷新")}</button></div>{managementLoading ? <p className="mt-5 text-sm text-[var(--app-muted)]">{t("正在读取日志…")}</p> : managementError ? <p className="mt-5 text-sm text-[var(--app-danger)]">{managementError}</p> : <pre className="mt-5 max-h-[520px] overflow-auto rounded-lg border border-[var(--app-border)] bg-[var(--app-background)] p-3 font-mono text-[11px] leading-5 text-[var(--app-muted)]">{management?.log || t("暂无日志")}</pre>}</section>}

                {section === "sql-editor" && <section className="mt-6 rounded-xl border border-[var(--app-control-border)] bg-[var(--app-surface)] p-5"><div className="flex items-start justify-between gap-3"><div><h2 className="text-sm font-semibold">{t("只读 SQL 查询")}</h2><p className="mt-1 text-xs leading-5 text-[var(--app-muted)]">{t("查询在 VM 内使用 PostgreSQL 执行。服务端拒绝 INSERT、UPDATE、DELETE、DDL 和多语句。")}</p></div><button className={`rounded-md px-3 py-1.5 text-xs font-medium ${theme("action")}`} onClick={() => { void runQuery() }} type="button">{t("执行查询")}</button></div><textarea className="mt-5 min-h-32 w-full resize-y rounded-lg border border-[var(--app-border)] bg-[var(--app-background)] p-3 font-mono text-xs leading-5 text-[var(--app-foreground)] outline-none focus:border-[var(--app-focus-ring)]" onChange={(event) => setQuery(event.currentTarget.value)} value={query} />{managementError && <p className="mt-3 text-sm text-[var(--app-danger)]">{managementError}</p>}{queryResult && <pre className="mt-5 max-h-[360px] overflow-auto rounded-lg border border-[var(--app-border)] bg-[var(--app-background)] p-3 font-mono text-[11px] leading-5 text-[var(--app-muted)]">{queryResult.csv || t("查询成功，但没有返回行。")}</pre>}</section>}

                {section === "api" && descriptor && <section className="mt-6 rounded-xl border border-[var(--app-control-border)] bg-[var(--app-surface)] p-5"><div className="flex items-start gap-3"><Braces className="mt-0.5 size-5" /><div><h2 className="text-sm font-semibold">{t("应用连接配置")}</h2><p className="mt-1 text-sm leading-6 text-[var(--app-muted)]">{t("将以下公开材料注入项目应用；不要把 service-role key 或数据库密码写入客户端。")}</p></div></div><pre className="mt-5 overflow-x-auto rounded-lg border border-[var(--app-border)] bg-[var(--app-background)] p-4 text-xs leading-6 text-[var(--app-foreground)]">{`SUPABASE_URL=${descriptor.url}\nSUPABASE_PUBLISHABLE_KEY=${maskKey(descriptor.publishableKey, t)}\nNEXT_PUBLIC_SUPABASE_URL=${descriptor.url}`}</pre></section>}
                {section === "api" && !descriptor && <p className="mt-6 rounded-lg border border-[var(--app-danger)] bg-[var(--app-background)] p-4 text-sm text-[var(--app-danger)]">{t("Project VM 连接材料暂不可用。")}</p>}
                {section === "settings" && <section className="mt-6 rounded-xl border border-[var(--app-control-border)] bg-[var(--app-surface)] p-5"><h2 className="text-sm font-semibold">Project Supabase runtime</h2><dl className="mt-5 space-y-3 text-sm"><div className="flex justify-between gap-4"><dt className="text-[var(--app-muted)]">Revision</dt><dd className="font-mono text-xs">{descriptor?.revision ?? t("正在连接")}</dd></div><div className="flex justify-between gap-4"><dt className="text-[var(--app-muted)]">Gateway</dt><dd className="font-mono text-xs">{descriptor?.url ?? t("正在连接")}</dd></div></dl><p className="mt-5 text-xs leading-5 text-[var(--app-muted)]">{t("升级仍由受签名 bundle 和 VM 内升级控制器执行；此页面不直接暴露容器管理权限。")}</p></section>}
              </div>
            </section>
          </div>
        </main>
      </div>
    </OpenLinkThemeProvider>
  )
}
