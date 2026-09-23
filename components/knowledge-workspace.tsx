'use client'

import { Sidebar } from '@/components/app-workspace'
import { PageTransition } from '@/components/ui/page-transition'
import { useSidebarCollapsed } from '@/lib/use-sidebar-collapsed'
import type { ThemeMode } from '@/components/account-drawer'
import { OpenLinkThemeProvider } from '@/components/ui/theme-scope'
import type { ActiveWorkspaceSummary, PersonalWorkspaceSummary } from '@/components/workspace-switcher'
import type { OrganizationSummary } from '@/lib/organizations'
import { useT } from '@/lib/i18n/client'
import type { Translator } from '@/lib/i18n/messages'
import { cn } from '@/lib/utils'
import {
  ArrowLeft,
  BookOpen,
  Braces,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
  Cloud,
  Code2,
  Copy,
  Database,
  FileCode2,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  Globe2,
  Hash,
  ListFilter,
  LoaderCircle,
  MoreHorizontal,
  Network,
  PanelLeft,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
  X,
  Download,
  Eye,
  FileArchive,
  FileImage,
  FileJson,
  FileSpreadsheet,
  FileType,
} from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from 'react'

type DocumentStatus = 'queued' | 'processing' | 'ready' | 'failed' | 'deleting' | 'deleted'

interface KnowledgeCollection {
  id: string
  workspace_id: string
  name: string
  slug: string
  description: string
  status: 'active' | 'archived'
  created_at: string
  updated_at: string
}

interface KnowledgeDocument {
  id: string
  workspace_id: string
  collection_id: string
  title: string
  source_type: 'text' | 'file' | 'url' | 'markdown' | 'code'
  source_uri: string | null
  mime_type: string | null
  source_content?: string | null
  content_hash: string
  status: DocumentStatus
  chunk_count: number
  embedding_provider: string | null
  embedding_model: string | null
  metadata: Record<string, unknown>
  last_error: string | null
  created_at: string
  updated_at: string
}

interface KnowledgeChunk {
  id: string
  chunk_index: number
  content: string
  token_count: number
  zero_id: string
}

interface KnowledgeBackend {
  id: string
  mode: 'standalone' | 'distributed'
  status: 'provisioning' | 'ready' | 'migrating' | 'stopped' | 'error'
  endpoint: string | null
  collection_name: string
  vector_dimension: number
  embedding_provider: string | null
  embedding_model: string | null
  last_error: string | null
  updated_at: string
}

interface KnowledgeWorkspaceProps {
  activeWorkspace: ActiveWorkspaceSummary
  workspaceId: string
  avatarUrl: string | null
  email: string
  initialPath: string[]
  nickname: string
  organizations: OrganizationSummary[]
  personalWorkspace: PersonalWorkspaceSummary
  knowledgeEnabled?: boolean
}

type View = 'home' | 'create' | 'folder' | 'document' | 'source' | 'zero'

function viewForPath(path: string[]): { view: View; id?: string } {
  if (path[0] === 'new') return { view: 'create' }
  if (path[0] === 'folders' && path[1]) return { view: 'folder', id: path[1] }
  if (path[0] === 'documents' && path[1] && path[2] === 'source') return { view: 'source', id: path[1] }
  if (path[0] === 'documents' && path[1]) return { view: 'document', id: path[1] }
  if (path[0] === 'zero') return { view: 'zero' }
  return { view: 'home' }
}

function relativeTime(value: string, t: Translator) {
  const delta = Math.max(0, Date.now() - new Date(value).getTime())
  if (delta < 60_000) return t("刚刚")
  if (delta < 3_600_000) return t("{count} 分钟前", { count: Math.floor(delta / 60_000) })
  if (delta < 86_400_000) return t("{count} 小时前", { count: Math.floor(delta / 3_600_000) })
  if (delta < 7 * 86_400_000) return t("{count} 天前", { count: Math.floor(delta / 86_400_000) })
  return new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric' }).format(new Date(value))
}

function statusLabel(status: DocumentStatus, t: Translator) {
  return ({ queued: t("等待索引"), processing: t("正在索引"), ready: t("已就绪"), failed: t("索引失败"), deleting: t("正在删除"), deleted: t("已删除") })[status]
}

function StatusPill({ status }: { status: DocumentStatus }) {
  const t = useT()
  const className = status === 'ready'
    ? 'border-[var(--app-success)] bg-[var(--app-success-surface)] text-[var(--app-success)]'
    : status === 'failed'
      ? 'border-[var(--app-danger)] bg-[var(--app-danger-surface)] text-[var(--app-danger)]'
      : 'border-[var(--app-warning)] bg-[var(--app-warning-surface)] text-[var(--app-warning)]'
  return <span className={cn('inline-flex h-5 items-center gap-1 rounded-full border px-1.5 text-[11px] font-medium', className)}>{status !== 'ready' && <LoaderCircle className="size-2.5 animate-spin" />}{statusLabel(status, t)}</span>
}

function SourceIcon({ type }: { type: KnowledgeDocument['source_type'] }) {
  const Icon = type === 'url' ? Globe2 : type === 'code' ? Code2 : type === 'markdown' ? Hash : type === 'file' ? FilePlus2 : FileText
  const tone = type === 'file' || type === 'text' ? 'text-[var(--app-muted)]' : 'text-[var(--app-info)]'
  return <span className={cn('flex size-7 shrink-0 items-center justify-center text-[var(--app-muted)]', tone)}><Icon className="size-4" /></span>
}

function formatBytes(value: unknown): string {
  if (typeof value === 'string' && value.trim()) return value
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

function documentTypeLabel(document: KnowledgeDocument): string {
  if (document.mime_type?.includes('pdf')) return 'PDF'
  if (document.source_type === 'markdown') return 'MD'
  if (document.source_type === 'code') return 'CODE'
  if (document.source_type === 'url') return 'URL'
  return 'TXT'
}

function apiError(payload: unknown, fallback: string) {
  if (payload && typeof payload === 'object' && 'error' in payload) {
    const error = (payload as { error?: { message?: unknown } }).error
    if (typeof error?.message === 'string') return error.message
  }
  return fallback
}

async function requestJson<T>(url: string, init: RequestInit | undefined, t: Translator): Promise<T> {
  const response = await fetch(url, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) }, cache: 'no-store' })
  const payload = await response.json().catch(() => null)
  if (!response.ok) throw new Error(apiError(payload, t("请求失败（{status}）", { status: response.status })))
  return payload as T
}

function PageHeading({ action, eyebrow, title, description }: { action?: ReactNode; eyebrow?: string; title: string; description?: string }) {
  return (
    <header className="flex flex-col gap-4 border-b border-[var(--app-border)] px-6 pb-5 pt-6 sm:flex-row sm:items-end sm:justify-between sm:px-8 lg:px-10">
      <div className="min-w-0">
        {eyebrow && <p className="mb-2 text-xs font-medium uppercase tracking-[0.14em] text-[var(--app-subtle)]">{eyebrow}</p>}
        <h1 className="text-[28px] font-semibold tracking-[-0.7px] text-[var(--app-foreground)]">{title}</h1>
        {description && <p className="mt-1.5 max-w-2xl text-sm leading-5 text-[var(--app-muted)]">{description}</p>}
      </div>
      {action}
    </header>
  )
}

function EmptyState({ action, description, icon: Icon, title }: { action?: ReactNode; description: string; icon: typeof BookOpen; title: string }) {
  return (
    <section className="flex min-h-[340px] flex-col items-center justify-center px-6 text-center">
      <span className="flex size-12 items-center justify-center rounded-2xl border border-[var(--app-control-border)] bg-[var(--app-surface)] text-[var(--app-muted)]"><Icon className="size-5" strokeWidth={1.5} /></span>
      <h2 className="mt-4 text-base font-medium text-[var(--app-foreground)]">{title}</h2>
      <p className="mt-1.5 max-w-sm text-sm leading-5 text-[var(--app-muted)]">{description}</p>
      {action && <div className="mt-5">{action}</div>}
    </section>
  )
}

export function KnowledgeWorkspace({ activeWorkspace, avatarUrl, email, initialPath, knowledgeEnabled = true, nickname, organizations, personalWorkspace, workspaceId }: KnowledgeWorkspaceProps) {
  const router = useRouter()
  const t = useT()
  const [themeMode, setThemeMode] = useState<ThemeMode>('system')
  const [systemLight, setSystemLight] = useState(false)
  const [collapsed, setCollapsed] = useSidebarCollapsed()
  const [mobileOpen, setMobileOpen] = useState(false)
  const [collections, setCollections] = useState<KnowledgeCollection[]>([])
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([])
  const [backend, setBackend] = useState<KnowledgeBackend | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const current = viewForPath(initialPath)
  const theme = themeMode === 'light' || (themeMode === 'system' && systemLight) ? 'light' : 'dark'

  useEffect(() => {
    const root = document.documentElement
    if (theme === 'dark') root.classList.add('dark')
    else root.classList.remove('dark')
  }, [theme])

  useEffect(() => {
    const saved = window.localStorage.getItem('openlink-theme') as ThemeMode | null
    if (saved === 'dark' || saved === 'light' || saved === 'system') setThemeMode(saved)
    const media = window.matchMedia('(prefers-color-scheme: light)')
    const update = () => setSystemLight(media.matches)
    update(); media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  const load = useCallback(async () => {
    if (!knowledgeEnabled) {
      setLoading(false)
      setError(null)
      return
    }
    setLoading(true); setError(null)
    const query = `workspaceId=${encodeURIComponent(workspaceId)}`
    try {
      const [collectionResult, documentResult, backendResult] = await Promise.all([
        requestJson<{ collections: KnowledgeCollection[] }>(`/api/knowledge/collections?${query}`, undefined, t),
        requestJson<{ documents: KnowledgeDocument[] }>(`/api/knowledge/documents?${query}`, undefined, t),
        requestJson<{ backend: KnowledgeBackend }>(`/api/knowledge/backends?${query}`, undefined, t),
      ])
      setCollections(collectionResult.collections)
      setDocuments(documentResult.documents)
      setBackend(backendResult.backend)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t("知识库暂时无法加载"))
    } finally { setLoading(false) }
  }, [knowledgeEnabled, t, workspaceId])

  useEffect(() => { void load() }, [load])

  useEffect(() => {
    if (!documents.some((document) => document.status === 'queued' || document.status === 'processing')) return
    const timer = window.setInterval(() => { void load() }, 2_500)
    return () => window.clearInterval(timer)
  }, [documents, load])

  const go = useCallback((path = '') => router.push(`/app/${activeWorkspace.slug}/knowledge${path}`), [activeWorkspace.slug, router])
  const selectedCollection = current.view === 'folder' ? collections.find((item) => item.id === current.id) : undefined
  const selectedDocument = current.view === 'document' || current.view === 'source' ? documents.find((item) => item.id === current.id) : undefined

  return (
    <OpenLinkThemeProvider theme={theme}>
      <div className="openlink-app-shell flex h-dvh min-h-[520px] overflow-hidden bg-[var(--app-background)]" data-theme={theme}>
        <Sidebar
          activeNavLabel={t("知识库")}
          activeWorkspace={activeWorkspace}
          avatarUrl={avatarUrl}
          collapsed={collapsed}
          email={email}
          mobileOpen={mobileOpen}
          nickname={nickname}
          onCloseMobile={() => setMobileOpen(false)}
          onThemeChange={(mode) => { setThemeMode(mode); window.localStorage.setItem('openlink-theme', mode) }}
          onToggle={() => setCollapsed((value) => !value)}
          organizations={organizations}
          personalWorkspace={personalWorkspace}
          themeMode={themeMode}
          secondaryPanel={
            <KnowledgeSecondarySidebar
              activeCollectionId={selectedCollection?.id}
              activeView={current.view}
              collections={collections}
              loading={loading}
              mobileOpen={mobileOpen}
              onCloseMobile={() => setMobileOpen(false)}
              onGo={go}
              onReload={load}
              onBack={() => router.push(`/app/${activeWorkspace.slug}`)}
            />
          }
        />
        <main className="relative min-w-0 flex-1 overflow-y-auto bg-[var(--app-background)]">
          <button aria-label={t("打开知识库导航")} className="absolute left-3 top-3 z-20 flex size-8 items-center justify-center rounded-md border border-[var(--app-control-border)] bg-[var(--app-background)] text-[var(--app-muted)] hover:bg-[var(--app-surface)] lg:hidden" onClick={() => setMobileOpen(true)} type="button"><PanelLeft className="size-4" /></button>
          {collapsed && <button aria-label={t("展开侧边栏")} className="absolute left-3 top-3 z-20 hidden size-8 items-center justify-center rounded-md hover:bg-[var(--app-surface)] lg:flex" onClick={() => setCollapsed(false)} type="button"><PanelLeft className="size-4" /></button>}
          <PageTransition className="flex min-h-full min-w-0 flex-col">
            {!knowledgeEnabled ? (
              <EmptyState
                description={t("Core 是明确的精简部署规格，不启动内置 Knowledge Service 与 Zero。切换到 Standard 或 Dense 后即可启用完整知识库。")}
                icon={BookOpen}
                title={t("Core 模式未启用内置知识库")}
              />
            ) : error ? <ErrorBanner message={error} onRetry={load} /> : null}
            {knowledgeEnabled && (loading && current.view !== 'create' ? <KnowledgeSkeleton /> : current.view === 'home' ? (
              <KnowledgeHome collections={collections} documents={documents} onGo={go} />
            ) : current.view === 'create' ? (
              <KnowledgeCreate collections={collections} onCreated={async (collectionId, documentId) => { await load(); go(documentId ? `/documents/${documentId}` : collectionId ? `/folders/${collectionId}` : '') }} workspaceId={workspaceId} />
            ) : current.view === 'folder' ? (
              <FolderPage collection={selectedCollection} documents={documents.filter((document) => document.collection_id === current.id)} onGo={go} onReload={load} workspaceId={workspaceId} />
            ) : current.view === 'document' ? (
              <DocumentPage document={selectedDocument} onGo={go} workspaceId={workspaceId} />
            ) : current.view === 'source' ? (
              <SourcePage document={selectedDocument} onGo={go} workspaceId={workspaceId} />
            ) : (
              <ZeroManagement backend={backend} onRefresh={load} workspaceId={workspaceId} />
            ))}
          </PageTransition>
        </main>
      </div>
    </OpenLinkThemeProvider>
  )
}

function KnowledgeSecondarySidebar({ activeCollectionId, activeView, collections, loading, mobileOpen, onCloseMobile, onGo, onReload, onBack }: {
  activeCollectionId?: string
  activeView: View
  collections: KnowledgeCollection[]
  loading: boolean
  mobileOpen: boolean
  onCloseMobile: () => void
  onGo: (path?: string) => void
  onReload: () => void
  onBack: () => void
}) {
  const t = useT()
  const [foldersOpen, setFoldersOpen] = useState(true)
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[var(--app-background)]">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-[var(--app-border)] px-3">
        <div className="flex min-w-0 items-center gap-1">
          <button aria-label={t("返回工作区")} className="flex size-7 shrink-0 items-center justify-center rounded-md text-[var(--app-muted)] hover:bg-[var(--app-surface)] hover:text-[var(--app-foreground)]" onClick={() => { onCloseMobile(); onBack() }} type="button"><ArrowLeft className="size-4" /></button>
          <button className="flex min-w-0 items-center gap-2 rounded-md px-1 text-left hover:bg-[var(--app-surface)]" onClick={() => { onCloseMobile(); onGo() }} type="button"><span className="flex size-6 items-center justify-center rounded-md bg-[var(--app-foreground)] text-[var(--app-background)]"><BookOpen className="size-3.5" /></span><span className="truncate text-sm font-semibold tracking-[-0.2px]">{t("知识库")}</span></button>
        </div>
        <div className="flex items-center"><button aria-label={t("刷新知识库")} className="flex size-7 items-center justify-center rounded-md text-[var(--app-muted)] hover:bg-[var(--app-active)] hover:text-[var(--app-foreground)]" disabled={loading} onClick={onReload} type="button"><LoaderCircle className={cn("size-3.5", loading && "animate-spin")} /></button><button aria-label={t("新建内容")} className="flex size-7 items-center justify-center rounded-md text-[var(--app-muted)] hover:bg-[var(--app-active)] hover:text-[var(--app-foreground)]" onClick={() => onGo("/new")} type="button"><Plus className="size-4" /></button></div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <nav className="space-y-0.5" aria-label={t("知识库导航")}>
          <KnowledgeNavItem active={activeView === "home"} icon={<BookOpen className="size-4" />} label={t("概览")} onClick={() => { onCloseMobile(); onGo() }} />
          <KnowledgeNavItem active={activeView === "create"} icon={<Upload className="size-4" />} label={t("上传与创建")} onClick={() => { onCloseMobile(); onGo("/new") }} />
          <KnowledgeNavItem active={activeView === "zero"} icon={<Database className="size-4" />} label={t("ZeroLink 管理")} onClick={() => { onCloseMobile(); onGo("/zero") }} />
        </nav>
        <div className="mt-5">
          <button className="flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-xs font-medium text-[var(--app-muted)] hover:bg-[var(--app-active)] hover:text-[var(--app-foreground)]" onClick={() => setFoldersOpen((value) => !value)} type="button"><ChevronRight className={cn("size-3.5 transition-transform", foldersOpen && "rotate-90")} /> {t("文件夹")}</button>
          {foldersOpen && <div className="mt-1 space-y-0.5">{collections.map((collection) => <KnowledgeNavItem active={activeCollectionId === collection.id} icon={<Folder className="size-4" />} key={collection.id} label={collection.name} onClick={() => { onCloseMobile(); onGo(`/folders/${collection.id}`) }} />)}{!collections.length && !loading && <p className="px-2 py-2 text-xs leading-4 text-[var(--app-subtle)]">{t("还没有文件夹，创建一个来组织文档。")}</p>}</div>}
        </div>
      </div>
      <footer className="border-t border-[var(--app-border)] p-3"><button className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-sm text-[var(--app-muted)] hover:bg-[var(--app-active)] hover:text-[var(--app-foreground)]" onClick={() => { onCloseMobile(); onGo("/zero") }} type="button"><ShieldCheck className="size-4" /> {t("数据与索引状态")}</button></footer>
    </div>
  )
}

function KnowledgeNavItem({ active, icon, label, onClick }: { active: boolean; icon: ReactNode; label: string; onClick: () => void }) {
  return <button aria-current={active ? 'page' : undefined} className={cn('flex h-8 w-full items-center gap-2 rounded-md px-2 text-sm transition-colors', active ? 'bg-[var(--app-active)] font-medium text-[var(--app-foreground)]' : 'text-[var(--app-muted)] hover:bg-[var(--app-active)] hover:text-[var(--app-foreground)]')} onClick={onClick} type="button"><span className="text-[var(--app-muted)]">{icon}</span><span className="min-w-0 flex-1 truncate text-left">{label}</span></button>
}

function ErrorBanner({ message, onRetry }: { message: string; onRetry: () => void }) {
  const t = useT()
  return <div className="flex items-center gap-3 border-b border-[var(--app-danger)] bg-[var(--app-danger-surface)] px-6 py-2.5 text-sm text-[var(--app-danger)]"><CircleHelp className="size-4 shrink-0" /><span className="min-w-0 flex-1 truncate">{message}</span><button className="rounded-md px-2 py-1 text-xs font-medium hover:bg-[var(--app-hover)]" onClick={onRetry} type="button">{t("重试")}</button></div>
}

function KnowledgeSkeleton() { return <div className="animate-pulse p-8"><div className="h-8 w-36 rounded bg-[var(--app-surface)]" /><div className="mt-8 grid grid-cols-1 gap-4 xl:grid-cols-3">{Array.from({ length: 6 }).map((_, index) => <div className="h-28 rounded-xl border border-[var(--app-border)] bg-[var(--app-surface)]" key={index} />)}</div></div> }

function KnowledgeHome({ collections, documents, onGo }: { collections: KnowledgeCollection[]; documents: KnowledgeDocument[]; onGo: (path?: string) => void }) {
  const t = useT()
  const searchLabel = t("搜索文档")
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<'updated' | 'name' | 'size'>('updated')
  const [statusFilter, setStatusFilter] = useState<DocumentStatus | 'all'>('all')
  const [menu, setMenu] = useState<'sort' | 'more' | null>(null)
  const visibleDocuments = useMemo(() => documents
    .filter((document) => !query.trim() || `${document.title} ${document.source_uri || ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    .filter((document) => statusFilter === 'all' || document.status === statusFilter)
    .sort((a, b) => sort === 'name' ? a.title.localeCompare(b.title) : sort === 'size' ? Number(b.metadata?.size_bytes || 0) - Number(a.metadata?.size_bytes || 0) : new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()), [documents, query, sort, statusFilter])
  return <div className="flex min-h-full min-w-0 flex-col bg-[var(--app-background)]">
    <header className="flex h-11 shrink-0 items-center justify-between border-b border-[var(--app-border)] px-4 sm:px-5"><h1 className="text-sm font-medium text-[var(--app-foreground)]">{t("文档")}</h1><div className="flex items-center gap-1"><button aria-label={searchLabel} className="flex size-8 items-center justify-center rounded-md text-[var(--app-muted)] hover:bg-[var(--app-active)]" onClick={() => document.querySelector<HTMLInputElement>(`[aria-label="${searchLabel}"]`)?.focus()} type="button"><Search className="size-4" /></button><div className="relative"><button aria-label={t("排序")} className="flex size-8 items-center justify-center rounded-md text-[var(--app-muted)] hover:bg-[var(--app-active)]" onClick={() => setMenu(menu === "sort" ? null : "sort")} type="button"><ListFilter className="size-4" /></button>{menu === "sort" && <ToolbarMenu items={[["updated", t("最近更新")], ["name", t("名称")], ["size", t("大小")]]} onSelect={(value) => { setSort(value as typeof sort); setMenu(null) }} selected={sort} />}</div><div className="relative"><button aria-label={t("更多操作")} className="flex size-8 items-center justify-center rounded-md text-[var(--app-muted)] hover:bg-[var(--app-active)]" onClick={() => setMenu(menu === "more" ? null : "more")} type="button"><MoreHorizontal className="size-4" /></button>{menu === "more" && <ToolbarMenu items={[["all", t("全部状态")], ["ready", t("仅已就绪")], ["processing", t("正在索引")], ["failed", t("索引失败")]]} onSelect={(value) => { setStatusFilter(value as typeof statusFilter); setMenu(null) }} selected={statusFilter} />}</div><button className="ml-2 flex h-8 items-center gap-1 rounded-md bg-[var(--app-foreground)] px-3 text-xs font-medium text-[var(--app-background)] hover:opacity-90" onClick={() => onGo("/new")} type="button"><Plus className="size-3.5" /> {t("添加")}</button></div></header>
    <div className="min-w-0 flex-1 overflow-auto"><div className="sticky top-0 z-10 flex items-center gap-2 border-b border-[var(--app-border)] bg-[var(--app-background)] px-4 py-2 sm:px-5"><label className="relative min-w-0 flex-1 max-w-sm"><Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-[var(--app-subtle)]" /><input aria-label={searchLabel} className="h-7 w-full border-0 bg-transparent pl-7 text-xs text-[var(--app-foreground)] outline-none placeholder:text-[var(--app-subtle)]" onChange={(event) => setQuery(event.currentTarget.value)} placeholder={t("搜索")} value={query} /></label><span className="text-[11px] text-[var(--app-subtle)]">{t("{count} 个文件", { count: visibleDocuments.length })}</span></div>{visibleDocuments.length ? <DocumentTable documents={visibleDocuments} onOpen={(id) => onGo(`/documents/${id}`)} /> : <EmptyState action={<button className="rounded-md bg-[var(--app-foreground)] px-3 py-2 text-xs font-medium text-[var(--app-background)]" onClick={() => onGo("/new")} type="button">{t("添加第一篇文档")}</button>} description={query ? t("没有匹配的文档。") : t("上传文件、创建文档后，内容会自动写入 Zero 索引。")} icon={FileText} title={query ? t("未找到文档") : t("还没有文档")} />}</div>
  </div>
}

function ToolbarMenu({ items, onSelect, selected }: { items: Array<[string, string]>; onSelect: (value: string) => void; selected: string }) {
  return <div className="absolute right-0 top-9 z-30 min-w-36 rounded-lg border border-[var(--app-control-border)] bg-[var(--app-surface)] p-1 shadow-xl">{items.map(([value, label]) => <button className={cn('flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-xs', selected === value ? 'bg-[var(--app-active)] text-[var(--app-foreground)]' : 'text-[var(--app-muted)] hover:bg-[var(--app-active)]')} key={value} onClick={() => onSelect(value)} type="button">{label}{selected === value && <Check className="size-3" />}</button>)}</div>
}

function Metric({ icon, label, value }: { icon: ReactNode; label: string; value: ReactNode }) { return <div className="flex items-center gap-3 rounded-xl border border-[var(--app-control-border)] bg-[var(--app-surface)] p-4"><span className="flex size-8 items-center justify-center rounded-lg bg-[var(--app-active)] text-[var(--app-muted)]">{icon}</span><span><span className="block text-xl font-semibold tracking-[-0.4px] text-[var(--app-foreground)]">{value}</span><span className="block text-xs text-[var(--app-muted)]">{label}</span></span></div> }

function DocumentTable({ documents, onOpen }: { documents: KnowledgeDocument[]; onOpen: (id: string) => void }) {
  const t = useT()
  return <div className="min-w-[720px] border-b border-[var(--app-border)]"><div className="grid grid-cols-[28px_minmax(0,1fr)_150px_110px_120px] gap-3 border-b border-[var(--app-border)] px-4 py-2 text-[11px] text-[var(--app-subtle)] sm:px-5"><span /> <span>{t("文件")}</span><span>{t("创建时间")}</span><span>{t("大小")}</span><span>{t("状态")}</span></div>{documents.map((document) => <button className="grid w-full grid-cols-[28px_minmax(0,1fr)_150px_110px_120px] items-center gap-3 border-b border-[var(--app-border)] px-4 py-2.5 text-left last:border-0 hover:bg-[var(--app-active)] sm:px-5" key={document.id} onClick={() => onOpen(document.id)} type="button"><span className="flex size-4 items-center justify-center rounded border border-[var(--app-control-border)]" /><span className="flex min-w-0 items-center gap-2"><SourceIcon type={document.source_type} /><span className="min-w-0"><span className="block truncate text-[13px] text-[var(--app-foreground)]">{document.title}</span><span className="mt-0.5 block truncate text-[11px] text-[var(--app-muted)]">{document.source_uri || documentTypeLabel(document)}</span></span></span><span className="text-xs text-[var(--app-muted)]">{new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(document.created_at))}</span><span className="text-xs text-[var(--app-muted)]">{formatBytes(document.metadata?.size_bytes ?? document.metadata?.size)}</span><span><StatusPill status={document.status} /></span></button>)}</div>
}

function KnowledgeCreate({ collections, onCreated, workspaceId }: { collections: KnowledgeCollection[]; onCreated: (collectionId?: string, documentId?: string) => Promise<void>; workspaceId: string }) {
  const t = useT()
  const [mode, setMode] = useState<'document' | 'folder'>('document')
  const [folderId, setFolderId] = useState(collections[0]?.id ?? '')
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [sourceType, setSourceType] = useState<KnowledgeDocument['source_type']>('markdown')
  const [sourceUri, setSourceUri] = useState('')
  const [sourceSize, setSourceSize] = useState(0)
  const [sourceFileCount, setSourceFileCount] = useState(1)
  const [folderName, setFolderName] = useState('')
  const [folderDescription, setFolderDescription] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const folderRef = useRef<HTMLInputElement>(null)

  const readFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    if (file.size > 10_000_000) { setError(t("文件不能超过 10MB")); return }
    const text = await file.text()
    setTitle((current) => current || file.name.replace(/\.[^.]+$/, ''))
    setContent(text); setSourceSize(file.size); setSourceFileCount(1); setSourceType(file.name.match(/\.(md|mdx)$/i) ? 'markdown' : file.name.match(/\.(ts|tsx|js|jsx|py|go|rs|json|css|html)$/i) ? 'code' : 'file')
    setSourceUri(file.name)
  }

  const readFolder = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || [])
    if (!files.length) return
    const total = files.reduce((sum, file) => sum + file.size, 0)
    if (total > 25_000_000) { setError(t("文件夹内容不能超过 25MB")); return }
    const supported = files.filter((file) => /\.(txt|md|mdx|json|ts|tsx|js|jsx|py|go|rs|html|css)$/i.test(file.name))
    if (!supported.length) { setError(t("文件夹中没有可索引的文本或代码文件")); return }
    const joined = await Promise.all(supported.map(async (file) => `\n\n## ${file.webkitRelativePath || file.name}\n\n${await file.text()}`))
    const importName = files[0].webkitRelativePath?.split("/")[0] || t("文件夹")
    setMode('document')
    setTitle((current) => current || t("{folder} 导入", { folder: importName }))
    setContent(joined.join('')); setSourceSize(total); setSourceFileCount(supported.length)
    setSourceType('file')
    setSourceUri(files[0].webkitRelativePath?.split('/')[0] || 'folder')
  }

  const submit = async () => {
    setError(null); setPending(true)
    try {
      if (mode === 'folder') {
        const payload = await requestJson<{ collection: KnowledgeCollection }>('/api/knowledge/collections', { method: 'POST', body: JSON.stringify({ workspaceId, name: folderName, description: folderDescription }) }, t)
        await onCreated(payload.collection.id)
      } else {
        if (!folderId) throw new Error(t("请先选择或创建一个文件夹"))
        const payload = await requestJson<{ document: KnowledgeDocument }>('/api/knowledge/documents', { method: 'POST', body: JSON.stringify({ workspaceId, collectionId: folderId, title, content, sourceType, sourceUri: sourceUri || undefined, metadata: { size_bytes: sourceSize, size: formatBytes(sourceSize), file_count: sourceFileCount } }) }, t)
        await onCreated(undefined, payload.document.id)
      }
    } catch (submitError) { setError(submitError instanceof Error ? submitError.message : t("创建失败")) } finally { setPending(false) }
  }

  return <>
    <PageHeading eyebrow="Add knowledge" title={t("上传与创建")} description={t("把文件或文件夹拖到这里，或选择一种方式开始。")} />
    <div className="mx-auto flex w-full max-w-5xl flex-col items-center px-6 py-16 sm:px-8 lg:px-10"><p className="text-base font-semibold text-[var(--app-foreground)]">{t("把文件或文件夹拖到这里")}</p><p className="mt-2 text-sm text-[var(--app-muted)]">{t("或者")}</p><div className="mt-6 grid w-full max-w-3xl gap-3 sm:grid-cols-3">
      <CreateCard icon={<Plus className="size-8" />} title={t("新建资源库")} description={t("创建一个新的文件夹")} onClick={() => { setMode("folder"); window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" }) }} tone="purple" />
      <CreateCard icon={<Upload className="size-8" />} title={t("上传文件")} description={t("支持 Markdown、文本和代码")} onClick={() => fileRef.current?.click()} tone="amber" />
      <CreateCard icon={<Upload className="size-8" />} title={t("上传文件夹")} description={t("批量导入可索引文件")} onClick={() => folderRef.current?.click()} tone="blue" />
    </div><input accept=".txt,.md,.mdx,.json,.ts,.tsx,.js,.jsx,.py,.go,.rs,.html,.css" className="hidden" onChange={readFile} ref={fileRef} type="file" /><input className="hidden" onChange={readFolder} ref={folderRef} type="file" {...({ webkitdirectory: 'true', directory: 'true' } as Record<string, string>)} />
    <div className="mt-10 w-full max-w-4xl rounded-xl border border-[var(--app-control-border)] bg-[var(--app-surface)] p-1"><div className="grid grid-cols-2 rounded-lg bg-[var(--app-background)] p-1"><button className={cn("h-9 rounded-md text-sm font-medium", mode === "document" && "bg-[var(--app-active)] text-[var(--app-foreground)]", mode !== "document" && "text-[var(--app-muted)]")} onClick={() => setMode("document")} type="button">{t("添加文档")}</button><button className={cn("h-9 rounded-md text-sm font-medium", mode === "folder" && "bg-[var(--app-active)] text-[var(--app-foreground)]", mode !== "folder" && "text-[var(--app-muted)]")} onClick={() => setMode("folder")} type="button">{t("创建文件夹")}</button></div>
      {mode === "folder" ? <div className="space-y-5 p-5"><Field label={t("文件夹名称")}><input className="knowledge-input" onChange={(event) => setFolderName(event.currentTarget.value)} placeholder={t("例如：产品研究")} value={folderName} /></Field><Field label={t("描述（可选）")}><textarea className="knowledge-input min-h-24 resize-y py-2" onChange={(event) => setFolderDescription(event.currentTarget.value)} placeholder={t("说明这个文件夹中的内容…")} value={folderDescription} /></Field></div> : <div className="space-y-5 p-5"><div className="grid gap-4 sm:grid-cols-2"><Field label={t("归属文件夹")}><select className="knowledge-input" onChange={(event) => setFolderId(event.currentTarget.value)} value={folderId}><option value="">{t("选择文件夹")}</option>{collections.map((collection) => <option key={collection.id} value={collection.id}>{collection.name}</option>)}</select></Field><Field label={t("内容类型")}><select className="knowledge-input" onChange={(event) => setSourceType(event.currentTarget.value as KnowledgeDocument["source_type"])} value={sourceType}><option value="markdown">Markdown</option><option value="text">{t("纯文本")}</option><option value="code">{t("代码")}</option><option value="url">{t("网页摘录")}</option><option value="file">{t("文件")}</option></select></Field></div><Field label={t("标题")}><input className="knowledge-input" onChange={(event) => setTitle(event.currentTarget.value)} placeholder={t("给这篇文档一个清晰的标题")} value={title} /></Field><div><div className="mb-2 flex items-center justify-between"><label className="text-sm font-medium text-[var(--app-foreground)]">{t("正文")}</label><button className="flex items-center gap-1 text-xs text-[var(--app-muted)] hover:text-[var(--app-foreground)]" onClick={() => fileRef.current?.click()} type="button"><Upload className="size-3.5" /> {t("选择本地文件")}</button><input accept=".txt,.md,.mdx,.json,.ts,.tsx,.js,.jsx,.py,.go,.rs,.html,.css" className="hidden" onChange={readFile} ref={fileRef} type="file" /></div><textarea className="knowledge-input min-h-64 resize-y py-3 font-mono text-[13px] leading-5" onChange={(event) => setContent(event.currentTarget.value)} placeholder={t("# 输入或粘贴内容\n\n支持 Markdown、代码和纯文本。保存后会自动分块并写入 Zero 索引。")} value={content} /></div><Field label={t("来源地址或文件名（可选）")}><input className="knowledge-input" onChange={(event) => setSourceUri(event.currentTarget.value)} placeholder={t("https://… 或 notes.md")} value={sourceUri} /></Field></div>}
      <div className="flex items-center justify-between border-t border-[var(--app-border)] px-5 py-4"><span className="text-xs text-[var(--app-muted)]">{error ? <span className="text-[var(--app-danger)]">{error}</span> : mode === "document" ? t("保存后将在后台自动建立向量索引。") : t("文件夹可用于组织和权限边界。")}</span><button className="flex h-9 items-center gap-1.5 rounded-lg bg-[var(--app-submit-background)] px-3 text-sm font-medium text-[var(--app-submit-foreground)] disabled:opacity-40" disabled={pending || (mode === "folder" ? !folderName.trim() : !title.trim() || !content.trim() || !folderId)} onClick={() => void submit()} type="button">{pending && <LoaderCircle className="size-4 animate-spin" />}{mode === "folder" ? t("创建文件夹") : t("保存并索引")}</button></div>
    </div></div>
  </>
}

function CreateCard({ icon, title, description, onClick, tone }: { icon: ReactNode; title: string; description: string; onClick: () => void; tone: 'purple' | 'amber' | 'blue' }) {
  return <button className="group relative flex h-32 flex-col items-center justify-between overflow-hidden rounded-xl border border-[var(--app-control-border)] bg-[var(--app-surface)] px-4 pt-5 text-center transition-colors hover:border-[var(--app-muted)]" onClick={onClick} type="button"><span className="text-sm font-medium text-[var(--app-foreground)]">{title}</span><span className="sr-only">{description}</span><span className={cn('flex size-16 translate-y-2 items-center justify-center rounded-t-xl text-white transition-transform group-hover:translate-y-0', tone === 'purple' && 'bg-fuchsia-500', tone === 'amber' && 'bg-amber-500', tone === 'blue' && 'bg-blue-500')}>{icon}</span></button>
}

function Field({ children, label }: { children: ReactNode; label: string }) { return <label className="block"><span className="mb-2 block text-sm font-medium text-[var(--app-foreground)]">{label}</span>{children}</label> }

function FolderPage({ collection, documents, onGo, onReload, workspaceId }: { collection?: KnowledgeCollection; documents: KnowledgeDocument[]; onGo: (path?: string) => void; onReload: () => Promise<void>; workspaceId: string }) {
  const t = useT()
  if (!collection) return <EmptyState action={<button className="rounded-lg bg-[var(--app-submit-background)] px-3 py-2 text-sm font-medium text-[var(--app-submit-foreground)]" onClick={() => onGo()} type="button">{t("返回知识库")}</button>} description={t("这个文件夹不存在，或你已失去访问权限。")} icon={Folder} title={t("未找到文件夹")} />
  const [open, setOpen] = useState(false)
  return <div className="flex min-h-full min-w-0 flex-col"><header className="flex h-11 shrink-0 items-center justify-between border-b border-[var(--app-border)] px-4 sm:px-5"><div className="flex min-w-0 items-center gap-2"><button aria-label={t("返回文档")} className="flex size-7 items-center justify-center rounded-md text-[var(--app-muted)] hover:bg-[var(--app-active)]" onClick={() => onGo()} type="button"><ArrowLeft className="size-4" /></button><FolderOpen className="size-4 text-[var(--app-info)]" /><h1 className="truncate text-sm font-medium text-[var(--app-foreground)]">{collection.name}</h1></div><div className="flex items-center gap-1"><div className="relative"><button aria-label={t("文件夹更多操作")} className="flex size-8 items-center justify-center rounded-md text-[var(--app-muted)] hover:bg-[var(--app-active)]" onClick={() => setOpen((value) => !value)} type="button"><MoreHorizontal className="size-4" /></button>{open && <div className="absolute right-0 top-9 z-20 min-w-36 rounded-lg border border-[var(--app-control-border)] bg-[var(--app-surface)] p-1 shadow-xl"><button className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs text-[var(--app-danger)] hover:bg-[var(--app-danger-surface)]" onClick={() => { if (!window.confirm(t("删除文件夹及其中的文档？"))) return; void requestJson(`/api/knowledge/collections?collectionId=${encodeURIComponent(collection.id)}&workspaceId=${encodeURIComponent(workspaceId)}`, { method: "DELETE", body: JSON.stringify({ workspaceId }) }, t).then(async () => { await onReload(); onGo() }) }} type="button"><Trash2 className="size-3.5" /> {t("删除文件夹")}</button></div>}</div><button className="ml-2 flex h-8 items-center gap-1 rounded-md bg-[var(--app-foreground)] px-3 text-xs font-medium text-[var(--app-background)]" onClick={() => onGo("/new")} type="button"><Plus className="size-3.5" /> {t("添加")}</button></div></header><div className="flex items-center gap-2 border-b border-[var(--app-border)] px-4 py-2 text-[11px] text-[var(--app-muted)] sm:px-5"><span>{t("{count} 个文件", { count: documents.length })}</span><span>·</span><span>{t("更新于 {time}", { time: relativeTime(collection.updated_at, t) })}</span>{collection.description && <span className="truncate">· {collection.description}</span>}</div>{documents.length ? <div className="min-w-0 flex-1 overflow-auto"><DocumentTable documents={documents} onOpen={(id) => onGo("/documents/" + id)} /></div> : <EmptyState action={<button className="rounded-md bg-[var(--app-foreground)] px-3 py-2 text-xs font-medium text-[var(--app-background)]" onClick={() => onGo("/new")} type="button">{t("添加第一篇文档")}</button>} description={t("上传文件、粘贴 Markdown 或输入文本，Zero 会自动把内容转为可检索上下文。")} icon={FilePlus2} title={t("此文件夹还是空的")} />}</div>
}

function DocumentPage({ document: knowledgeDocument, onGo, workspaceId }: { document?: KnowledgeDocument; onGo: (path?: string) => void; workspaceId: string }) {
  const t = useT()
  const [detail, setDetail] = useState<{ document: KnowledgeDocument; collection: KnowledgeCollection; chunks: KnowledgeChunk[] } | null>(null)
  const [loading, setLoading] = useState(Boolean(knowledgeDocument))
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<'preview' | 'source'>('preview')
  useEffect(() => { if (!knowledgeDocument) return; setLoading(true); void requestJson<{ document: KnowledgeDocument; collection: KnowledgeCollection; chunks: KnowledgeChunk[] }>(`/api/knowledge/documents/${knowledgeDocument.id}?workspaceId=${encodeURIComponent(workspaceId)}`, undefined, t).then(setDetail).catch((err) => setError(err instanceof Error ? err.message : t("无法加载文档"))).finally(() => setLoading(false)) }, [knowledgeDocument, t, workspaceId])
  if (!knowledgeDocument) return <EmptyState action={<button className="rounded-lg bg-[var(--app-submit-background)] px-3 py-2 text-sm font-medium text-[var(--app-submit-foreground)]" onClick={() => onGo()} type="button">{t("返回知识库")}</button>} description={t("这个文档不存在，或已经被删除。")} icon={FileText} title={t("未找到文档")} />
  const active = detail?.document ?? knowledgeDocument
  const processingLabel = t("内容正在处理，请稍后刷新。")
  const rawContent = active.source_content || detail?.chunks.map((chunk) => chunk.content).join("\n\n") || processingLabel
  return <div className="flex min-h-full min-w-0 flex-col"><header className="flex h-11 shrink-0 items-center justify-between border-b border-[var(--app-border)] px-4 sm:px-5"><div className="flex min-w-0 items-center gap-2"><button aria-label={t("返回文档")} className="flex size-7 items-center justify-center rounded-md text-[var(--app-muted)] hover:bg-[var(--app-active)]" onClick={() => onGo()} type="button"><ArrowLeft className="size-4" /></button><FileText className="size-4 text-[var(--app-info)]" /><h1 className="truncate text-sm font-medium text-[var(--app-foreground)]">{active.title}</h1></div><div className="flex items-center gap-1"><button aria-label={t("打开源代码")} className="flex size-8 items-center justify-center rounded-md text-[var(--app-muted)] hover:bg-[var(--app-active)]" onClick={() => onGo("/documents/" + active.id + "/source")} type="button"><Braces className="size-4" /></button><button aria-label={t("下载文档")} className="flex size-8 items-center justify-center rounded-md text-[var(--app-muted)] hover:bg-[var(--app-active)]" onClick={() => { const blob = new Blob([rawContent], { type: "text/plain;charset=utf-8" }); const href = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = href; anchor.download = active.source_uri || active.title + ".txt"; anchor.click(); URL.revokeObjectURL(href) }} type="button"><Download className="size-4" /></button><button aria-label={t("删除文档")} className="flex size-8 items-center justify-center rounded-md text-[var(--app-muted)] hover:bg-[var(--app-danger-surface)] hover:text-[var(--app-danger)]" onClick={() => { if (window.confirm(t("删除这篇文档？"))) void requestJson(`/api/knowledge/documents/${active.id}?workspaceId=${encodeURIComponent(workspaceId)}`, { method: "DELETE", body: JSON.stringify({ workspaceId }) }, t).then(() => onGo()) }} type="button"><Trash2 className="size-4" /></button></div></header><div className="flex items-center justify-between border-b border-[var(--app-border)] px-4 py-2 sm:px-5"><div className="min-w-0 truncate text-xs text-[var(--app-muted)]">{detail?.collection.name || t("文档")} <span className="mx-1">/</span> {active.source_uri || documentTypeLabel(active)}</div><div className="flex rounded-md border border-[var(--app-control-border)] p-0.5"><button className={cn("flex h-7 items-center gap-1 rounded px-2 text-xs", mode === "preview" ? "bg-[var(--app-active)] text-[var(--app-foreground)]" : "text-[var(--app-muted)]")} onClick={() => setMode("preview")} type="button"><Eye className="size-3" />{t("预览")}</button><button className={cn("flex h-7 items-center gap-1 rounded px-2 text-xs", mode === "source" ? "bg-[var(--app-active)] text-[var(--app-foreground)]" : "text-[var(--app-muted)]")} onClick={() => setMode("source")} type="button"><Braces className="size-3" />{t("原文")}</button></div></div><div className="grid min-w-0 flex-1 grid-cols-1 xl:grid-cols-[minmax(0,1fr)_240px]">{loading ? <div className="p-8 text-sm text-[var(--app-muted)]"><LoaderCircle className="mr-2 inline size-4 animate-spin" />{t("正在读取文档…")}</div> : error ? <div className="p-8 text-sm text-[var(--app-danger)]">{error}</div> : <article className={cn("min-w-0 overflow-auto px-5 py-7 sm:px-8 lg:px-10", mode === "source" && "font-mono")}><div className={cn("mx-auto max-w-4xl whitespace-pre-wrap text-[14px] leading-7 text-[var(--app-foreground)]", mode === "source" && "text-[13px] leading-6 text-[var(--app-muted)]")}>{mode === "preview" ? renderSimpleMarkdown(rawContent) : rawContent}</div></article>}<aside className="border-t border-[var(--app-border)] px-5 py-6 xl:border-l xl:border-t-0"><h2 className="text-xs font-medium text-[var(--app-muted)]">{t("索引信息")}</h2><dl className="mt-5 space-y-4 text-xs"><Meta label={t("状态")} value={<StatusPill status={active.status} />} /><Meta label={t("分块数")} value={String(active.chunk_count)} /><Meta label={t("嵌入模型")} value={active.embedding_model || t("默认模型")} /><Meta label={t("最近更新")} value={relativeTime(active.updated_at, t)} /><Meta label={t("内容哈希")} value={<code className="block max-w-44 truncate text-[11px]">{active.content_hash}</code>} /></dl></aside></div></div>
}

function renderSimpleMarkdown(value: string): ReactNode {
  return value.split(/\n{2,}/).map((block, index) => { const trimmed = block.trim(); if (!trimmed) return null; if (trimmed.startsWith('### ')) return <h3 className="mb-4 mt-6 text-base font-semibold" key={index}>{trimmed.slice(4)}</h3>; if (trimmed.startsWith('## ')) return <h2 className="mb-4 mt-7 text-lg font-semibold" key={index}>{trimmed.slice(3)}</h2>; if (trimmed.startsWith('# ')) return <h1 className="mb-5 mt-2 text-2xl font-semibold" key={index}>{trimmed.slice(2)}</h1>; if (/^[-*] /.test(trimmed)) return <ul className="mb-4 list-disc space-y-1 pl-5" key={index}>{trimmed.split('\n').map((line, item) => <li key={item}>{line.replace(/^[-*] /, '')}</li>)}</ul>; return <p className="mb-4" key={index}>{trimmed}</p> })
}

function Meta({ label, value }: { label: string; value: ReactNode }) { return <div><dt className="text-[var(--app-subtle)]">{label}</dt><dd className="mt-1 text-[var(--app-foreground)]">{value}</dd></div> }

function SourcePage({ document: knowledgeDocument, onGo, workspaceId }: { document?: KnowledgeDocument; onGo: (path?: string) => void; workspaceId: string }) {
  const t = useT()
  const [content, setContent] = useState(knowledgeDocument?.source_content || '')
  const [copied, setCopied] = useState(false)
  useEffect(() => { if (!knowledgeDocument) return; void requestJson<{ document: KnowledgeDocument }>(`/api/knowledge/documents/${knowledgeDocument.id}?workspaceId=${encodeURIComponent(workspaceId)}`, undefined, t).then((data) => setContent(data.document.source_content || '')).catch(() => undefined) }, [knowledgeDocument, t, workspaceId])
  if (!knowledgeDocument) return <EmptyState action={<button className="rounded-lg bg-[var(--app-submit-background)] px-3 py-2 text-sm font-medium text-[var(--app-submit-foreground)]" onClick={() => onGo()} type="button">{t("返回知识库")}</button>} description={t("无法找到对应的文档源内容。")} icon={FileCode2} title={t("未找到源代码")} />
  const language = knowledgeDocument.source_type === 'code' ? knowledgeDocument.source_uri?.split('.').pop() || 'text' : knowledgeDocument.source_type
  const document = { ...knowledgeDocument, createElement: (_tag: 'a') => globalThis.document.createElement('a') }
  return <div className="flex min-h-full min-w-0 flex-col"><header className="flex h-11 shrink-0 items-center justify-between border-b border-[var(--app-border)] px-4 sm:px-5"><div className="flex min-w-0 items-center gap-2"><button aria-label={t("返回预览")} className="flex size-7 items-center justify-center rounded-md text-[var(--app-muted)] hover:bg-[var(--app-active)]" onClick={() => onGo("/documents/" + document.id)} type="button"><ArrowLeft className="size-4" /></button><Code2 className="size-4 text-[var(--app-info)]" /><h1 className="truncate text-sm font-medium text-[var(--app-foreground)]">{document.title}</h1><span className="text-xs text-[var(--app-subtle)]">· {language}</span></div><div className="flex items-center gap-1"><button aria-label={t("复制源内容")} className="flex size-8 items-center justify-center rounded-md text-[var(--app-muted)] hover:bg-[var(--app-active)]" onClick={() => { void navigator.clipboard.writeText(content); setCopied(true); window.setTimeout(() => setCopied(false), 1_500) }} type="button">{copied ? <Check className="size-4" /> : <Copy className="size-4" />}</button><button aria-label={t("下载源内容")} className="flex size-8 items-center justify-center rounded-md text-[var(--app-muted)] hover:bg-[var(--app-active)]" onClick={() => { const blob = new Blob([content], { type: "text/plain;charset=utf-8" }); const href = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = href; anchor.download = document.source_uri || document.title + ".txt"; anchor.click(); URL.revokeObjectURL(href) }} type="button"><Download className="size-4" /></button></div></header><div className="flex min-h-0 flex-1 flex-col overflow-hidden"><div className="flex h-9 shrink-0 items-center justify-between border-b border-[var(--app-border)] px-4 text-[11px] text-[var(--app-muted)]"><span>{t("原始内容 · {count} 字符", { count: content.length.toLocaleString() })}</span><button className="text-[var(--app-muted)] hover:text-[var(--app-foreground)]" onClick={() => onGo("/documents/" + document.id)} type="button">{t("切换到预览")}</button></div><pre className="min-h-0 flex-1 overflow-auto bg-transparent px-5 py-4 font-mono text-[13px] leading-6 text-[var(--app-foreground)] [scrollbar-color:var(--app-control-border)_transparent]">{content || t("内容尚未加载。")}</pre></div></div>
}

function ZeroManagement({ backend, onRefresh, workspaceId }: { backend: KnowledgeBackend | null; onRefresh: () => void; workspaceId: string }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({ host: '', port: '22', user: '', remoteRoot: '/opt/openlink', knownHosts: '', privateKey: '', endpoint: '', chartReference: '', namespace: 'openlink-zero', releaseName: 'openlink-zero' })
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const deploy = async () => { setPending(true); setMessage(null); try { await requestJson("/api/knowledge/deployments", { method: "POST", body: JSON.stringify({ workspaceId, ...form, port: Number(form.port) }) }, t); setMessage(t("部署任务已提交。ZeroLink 会先在新集群完成迁移和校验，再切换服务端路由。")); setOpen(false); onRefresh() } catch (error) { setMessage(error instanceof Error ? error.message : t("无法提交部署任务")) } finally { setPending(false) } }
  return <><PageHeading eyebrow="ZeroLink" title={t("ZeroLink 管理")} description={t("管理知识库的向量索引运行时。所有文档元数据仍保留在 ZOKERBASE，Zero 只保存向量投影。")} action={<button className="flex h-9 items-center gap-1.5 rounded-lg bg-[var(--app-submit-background)] px-3 text-sm font-medium text-[var(--app-submit-foreground)] disabled:opacity-40" disabled={backend?.mode === "distributed" && backend.status === "migrating"} onClick={() => setOpen((value) => !value)} type="button"><Network className="size-4" />{t("部署 Distributed")}</button>} />
    <div className="mx-auto w-full max-w-5xl space-y-6 px-6 py-7 sm:px-8 lg:px-10"><section className="grid gap-3 md:grid-cols-3"><Metric icon={<Database className="size-4" />} label={t("运行模式")} value={backend?.mode === "distributed" ? "Distributed" : "Standalone"} /><div className="rounded-xl border border-[var(--app-control-border)] bg-[var(--app-surface)] p-4"><span className="text-xs text-[var(--app-muted)]">{t("服务状态")}</span><div className="mt-2 flex items-center gap-2 text-sm font-medium text-[var(--app-foreground)]"><i className={cn("size-2 rounded-full", backend?.status === "ready" ? "bg-[var(--app-success)]" : "bg-[var(--app-warning)]")} />{backend?.status === "ready" ? t("运行正常") : backend?.status || t("正在连接")}</div></div><div className="rounded-xl border border-[var(--app-control-border)] bg-[var(--app-surface)] p-4"><span className="text-xs text-[var(--app-muted)]">{t("向量维度")}</span><div className="mt-2 text-lg font-semibold text-[var(--app-foreground)]">{backend?.vector_dimension ?? "—"}</div></div></section>
      <section className="rounded-xl border border-[var(--app-control-border)] bg-[var(--app-surface)] p-5"><div className="flex flex-wrap items-start justify-between gap-4"><div><h2 className="text-sm font-semibold text-[var(--app-foreground)]">{t("当前索引后端")}</h2><p className="mt-1 text-sm text-[var(--app-muted)]">{backend?.endpoint || t("本地 Zero Standalone 正在由 OpenLink 生命周期托管。")}</p></div><button className="flex h-8 items-center gap-1.5 rounded-md border border-[var(--app-control-border)] px-2.5 text-sm hover:bg-[var(--app-active)]" onClick={onRefresh} type="button"><LoaderCircle className="size-3.5" />{t("刷新状态")}</button></div><dl className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4"><Meta label={t("集合名称")} value={<code>{backend?.collection_name || "openlink_knowledge_chunks_v1"}</code>} /><Meta label={t("嵌入提供商")} value={backend?.embedding_provider || t("未配置")} /><Meta label={t("嵌入模型")} value={backend?.embedding_model || t("未配置")} /><Meta label={t("最后更新")} value={backend ? relativeTime(backend.updated_at, t) : "—"} /></dl>{!backend?.embedding_model && <p className="mt-5 text-xs leading-5 text-[var(--app-muted)]">{t("配置真实向量模型后才能写入或检索知识库。")}<a className="ml-1 font-medium text-[var(--app-foreground)] underline underline-offset-4" href="/settings/ai-providers/embeddings">{t("前往配置")}</a></p>}{backend?.last_error && <p className="mt-5 rounded-lg border border-[var(--app-danger)] bg-[var(--app-danger-surface)] p-3 text-xs leading-5 text-[var(--app-danger)]">{backend.last_error}</p>}</section>
      {message && <p className="rounded-lg border border-[var(--app-control-border)] bg-[var(--app-surface)] px-4 py-3 text-sm text-[var(--app-muted)]">{message}</p>}
      {open && <section className="rounded-xl border border-[var(--app-control-border)] bg-[var(--app-surface)] p-5"><div className="flex items-center justify-between"><div><h2 className="text-sm font-semibold text-[var(--app-foreground)]">{t("部署 Distributed Zero")}</h2><p className="mt-1 text-xs text-[var(--app-muted)]">{t("通过 SSH 在目标 Kubernetes 集群部署；私钥只在服务端加密保存，永不返回浏览器。")}</p></div><button className="flex size-8 items-center justify-center rounded-md hover:bg-[var(--app-active)]" onClick={() => setOpen(false)} type="button"><X className="size-4" /></button></div><div className="mt-5 grid gap-4 sm:grid-cols-2">{([["host", "SSH Host"], ["port", "SSH Port"], ["user", "SSH User"], ["remoteRoot", "Remote Root"], ["endpoint", "Zero HTTP Endpoint"], ["chartReference", "Pinned Helm Chart"], ["namespace", "Kubernetes Namespace"], ["releaseName", "Helm Release"]] as const).map(([key, label]) => <Field key={key} label={label}><input className="knowledge-input" onChange={(event) => setForm((current) => ({ ...current, [key]: event.currentTarget.value }))} placeholder={key === "endpoint" ? "https://zero.internal.example" : ""} value={form[key]} /></Field>)}</div><div className="mt-4 grid gap-4 sm:grid-cols-2"><Field label="known_hosts"><textarea className="knowledge-input min-h-28 resize-y py-2 font-mono text-xs" onChange={(event) => setForm((current) => ({ ...current, knownHosts: event.currentTarget.value }))} value={form.knownHosts} /></Field><Field label="SSH Private Key"><textarea className="knowledge-input min-h-28 resize-y py-2 font-mono text-xs" onChange={(event) => setForm((current) => ({ ...current, privateKey: event.currentTarget.value }))} value={form.privateKey} /></Field></div><div className="mt-5 flex justify-end"><button className="flex h-9 items-center gap-1.5 rounded-lg bg-[var(--app-submit-background)] px-3 text-sm font-medium text-[var(--app-submit-foreground)] disabled:opacity-40" disabled={pending || !form.host || !form.user || !form.privateKey || !form.knownHosts || !form.endpoint || !form.chartReference} onClick={() => void deploy()} type="button">{pending && <LoaderCircle className="size-4 animate-spin" />}{t("提交安全部署任务")}</button></div></section>}
    </div></>
}
