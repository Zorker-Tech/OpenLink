'use client'

import { BrowserWorkbench, type BrowserWorkbenchHandle, type BrowserWorkbenchUiState } from '@/components/browser/browser-workbench'
import { PreviewDesignPanel, type PreviewAnnotationMarker, type PreviewDesignPanelHandle, type PreviewProjectOption } from '@/components/browser/preview-design-panel'
import { DesktopWorkbench } from '@/components/browser/desktop-workbench'
import { CodeServerWorkbench } from '@/components/code-server/code-server-workbench'
import { ProjectSupabasePanel } from '@/components/project-supabase-panel'
import { ProjectSupabaseStudioFrame } from '@/components/project-supabase-studio-frame'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import type { ActiveWorkspaceSummary, PersonalWorkspaceSummary } from '@/components/workspace-switcher'
import type { SessionWorkspaceTab, SessionWorkspaceView } from '@/lib/session-ui-state'
import type { OrganizationSummary } from '@/lib/organizations'
import type { ChatSessionSummary } from '@/lib/chat-session-types'
import type { AgentPromptAttachment } from '@/lib/agent-runtime/events'
import { theme } from '@/lib/theme'
import { useT } from '@/lib/i18n/client'
import { ArrowLeft, ArrowRight, ChevronDown, ExternalLink, Inspect, PanelRightOpen, RefreshCw, RotateCw, Server } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

interface GitVersionOption {
  ref: string
  shortRef: string
  message: string
  timestamp: string
  current: boolean
}

interface WorkspacePanelProps {
  activeWorkspace: ActiveWorkspaceSummary
  avatarUrl: string | null
  chatSessions: ChatSessionSummary[]
  email: string
  nickname: string
  organizations: OrganizationSummary[]
  personalWorkspace: PersonalWorkspaceSummary
  projectId: string
  userId: string
}

interface WorkspaceSurfacesProps {
  browserState: BrowserWorkbenchUiState
  browserWorkbenchRef: RefObject<BrowserWorkbenchHandle | null>
  view: SessionWorkspaceView
  openTabs: SessionWorkspaceTab[]
  uiReady: boolean
  initialBrowserUrl: string
  initialPreviewTargetId: string | null
  previewProjects: PreviewProjectOption[]
  previewProjectId: string
  onBrowserStateChange: (state: BrowserWorkbenchUiState) => void
  onSelectPreviewProject: (projectId: string) => void
  onSelectWorkspaceTab: (tab: SessionWorkspaceTab) => void
  onToggleDeviceView: () => void
  onSubmitPreviewRequest: (message: string, attachments: AgentPromptAttachment[], projectId: string) => Promise<boolean>
  sessionId: string
  projectName: string
  dataSurface: 'panel' | 'studio'
  gitVersions: GitVersionOption[]
  gitVersionsLoading: boolean
  gitVersionError: string | null
  onSelectGitVersion: (ref: string | null) => void
  selectedGitRef: string | null
  panelProps: WorkspacePanelProps
}

function ToolbarButton({ label, children, className = '', ...props }: { label: string; children: React.ReactNode; className?: string } & React.ComponentProps<'button'>) {
  return (
    <button aria-label={label} className={`flex size-7 shrink-0 items-center justify-center rounded-md text-[var(--app-muted)] transition-colors hover:bg-[var(--app-active)] hover:text-[var(--app-foreground)] disabled:pointer-events-none disabled:opacity-35 ${className}`} type="button" {...props}>
      {children}
    </button>
  )
}

function BrowserNavigationBar({
  browserState,
  browserWorkbenchRef,
  gitVersions,
  gitVersionsLoading,
  gitVersionError,
  onSelectGitVersion,
  onSelectPreviewTarget,
  onToggleDeviceView,
  onToggleDesignPanel,
  designPanelOpen,
  selectedGitRef,
  workspaceView,
}: {
  browserState: BrowserWorkbenchUiState
  browserWorkbenchRef: RefObject<BrowserWorkbenchHandle | null>
  gitVersions: GitVersionOption[]
  gitVersionsLoading: boolean
  gitVersionError: string | null
  onSelectGitVersion: (ref: string | null) => void
  onSelectPreviewTarget: (targetId: string) => void
  onToggleDeviceView: () => void
  onToggleDesignPanel: () => void
  designPanelOpen: boolean
  selectedGitRef: string | null
  workspaceView: 'mobile' | 'browser'
}) {
  const [addressDraft, setAddressDraft] = useState(browserState.address)
  const addressInputRef = useRef<HTMLInputElement | null>(null)
  const t = useT()

  useEffect(() => {
    if (document.activeElement !== addressInputRef.current) setAddressDraft(browserState.address)
  }, [browserState.address])

  return (
    <div aria-label={t('浏览器工具栏')} className="flex h-11 shrink-0 items-center gap-1.5 border-b border-[var(--app-border)] bg-[var(--app-background)] p-2 text-[var(--app-foreground)]">
      <div aria-hidden className="size-7 shrink-0" />
      <div className="flex min-w-[150px] flex-1 items-center justify-center">
        <form className="flex h-7 w-full max-w-[500px] items-center overflow-hidden rounded-md border border-[var(--app-control-border)] px-0.5" onSubmit={(event) => { event.preventDefault(); browserWorkbenchRef.current?.navigate(addressDraft) }}>
          <ToolbarButton className="size-6! rounded" disabled={!browserState.canGoBack} label={t('后退')} onClick={() => browserWorkbenchRef.current?.back()}><ArrowLeft className="size-4" /></ToolbarButton>
          <ToolbarButton className="size-6! rounded" disabled={!browserState.canGoForward} label={t('前进')} onClick={() => browserWorkbenchRef.current?.forward()}><ArrowRight className="size-4" /></ToolbarButton>
          <ToolbarButton aria-pressed={workspaceView === 'mobile'} className="size-6! rounded hover:bg-transparent!" label={t('设备')} onClick={onToggleDeviceView}><img alt="" className="app-control-icon size-4" src="/openlink/app/phone.svg" /></ToolbarButton>
          <input
            aria-label={t('浏览器地址')}
            className="h-6 min-w-0 flex-1 bg-transparent px-1 text-[12px] tracking-[-0.0762px] text-[var(--app-muted)] outline-none focus:text-[var(--app-foreground)]"
            onBlur={() => setAddressDraft(browserState.address)}
            onChange={(event) => setAddressDraft(event.currentTarget.value)}
            placeholder={t('输入网址或搜索')}
            ref={addressInputRef}
            spellCheck={false}
            value={addressDraft}
          />
          <ToolbarButton aria-pressed={browserState.inspectMode} className={`size-6! rounded ${browserState.inspectMode ? 'bg-[var(--app-active)] text-[var(--app-foreground)]' : ''}`} disabled={!browserState.canInspect} label={t('选择组件')} onClick={() => browserWorkbenchRef.current?.toggleInspector()}><Inspect className="size-4" /></ToolbarButton>
          <ToolbarButton className="size-6! rounded" disabled={!browserState.externalUrl} label={t('在新窗口打开')} onClick={() => browserWorkbenchRef.current?.openExternal()}><ExternalLink className="size-4" /></ToolbarButton>
          <ToolbarButton aria-pressed={designPanelOpen} className={`size-6! rounded md:hidden ${designPanelOpen ? 'bg-[var(--app-active)] text-[var(--app-foreground)]' : ''}`} label={designPanelOpen ? t('关闭预览工具') : t('预览工具')} onClick={onToggleDesignPanel}><PanelRightOpen className="size-4" /></ToolbarButton>
          <ToolbarButton className="size-6! rounded" disabled={(!browserState.canInspect && !browserState.externalUrl) || browserState.status === 'connecting' || browserState.status === 'reconnecting'} label={t('刷新')} onClick={() => browserWorkbenchRef.current?.reload()}><RotateCw className="size-4" /></ToolbarButton>
          <DropdownMenu>
            <DropdownMenuTrigger render={<button aria-label={t('切换开发服务器')} className="flex h-6 max-w-[120px] shrink-0 items-center gap-1 rounded px-1 text-[11px] text-[var(--app-muted)] hover:bg-[var(--app-active)] hover:text-[var(--app-foreground)]" type="button" />}>
              <Server className="size-3.5 shrink-0" />
              <span className="truncate">{browserState.previewTargets.find((target) => target.id === browserState.activePreviewTargetId)?.port ? `:${browserState.previewTargets.find((target) => target.id === browserState.activePreviewTargetId)?.port}` : t('预览目标')}</span>
              <ChevronDown className="size-3.5 shrink-0" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-[300px] rounded-xl border border-[var(--app-border)] bg-[var(--app-elevated)] p-1.5 text-[var(--app-foreground)] shadow-[0_12px_36px_var(--app-shadow)] ring-0">
              <div className="flex items-center justify-between px-2.5 py-1.5 text-[11px] font-medium text-[var(--app-muted)]">
                <span>{t('开发服务器')}</span>
                <button aria-label={t('刷新开发服务器')} className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-[var(--app-hover)] hover:text-[var(--app-foreground)]" onClick={() => browserWorkbenchRef.current?.refreshPreviewTargets()} type="button"><RefreshCw className="size-3" />{t('刷新')}</button>
              </div>
              {browserState.previewTargetsLoading && <div className="px-2.5 py-2 text-xs text-[var(--app-muted)]">{t('正在探测项目开发服务器…')}</div>}
              {!browserState.previewTargetsLoading && browserState.previewTargetsError && <div className="px-2.5 py-2 text-xs text-[var(--app-danger)]">{browserState.previewTargetsError}</div>}
              {!browserState.previewTargetsLoading && !browserState.previewTargetsError && browserState.previewTargets.length === 0 && <div className="px-2.5 py-2 text-xs leading-5 text-[var(--app-muted)]">{t('未检测到运行中的开发服务器。启动 dev server 后点击刷新。')}</div>}
              {browserState.previewTargets.map((target) => (
                <DropdownMenuItem className="h-auto min-h-9 cursor-pointer gap-2 rounded-md px-2.5 py-1.5 text-sm focus:bg-[var(--app-hover)]" key={target.id} onClick={() => onSelectPreviewTarget(target.id)}>
                  <Server className="size-3.5 shrink-0 text-[var(--app-muted)]" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{target.label}</span>
                    <span className="block text-[11px] text-[var(--app-muted)]">:{target.port}</span>
                  </span>
                  {browserState.activePreviewTargetId === target.id && <span className="text-[11px] text-[var(--app-brand)]">{t('当前')}</span>}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </form>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger render={<button aria-label={t('切换预览版本')} className="flex h-7 w-[96px] shrink-0 items-center justify-center gap-1 rounded-md text-sm font-medium tracking-[-0.1504px] text-[var(--app-muted)] hover:bg-[var(--app-active)] hover:text-[var(--app-foreground)]" type="button" />}>
          <span className="max-w-[70px] truncate">{selectedGitRef ? `@${gitVersions.find((version) => version.ref === selectedGitRef)?.shortRef ?? selectedGitRef.slice(0, 8)}` : 'Latest'}</span>
          <ChevronDown className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-[280px] rounded-xl border border-[var(--app-border)] bg-[var(--app-elevated)] p-1.5 text-[var(--app-foreground)] shadow-[0_12px_36px_var(--app-shadow)] ring-0">
          <DropdownMenuItem className="h-9 cursor-pointer gap-2 rounded-md px-2.5 text-sm focus:bg-[var(--app-hover)]" disabled={!selectedGitRef} onClick={() => onSelectGitVersion(null)}>
            <span className="min-w-0 flex-1 truncate">{t('最新')}</span>
            {!selectedGitRef && <span className="text-[11px] text-[var(--app-muted)]">{t('当前')}</span>}
          </DropdownMenuItem>
          {gitVersionsLoading && <div className="px-2.5 py-2 text-xs text-[var(--app-muted)]">{t('正在读取 Git 版本…')}</div>}
          {!gitVersionsLoading && gitVersions.length === 0 && <div className="px-2.5 py-2 text-xs text-[var(--app-muted)]">{t('暂无可切换的 Git 版本')}</div>}
          {!gitVersionsLoading && gitVersions.map((version) => (
            <DropdownMenuItem className="h-auto min-h-9 cursor-pointer gap-2 rounded-md px-2.5 py-1.5 text-sm focus:bg-[var(--app-hover)]" key={version.ref} onClick={() => onSelectGitVersion(version.ref)}>
              <span className="min-w-0 flex-1">
                <span className="block truncate">{version.message}</span>
                <span className="block text-[11px] text-[var(--app-muted)]">@{version.shortRef}{version.current ? t(' · 当前提交') : ''}</span>
              </span>
            </DropdownMenuItem>
          ))}
          {gitVersionError && <div className="px-2.5 py-2 text-xs text-[var(--app-danger)]">{gitVersionError}</div>}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

/**
 * Keep each opened runtime surface mounted until its workspace tab is closed.
 * Preview and realtime each own a browser session. This component lives
 * outside chat-workspace.tsx so timeline refreshes do not replace runtime
 * iframes and WebSocket lifetimes.
 */
export function WorkspaceSurfaces({
  browserState,
  browserWorkbenchRef,
  view,
  openTabs,
  uiReady,
  initialBrowserUrl,
  initialPreviewTargetId,
  previewProjects,
  previewProjectId,
  onBrowserStateChange,
  onSelectPreviewProject,
  onSelectWorkspaceTab,
  onToggleDeviceView,
  onSubmitPreviewRequest,
  sessionId,
  projectName,
  panelProps,
  dataSurface,
  gitVersions,
  gitVersionsLoading,
  gitVersionError,
  onSelectGitVersion,
  selectedGitRef,
}: WorkspaceSurfacesProps) {
  const t = useT()
  const [studioMounted, setStudioMounted] = useState(dataSurface === 'studio')
  const [designPanelOpen, setDesignPanelOpen] = useState(true)
  const previewWorkbenchRef = useRef<BrowserWorkbenchHandle | null>(null)
  const previewDesignPanelRef = useRef<PreviewDesignPanelHandle | null>(null)
  const realtimeWorkbenchRef = useRef<BrowserWorkbenchHandle | null>(null)
  const [previewState, setPreviewState] = useState<BrowserWorkbenchUiState>(() => ({ ...browserState, surface: 'native-preview' }))
  const [previewAnnotations, setPreviewAnnotations] = useState<PreviewAnnotationMarker[]>([])
  const [realtimeState, setRealtimeState] = useState<BrowserWorkbenchUiState>(() => ({ ...browserState, surface: 'chromium-stream' }))
  const [pendingPreviewTargetId, setPendingPreviewTargetId] = useState<string | null>(null)
  const previewOpen = openTabs.includes('preview')
  const realtimeOpen = openTabs.includes('realtime')
  const browserVisible = view === 'browser' || view === 'mobile'
  const activeBrowserTab = browserState.surface === 'chromium-stream' && realtimeOpen
    ? 'realtime'
    : previewOpen ? 'preview' : 'realtime'

  useEffect(() => {
    if (dataSurface === 'studio') setStudioMounted(true)
  }, [dataSurface])

  useEffect(() => {
    setPreviewState({
      address: '', canGoBack: false, canGoForward: false, canInspect: false, inspectMode: false,
      annotateMode: false, status: 'connecting', surface: 'native-preview', previewTargets: [],
      previewTargetsLoading: true,
    })
    setPreviewAnnotations([])
  }, [previewProjectId])

  useEffect(() => {
    if (!uiReady || !previewOpen || !pendingPreviewTargetId || !previewWorkbenchRef.current) return
    previewWorkbenchRef.current.selectPreviewTarget(pendingPreviewTargetId)
    setPendingPreviewTargetId(null)
  }, [pendingPreviewTargetId, previewOpen, uiReady])

  useEffect(() => {
    browserWorkbenchRef.current = activeBrowserTab === 'preview'
      ? previewWorkbenchRef.current
      : realtimeWorkbenchRef.current
    return () => {
      browserWorkbenchRef.current = null
    }
  }, [activeBrowserTab, browserWorkbenchRef, uiReady])

  const previewActive = browserVisible && activeBrowserTab === 'preview'
  const realtimeActive = browserVisible && activeBrowserTab === 'realtime'
  const activeBrowserState = activeBrowserTab === 'preview' ? previewState : realtimeState
  const handlePreviewStateChange = useCallback((state: BrowserWorkbenchUiState) => {
    const previewTabState = state.surface === 'native-preview' ? state : { ...state, surface: 'native-preview' as const }
    setPreviewState(previewTabState)
    if (browserVisible && activeBrowserTab === 'preview') onBrowserStateChange(previewTabState)
  }, [activeBrowserTab, browserVisible, onBrowserStateChange])
  const handleRealtimeStateChange = useCallback((state: BrowserWorkbenchUiState) => {
    setRealtimeState(state)
    if (browserVisible && activeBrowserTab === 'realtime') onBrowserStateChange(state)
  }, [activeBrowserTab, browserVisible, onBrowserStateChange])
  const handleSelectPreviewTarget = useCallback((targetId: string) => {
    onSelectWorkspaceTab('preview')
    if (previewWorkbenchRef.current) {
      previewWorkbenchRef.current.selectPreviewTarget(targetId)
    } else {
      setPendingPreviewTargetId(targetId)
    }
  }, [onSelectWorkspaceTab])

  if (!uiReady) return <div className="size-full" aria-busy="true" />

  const browserOpen = previewOpen || realtimeOpen
  const desktopOpen = openTabs.includes('desktop')
  const codeOpen = openTabs.includes('code')
  const databaseOpen = openTabs.includes('database')
  const surfaceClass = (active: boolean) => `absolute inset-0 size-full overflow-hidden ${active ? 'z-10 visible' : 'invisible pointer-events-none'}`

  return (
    <div className="relative size-full min-h-0 min-w-0 overflow-hidden">
      {browserOpen && (
        <div aria-hidden={!browserVisible} className={surfaceClass(browserVisible)} data-workspace-surface={view === 'mobile' ? 'mobile' : 'browser'}>
          <div className="flex size-full min-w-0 flex-col">
            <BrowserNavigationBar browserState={activeBrowserState} browserWorkbenchRef={browserWorkbenchRef} designPanelOpen={designPanelOpen} gitVersionError={gitVersionError} gitVersions={gitVersions} gitVersionsLoading={gitVersionsLoading} onSelectGitVersion={onSelectGitVersion} onSelectPreviewTarget={handleSelectPreviewTarget} onToggleDesignPanel={() => setDesignPanelOpen((open) => !open)} onToggleDeviceView={onToggleDeviceView} selectedGitRef={selectedGitRef} workspaceView={view === 'mobile' ? 'mobile' : 'browser'} />
            <main aria-label={t('预览画布')} className={`relative flex min-h-0 min-w-0 flex-1 overflow-hidden ${view === 'browser' ? theme('surface') : theme('editor')}`}>
              <div className="relative flex min-h-0 min-w-0 flex-1">
                <div className={view === 'browser' ? 'size-full' : 'flex size-full items-center justify-center px-4 py-[46px]'}>
                  <div className={`relative ${view === 'browser' ? 'size-full' : `h-full max-h-[835px] w-[391px] max-w-full overflow-hidden rounded-xl border shadow-[0_8px_16px_-4px_var(--app-shadow),0_24px_32px_-8px_var(--app-shadow)] ${theme('surface', 'border')}`}`}>
                    {previewOpen && (
                      <div aria-hidden={!previewActive} className={surfaceClass(previewActive)} data-workspace-browser-surface="preview">
                        <BrowserWorkbench
                          allowRealtimeFallback={false}
                          chatSessionId={previewProjectId === panelProps.projectId ? sessionId : undefined}
                          onAnnotationTarget={(target) => previewDesignPanelRef.current?.handleAnnotationTarget(target)}
                          onElementMoved={(move) => previewDesignPanelRef.current?.handleElementMoved(move)}
                          onStateChange={handlePreviewStateChange}
                          projectId={previewProjectId}
                          ref={previewWorkbenchRef}
                          initialPreviewTargetId={initialPreviewTargetId || undefined}
                          initialSurface="native-preview"
                          initialUrl={previewProjectId === panelProps.projectId ? initialBrowserUrl || undefined : undefined}
                          viewportMode={view === 'mobile' ? 'mobile' : 'browser'}
                        />
                        {previewActive && previewAnnotations.map((annotation, index) => (
                          <button
                            aria-label={t('第 {number} 条批注', { number: index + 1 })}
                            className="pointer-events-auto absolute z-30 flex size-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 border-white bg-[var(--app-focus-ring)] text-[10px] font-semibold text-white shadow"
                            key={annotation.id}
                            onClick={() => previewDesignPanelRef.current?.showAnnotation(annotation.id)}
                            style={{ left: `${annotation.bounds.x / annotation.viewport.width * 100}%`, top: `${annotation.bounds.y / annotation.viewport.height * 100}%` }}
                            type="button"
                          >{index + 1}</button>
                        ))}
                      </div>
                    )}
                    {realtimeOpen && (
                      <div aria-hidden={!realtimeActive} className={surfaceClass(realtimeActive)} data-workspace-browser-surface="realtime">
                        <BrowserWorkbench chatSessionId={sessionId} projectId={panelProps.projectId} initialSurface="chromium-stream" initialUrl={initialBrowserUrl || undefined} onStateChange={handleRealtimeStateChange} ref={realtimeWorkbenchRef} viewportMode={view === 'mobile' ? 'mobile' : 'browser'} />
                      </div>
                    )}
                  </div>
                </div>
              </div>
              {previewOpen && activeBrowserTab === 'preview' && (
                <PreviewDesignPanel
                  browserState={previewState}
                  className={designPanelOpen ? '' : 'max-[720px]:hidden'}
                  onSubmitRequest={onSubmitPreviewRequest}
                  onSelectPreviewProject={onSelectPreviewProject}
                  previewProjects={previewProjects}
                  projectId={previewProjectId}
                  selectedPreviewProjectId={previewProjectId}
                  sessionId={sessionId}
                  onAnnotationsChange={setPreviewAnnotations}
                  ref={previewDesignPanelRef}
                  workbenchRef={previewWorkbenchRef}
                />
              )}
            </main>
          </div>
        </div>
      )}
      {desktopOpen && (
        <div aria-hidden={view !== 'desktop'} className={surfaceClass(view === 'desktop')} data-workspace-surface="desktop">
          <DesktopWorkbench chatSessionId={sessionId} />
        </div>
      )}
      {codeOpen && (
        <div aria-hidden={view !== 'code'} className={surfaceClass(view === 'code')} data-workspace-surface="code">
          <CodeServerWorkbench chatSessionId={sessionId} />
        </div>
      )}
      {databaseOpen && (
        <>
          <div aria-hidden={view !== 'data' || dataSurface !== 'panel'} className={surfaceClass(view === 'data' && dataSurface === 'panel')} data-workspace-surface="database">
            <ProjectSupabasePanel {...panelProps} projectName={projectName} sessionId={sessionId} embedded />
          </div>
          {studioMounted && (
            <div aria-hidden={view !== 'data' || dataSurface !== 'studio'} className={surfaceClass(view === 'data' && dataSurface === 'studio')} data-workspace-surface="database-studio">
              <ProjectSupabaseStudioFrame sessionId={sessionId} />
            </div>
          )}
        </>
      )}
    </div>
  )
}
