'use client'

import { AppSidebarAccountFooter } from '@/components/app-sidebar-controls'
import { OrganizationDialog } from '@/components/organization-dialog'
import { BrowserWorkbench, type BrowserWorkbenchHandle, type BrowserWorkbenchUiState } from '@/components/browser/browser-workbench'
import { WorkspaceSwitcher, type ActiveWorkspaceSummary, type PersonalWorkspaceSummary } from '@/components/workspace-switcher'
import { WorkspaceNavigationRail } from '@/components/workspace-navigation'
import { OpenLinkThemeProvider } from '@/components/ui/theme-scope'
import { createChatSessionAction } from '@/app/chat/actions'
import type { ThemeMode } from '@/components/account-drawer'
import { useT } from '@/lib/i18n/client'
import type { OrganizationSummary } from '@/lib/organizations'
import { isPreviewTargetId } from '@/lib/browser-preview-target-id'
import { AppWindow, ArrowLeft, ArrowRight, ExternalLink, LoaderCircle, MessageSquarePlus, Monitor, RotateCw, Smartphone, WandSparkles } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useRef, useState } from 'react'

interface ProjectPreviewWorkspaceProps {
  activeWorkspace: ActiveWorkspaceSummary
  personalWorkspace: PersonalWorkspaceSummary
  organizations: OrganizationSummary[]
  projects: PreviewProjectSummary[]
  selectedProjectId?: string
  nickname: string
  email: string
  avatarUrl: string | null
  initialPreviewTargetId?: string
}

interface PreviewProjectSummary {
  id: string
  name: string
  source_url: string | null
  description: string
}

const EMPTY_BROWSER_STATE: BrowserWorkbenchUiState = {
  address: '',
  canGoBack: false,
  canGoForward: false,
  canInspect: false,
  inspectMode: false,
  status: 'connecting',
  surface: 'native-preview',
  previewTargets: [],
  previewTargetsLoading: true,
}

export function ProjectPreviewWorkspace({
  activeWorkspace,
  personalWorkspace,
  organizations,
  projects,
  selectedProjectId: initialProjectId,
  nickname,
  email,
  avatarUrl,
  initialPreviewTargetId,
}: ProjectPreviewWorkspaceProps) {
  const t = useT()
  const router = useRouter()
  const workbenchRef = useRef<BrowserWorkbenchHandle | null>(null)
  const targetSyncRef = useRef<string | null>(null)
  const [projectId, setProjectId] = useState(initialProjectId ?? '')
  const [activeInitialTargetId, setActiveInitialTargetId] = useState(initialPreviewTargetId)
  const [browserState, setBrowserState] = useState(EMPTY_BROWSER_STATE)
  const [viewport, setViewport] = useState<'browser' | 'mobile'>('browser')
  const [themeMode, setThemeMode] = useState<ThemeMode>('dark')
  const [systemLight, setSystemLight] = useState(false)
  const [organizationDialogOpen, setOrganizationDialogOpen] = useState(false)
  const [addressDraft, setAddressDraft] = useState('')
  const [openingChat, setOpeningChat] = useState(false)
  const selectedProject = projects.find((project) => project.id === projectId)
  const activeTheme = themeMode === 'light' || (themeMode === 'system' && systemLight) ? 'light' : 'dark'

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
    const root = document.documentElement
    if (activeTheme === 'dark') root.classList.add('dark')
    else root.classList.remove('dark')
  }, [activeTheme])

  useEffect(() => {
    setProjectId(initialProjectId ?? '')
  }, [initialProjectId])

  useEffect(() => {
    setActiveInitialTargetId(initialPreviewTargetId)
  }, [initialPreviewTargetId])

  useEffect(() => {
    if (!projectId || browserState.previewTargetsLoading) return
    const targetId = browserState.activePreviewTargetId && isPreviewTargetId(browserState.activePreviewTargetId)
      ? browserState.activePreviewTargetId
      : null
    if (targetSyncRef.current === targetId) return
    targetSyncRef.current = targetId
    const query = new URLSearchParams({ project: projectId })
    if (targetId) query.set('target', targetId)
    router.replace(`/app/${activeWorkspace.slug}/preview?${query.toString()}`, { scroll: false })
  }, [activeWorkspace.slug, browserState.activePreviewTargetId, browserState.previewTargetsLoading, projectId, router])

  useEffect(() => {
    setAddressDraft(browserState.address)
  }, [browserState.address])

  const selectProject = useCallback((nextProjectId: string) => {
    if (!projects.some((project) => project.id === nextProjectId)) return
    targetSyncRef.current = null
    setActiveInitialTargetId(undefined)
    setProjectId(nextProjectId)
    setBrowserState(EMPTY_BROWSER_STATE)
    router.replace(`/app/${activeWorkspace.slug}/preview?project=${encodeURIComponent(nextProjectId)}`, { scroll: false })
  }, [activeWorkspace.slug, projects, router])

  const openProjectChat = useCallback(async () => {
    if (!selectedProject || openingChat) return
    setOpeningChat(true)
    try {
      const result = await createChatSessionAction({ workspaceSlug: activeWorkspace.slug, projectId: selectedProject.id })
      if (result.path) router.push(result.path)
    } finally {
      setOpeningChat(false)
    }
  }, [activeWorkspace.slug, openingChat, router, selectedProject])

  const handleStateChange = useCallback((state: BrowserWorkbenchUiState) => {
    setBrowserState(state)
  }, [])

  const targetLabel = browserState.previewTargets.find((target) => target.id === browserState.activePreviewTargetId)?.label

  return (
    <OpenLinkThemeProvider theme={activeTheme}>
      <div className="openlink-app-shell flex h-dvh min-h-[500px] overflow-hidden" data-theme={activeTheme}>
        <WorkspaceNavigationRail
          activePage={t('预览')}
          footer={<AppSidebarAccountFooter compact activeWorkspace={activeWorkspace} avatarUrl={avatarUrl} email={email} nickname={nickname} onOpenOrganization={() => setOrganizationDialogOpen(true)} onThemeChange={(mode) => { setThemeMode(mode); window.localStorage.setItem('openlink-theme', mode) }} organizations={organizations} themeMode={themeMode} />}
          onCloseMobile={() => {}}
          onHistory={() => router.push(`/app/${activeWorkspace.slug}`)}
          sidebarWidth={288}
          workspaceSlug={activeWorkspace.slug}
        />

        <main className="flex min-w-0 flex-1 flex-col bg-[var(--app-background)]">
          <header className="flex h-12 shrink-0 items-center gap-3 border-b border-[var(--app-border)] px-3">
            <div className="w-[190px] min-w-0"><WorkspaceSwitcher activeWorkspace={activeWorkspace} organizations={organizations} personalWorkspace={personalWorkspace} onAddOrganization={() => setOrganizationDialogOpen(true)} /></div>
            <span className="hidden h-5 w-px bg-[var(--app-border)] sm:block" />
            <label className="flex min-w-0 flex-1 items-center gap-2">
              <AppWindow className="size-4 shrink-0 text-[var(--app-muted)]" />
              <span className="sr-only">{t('选择项目')}</span>
              <select aria-label={t('选择项目')} className="h-8 min-w-0 flex-1 rounded-md border border-[var(--app-control-border)] bg-[var(--app-surface)] px-2 text-sm text-[var(--app-foreground)] outline-none focus:border-[var(--app-focus-ring)]" onChange={(event) => selectProject(event.currentTarget.value)} value={projectId}>
                {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
              </select>
            </label>
            {selectedProject && <span className="hidden max-w-[220px] truncate text-xs text-[var(--app-muted)] lg:block" title={selectedProject.source_url ?? selectedProject.description}>{selectedProject.source_url || selectedProject.description || t('项目工作区')}</span>}
            <button className="flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-[var(--app-control-border)] px-2.5 text-xs font-medium text-[var(--app-foreground)] hover:bg-[var(--app-hover)] disabled:opacity-50" disabled={!selectedProject || openingChat} onClick={() => void openProjectChat()} type="button">
              {openingChat ? <LoaderCircle className="size-3.5 animate-spin" /> : <MessageSquarePlus className="size-3.5" />}
              <span className="hidden sm:inline">{t('在聊天中继续')}</span>
            </button>
          </header>

          {selectedProject ? (
            <div className="flex min-h-0 flex-1 flex-col">
              <div aria-label={t('预览工具栏')} className="flex h-11 shrink-0 items-center gap-1.5 border-b border-[var(--app-border)] px-2">
                <button aria-label={t('后退')} className="flex size-7 items-center justify-center rounded-md text-[var(--app-muted)] hover:bg-[var(--app-hover)] disabled:opacity-35" disabled={!browserState.canGoBack} onClick={() => workbenchRef.current?.back()} type="button"><ArrowLeft className="size-4" /></button>
                <button aria-label={t('前进')} className="flex size-7 items-center justify-center rounded-md text-[var(--app-muted)] hover:bg-[var(--app-hover)] disabled:opacity-35" disabled={!browserState.canGoForward} onClick={() => workbenchRef.current?.forward()} type="button"><ArrowRight className="size-4" /></button>
                <button aria-label={t('桌面视口')} aria-pressed={viewport === 'browser'} className={`flex size-7 items-center justify-center rounded-md ${viewport === 'browser' ? 'bg-[var(--app-active)] text-[var(--app-foreground)]' : 'text-[var(--app-muted)] hover:bg-[var(--app-hover)]'}`} onClick={() => setViewport('browser')} type="button"><Monitor className="size-4" /></button>
                <button aria-label={t('移动视口')} aria-pressed={viewport === 'mobile'} className={`flex size-7 items-center justify-center rounded-md ${viewport === 'mobile' ? 'bg-[var(--app-active)] text-[var(--app-foreground)]' : 'text-[var(--app-muted)] hover:bg-[var(--app-hover)]'}`} onClick={() => setViewport('mobile')} type="button"><Smartphone className="size-4" /></button>
                <form className="mx-auto flex h-7 min-w-[140px] max-w-[520px] flex-1 items-center overflow-hidden rounded-md border border-[var(--app-control-border)] px-1" onSubmit={(event) => { event.preventDefault(); workbenchRef.current?.navigate(addressDraft) }}>
                  <input aria-label={t('预览路径')} className="h-6 min-w-0 flex-1 bg-transparent px-1 text-xs text-[var(--app-foreground)] outline-none placeholder:text-[var(--app-subtle-foreground)]" onBlur={() => setAddressDraft(browserState.address)} onChange={(event) => setAddressDraft(event.currentTarget.value)} onFocus={(event) => { if (event.currentTarget.value.startsWith('http')) event.currentTarget.select() }} placeholder="/" value={addressDraft} />
                  {targetLabel && <span className="hidden max-w-[110px] truncate border-l border-[var(--app-border)] pl-2 text-[10px] text-[var(--app-muted)] md:block" title={targetLabel}>{targetLabel}</span>}
                </form>
                <select aria-label={t('预览目标')} className="h-7 max-w-[150px] rounded-md border border-[var(--app-control-border)] bg-[var(--app-surface)] px-1.5 text-[11px] text-[var(--app-muted)] outline-none focus:border-[var(--app-focus-ring)] disabled:opacity-50" disabled={browserState.previewTargetsLoading || !browserState.previewTargets.length} onChange={(event) => workbenchRef.current?.selectPreviewTarget(event.currentTarget.value)} value={browserState.activePreviewTargetId ?? ''}>
                  {!browserState.activePreviewTargetId && <option value="">{browserState.previewTargetsLoading ? t('正在发现…') : t('预览目标')}</option>}
                  {browserState.previewTargets.map((target) => <option key={target.id} value={target.id}>{target.label}</option>)}
                </select>
                <button aria-label={t('选择组件')} aria-pressed={browserState.inspectMode} className={`flex size-7 items-center justify-center rounded-md ${browserState.inspectMode ? 'bg-[var(--app-active)] text-[var(--app-foreground)]' : 'text-[var(--app-muted)] hover:bg-[var(--app-hover)]'} disabled:opacity-35`} disabled={!browserState.canInspect} onClick={() => workbenchRef.current?.toggleInspector()} type="button"><WandSparkles className="size-4" /></button>
                <button aria-label={t('在新窗口打开')} className="flex size-7 items-center justify-center rounded-md text-[var(--app-muted)] hover:bg-[var(--app-hover)] disabled:opacity-35" disabled={!browserState.externalUrl} onClick={() => workbenchRef.current?.openExternal()} type="button"><ExternalLink className="size-4" /></button>
                <button aria-label={t('刷新')} className="flex size-7 items-center justify-center rounded-md text-[var(--app-muted)] hover:bg-[var(--app-hover)] disabled:opacity-35" disabled={browserState.status === 'connecting' || browserState.status === 'reconnecting'} onClick={() => workbenchRef.current?.reload()} type="button"><RotateCw className="size-4" /></button>
              </div>
              <div className="relative flex min-h-0 flex-1 overflow-hidden">
                <section aria-label={t('预览画布')} className="relative min-w-0 flex-1 overflow-hidden bg-[var(--app-editor-background)]">
                  <BrowserWorkbench
                    allowRealtimeFallback={false}
                    initialPreviewTargetId={activeInitialTargetId}
                    initialSurface="native-preview"
                    key={selectedProject.id}
                    onStateChange={handleStateChange}
                    projectId={selectedProject.id}
                    ref={workbenchRef}
                    viewportMode={viewport}
                  />
                </section>
                <aside aria-label={t('预览工具')} className="hidden w-[260px] shrink-0 border-l border-[var(--app-border)] bg-[var(--app-background)] lg:flex lg:flex-col">
                  <div className="flex h-12 items-center gap-2 border-b border-[var(--app-border)] px-4 text-sm font-medium"><AppWindow className="size-4 text-[var(--app-muted)]" />{t('预览目标')}</div>
                  <div className="space-y-3 p-4 text-xs leading-5 text-[var(--app-muted)]">
                    <div>
                      <p className="font-medium text-[var(--app-foreground)]">{selectedProject.name}</p>
                    </div>
                    {!browserState.previewTargets.length && !browserState.previewTargetsLoading && <p>{t('未发现运行中的开发服务器。启动项目 Web 服务后刷新目标。')}</p>}
                    {browserState.previewTargetsLoading && <p className="mt-2 flex items-center gap-2"><LoaderCircle className="size-3.5 animate-spin" />{t('正在发现项目开发服务器…')}</p>}
                    {browserState.previewTargetsError && <p className="mt-2 text-[var(--app-danger)]">{browserState.previewTargetsError}</p>}
                    {browserState.previewTargets.map((target) => <button className={`flex min-h-8 w-full items-center justify-between gap-2 rounded-md border px-2 text-left ${browserState.activePreviewTargetId === target.id ? 'border-[var(--app-focus-ring)] bg-[var(--app-active)] text-[var(--app-foreground)]' : 'border-[var(--app-control-border)] hover:bg-[var(--app-hover)]'}`} key={target.id} onClick={() => workbenchRef.current?.selectPreviewTarget(target.id)} type="button"><span className="truncate">{target.label}</span><span className="shrink-0 font-mono">:{target.port}</span></button>)}
                    <button className="mt-3 flex h-7 items-center gap-1.5 rounded-md border border-[var(--app-control-border)] px-2 text-xs hover:bg-[var(--app-hover)]" onClick={() => workbenchRef.current?.refreshPreviewTargets()} type="button"><RotateCw className="size-3" />{t('刷新目标')}</button>
                  </div>
                </aside>
              </div>
            </div>
          ) : (
            <section className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 text-center">
              <AppWindow className="size-9 text-[var(--app-muted)]" />
              <h1 className="mt-4 text-base font-medium">{t('工作区还没有代码项目')}</h1>
              <p className="mt-1 max-w-md text-sm leading-6 text-[var(--app-muted)]">{t('创建或导入一个代码项目后，就可以从这里独立打开和切换开发预览。')}</p>
              <button className="mt-4 h-8 rounded-md bg-[var(--app-submit-background)] px-3 text-sm font-medium text-[var(--app-submit-foreground)] hover:opacity-90" onClick={() => router.push(`/app/${activeWorkspace.slug}/projects`)} type="button">{t('打开项目')}</button>
            </section>
          )}
        </main>
        <OrganizationDialog onOpenChange={setOrganizationDialogOpen} open={organizationDialogOpen} />
      </div>
    </OpenLinkThemeProvider>
  )
}
