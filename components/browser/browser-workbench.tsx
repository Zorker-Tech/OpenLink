'use client'

import { ChromiumStreamSurface } from '@/components/browser/chromium-stream-surface'
import { NativePreviewSurface } from '@/components/browser/native-preview-surface'
import { ThinkingOrb } from '@/components/thinking/src'
import { useT } from '@/lib/i18n/client'
import { BrowserConnection, BrowserSessionCreateError, createBrowserSession, deleteBrowserSession, listBrowserPreviewTargets, type BrowserConnectionStatus, type BrowserPreviewTarget } from '@/lib/browser-runtime/client'
import type { BrowserAction, BrowserActionResult, BrowserSessionState, ElementReference } from '@/packages/browser-protocol/src/index'
import { MonitorUp, RotateCw } from 'lucide-react'
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'

function normalizeAddress(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return 'about:blank'
  if (/^[a-z][a-z\d+.-]*:/i.test(trimmed)) return trimmed
  if (/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(trimmed)) return `http://${trimmed}`
  if (/^[\w.-]+\.[A-Za-z]{2,}(?::\d+)?(?:\/|$)/.test(trimmed)) return `https://${trimmed}`
  return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`
}

export interface BrowserWorkbenchUiState {
  /** Private id used by the authenticated Chat API to bind Pi browser tools. */
  browserSessionId?: string
  address: string
  canGoBack: boolean
  canGoForward: boolean
  canInspect: boolean
  externalUrl?: string
  inspectMode: boolean
  annotateMode: boolean
  selectedElement?: ElementReference
  selectedStyles?: Record<string, string>
  previewLayers?: PreviewLayerItem[]
  themeTokens?: Record<string, string>
  status: BrowserConnectionStatus
  surface: 'native-preview' | 'chromium-stream'
  /** Live development servers discovered in the selected Preview project's runtime. */
  previewTargets: BrowserPreviewTarget[]
  activePreviewTargetId?: string
  previewTargetsLoading: boolean
  previewTargetsError?: string
}

export type PreviewInspectionMode = 'none' | 'edit' | 'annotate'

export interface PreviewLayerItem {
  element: ElementReference
  depth: number
  parentRef?: string
}

export interface BrowserPreviewAnnotationTarget {
  element?: ElementReference
  pagePath: string
  bounds: { x: number; y: number; width: number; height: number }
  viewport: { width: number; height: number }
}

export interface BrowserElementMove {
  element: ElementReference
  property: 'translate'
  before: string
  after: string
}

export interface BrowserWorkbenchHandle {
  back: () => void
  forward: () => void
  navigate: (address: string) => void
  openExternal: () => void
  reload: () => void
  setSurface: (surface: 'native-preview' | 'chromium-stream') => void
  selectPreviewTarget: (targetId: string) => void
  refreshPreviewTargets: () => void
  toggleInspector: () => void
  setInspectionMode: (mode: PreviewInspectionMode) => void
  readElementStyles: (ref: string) => void
  readLayers: (rootRef?: string) => void
  readThemeTokens: () => void
  activateElement: (ref: string) => void
  setElementStyle: (ref: string, property: string, value: string) => void
  resetElementStyle: (ref: string, property: string) => void
  setElementContent: (ref: string, content: string) => void
  resetElementContent: (ref: string) => void
  setThemeToken: (token: string, value: string) => void
  resetThemeToken: (token: string) => void
}

interface BrowserWorkbenchProps {
  projectId: string
  chatSessionId?: string
  /** Surface to launch when this workbench is mounted from a newly opened tab. */
  initialSurface?: BrowserWorkbenchUiState['surface']
  /** Last user-visible URL, used when a paused/recreated session must resume. */
  initialUrl?: string
  /** Last selected development server for the Preview surface. */
  initialPreviewTargetId?: string
  /** Keep a project Preview on its target error instead of switching to Realtime. */
  allowRealtimeFallback?: boolean
  onStateChange?: (state: BrowserWorkbenchUiState) => void
  onAnnotationTarget?: (target: BrowserPreviewAnnotationTarget) => void
  onElementMoved?: (move: BrowserElementMove) => void
  viewportMode: 'mobile' | 'browser'
}

export const BrowserWorkbench = forwardRef<BrowserWorkbenchHandle, BrowserWorkbenchProps>(function BrowserWorkbench({ projectId, chatSessionId, initialSurface = 'native-preview', initialUrl, initialPreviewTargetId, allowRealtimeFallback = true, onStateChange, onAnnotationTarget, onElementMoved, viewportMode }, ref) {
  const t = useT()
  const initialSurfaceRef = useRef<BrowserWorkbenchUiState['surface']>(initialSurface)
  const initialUrlRef = useRef(initialUrl ?? '')
  const initialPreviewTargetIdRef = useRef(initialPreviewTargetId)
  const [surface, setSurface] = useState<BrowserWorkbenchUiState['surface']>(initialSurface)
  const [connection, setConnection] = useState<BrowserConnection | null>(null)
  const [sessionState, setSessionState] = useState<BrowserSessionState | null>(null)
  const [status, setStatus] = useState<BrowserConnectionStatus>('connecting')
  const [error, setError] = useState<string | null>(null)
  const [address, setAddress] = useState('')
  const [inspectionMode, setInspectionMode] = useState<PreviewInspectionMode>('none')
  const [selectedElement, setSelectedElement] = useState<ElementReference | null>(null)
  const [selectedStyles, setSelectedStyles] = useState<Record<string, string> | undefined>()
  const [previewLayers, setPreviewLayers] = useState<PreviewLayerItem[] | undefined>()
  const [themeTokens, setThemeTokens] = useState<Record<string, string> | undefined>()
  const [previewTargets, setPreviewTargets] = useState<BrowserPreviewTarget[]>([])
  const [activePreviewTargetId, setActivePreviewTargetId] = useState<string | undefined>(initialPreviewTargetId)
  const [previewTargetsLoading, setPreviewTargetsLoading] = useState(true)
  const [previewTargetsError, setPreviewTargetsError] = useState<string | undefined>()
  const requestVersion = useRef(0)
  const connectionRef = useRef<BrowserConnection | null>(null)
  const previewActionKinds = useRef(new Map<string, BrowserAction['type']>())
  const annotationTargetRef = useRef(onAnnotationTarget)
  const elementMoveRef = useRef(onElementMoved)
  const inspectMode = inspectionMode === 'edit'

  useEffect(() => {
    initialUrlRef.current = initialUrl ?? ''
    initialPreviewTargetIdRef.current = initialPreviewTargetId
  }, [initialPreviewTargetId, initialUrl])

  useEffect(() => { annotationTargetRef.current = onAnnotationTarget }, [onAnnotationTarget])
  useEffect(() => { elementMoveRef.current = onElementMoved }, [onElementMoved])

  const refreshPreviewTargets = useCallback(async () => {
    setPreviewTargetsLoading(true)
    setPreviewTargetsError(undefined)
    try {
      const targets = await listBrowserPreviewTargets({ projectId, chatSessionId })
      setPreviewTargets(targets)
      setActivePreviewTargetId((current) => current && targets.some((target) => target.id === current)
        ? current
        : targets[0]?.id)
    } catch (error) {
      setPreviewTargets([])
      setPreviewTargetsError(error instanceof Error ? error.message : t('无法发现项目开发服务器'))
    } finally {
      setPreviewTargetsLoading(false)
    }
  }, [chatSessionId, projectId, t])

  const openSession = useCallback(async (nextSurface: 'native-preview' | 'chromium-stream', initialUrl?: string, previewTargetId?: string) => {
    const version = ++requestVersion.current
    setError(null)
    setStatus('connecting')
    setInspectionMode('none')
    setSelectedElement(null)
    setSelectedStyles(undefined)
    setPreviewLayers(undefined)
    setThemeTokens(undefined)
    previewActionKinds.current.clear()
    const previous = connectionRef.current
    connectionRef.current = null
    previous?.close()
    // A native Preview is a UI-only surface over one fixed upstream. Close it
    // when switching targets to avoid leaking one tunnel per probe. The
    // Chromium session is the Agent's stable browser capability and is never
    // deleted by the UI; hidden tabs and pauses only close the transport.
    if (previous?.state.surface === 'native-preview') {
      await deleteBrowserSession({ projectId, chatSessionId }, previous.state.id).catch(() => undefined)
    }
    try {
      const descriptor = await createBrowserSession({
        projectId,
        chatSessionId,
        surface: nextSurface,
        initialUrl: nextSurface === 'chromium-stream' ? normalizeAddress(initialUrl || address || 'about:blank') : undefined,
        ...(previewTargetId ? { previewTargetId } : {}),
        viewport: viewportMode === 'mobile'
          ? { width: 391, height: 835, deviceScaleFactor: 1 }
          : { width: Math.max(240, window.innerWidth - 390), height: Math.max(240, window.innerHeight - 50), deviceScaleFactor: Math.min(4, Math.max(0.5, window.devicePixelRatio || 1)) },
      })
      if (version !== requestVersion.current) {
        // A stale open request must not delete the session: it can be the
        // Agent's browser or the current UI session reused through its
        // stable Chromium profile key.
        return
      }
      const next = new BrowserConnection(descriptor)
      connectionRef.current = next
      setConnection(next)
      setSessionState(descriptor.session)
      if (descriptor.previewTarget?.id) setActivePreviewTargetId(descriptor.previewTarget.id)
      setAddress(descriptor.session.pages.find((page) => page.active)?.url || initialUrl || '')
      next.onStatus(setStatus)
      next.onState((state) => {
        setSessionState(state)
        const page = state.pages.find((candidate) => candidate.id === state.activePageId)
        if (page) setAddress(page.url)
      })
      next.onError(setError)
      next.onSessionLost((reason) => {
        if (version !== requestVersion.current) return
        setError(t('{reason}，正在重新创建浏览器会话', { reason }))
        const currentAddress = next.state.pages.find((page) => page.active)?.url || initialUrl || address
        // Browser Host sessions are intentionally ephemeral. If the host
        // reaper, a VM restart, or a token expiry removes one while this tab is
        // still mounted, create a replacement instead of leaving the canvas in
        // a reconnect loop against a dead session id.
        void openSession(nextSurface, currentAddress, previewTargetId)
      })
      next.onEvent((envelope) => {
        if (envelope.event.type !== 'action.result') return
        const result: BrowserActionResult = envelope.event.result
        if (result.element) setSelectedElement(result.element)
        const actionType = previewActionKinds.current.get(result.actionId)
        if (actionType) previewActionKinds.current.delete(result.actionId)
        if (result.snapshot && actionType) {
          try {
            const snapshot = JSON.parse(result.snapshot) as Record<string, unknown>
            if ((actionType === 'preview.styles.read' || actionType === 'preview.style.set' || actionType === 'preview.style.reset')
              && snapshot.styles && typeof snapshot.styles === 'object' && !Array.isArray(snapshot.styles)) {
              setSelectedStyles(snapshot.styles as Record<string, string>)
            }
            if (actionType === 'preview.layers.read' && Array.isArray(snapshot.nodes)) {
              setPreviewLayers(snapshot.nodes as PreviewLayerItem[])
            }
            if (actionType === 'preview.theme.read' || actionType === 'preview.theme.set' || actionType === 'preview.theme.reset') {
              if (snapshot.tokens && typeof snapshot.tokens === 'object' && !Array.isArray(snapshot.tokens)) {
                setThemeTokens(snapshot.tokens as Record<string, string>)
              }
            }
            if (actionType === 'preview.annotation.select'
              && typeof snapshot.pagePath === 'string'
              && snapshot.bounds && typeof snapshot.bounds === 'object'
              && snapshot.viewport && typeof snapshot.viewport === 'object') {
              const bounds = snapshot.bounds as Record<string, unknown>
              const viewport = snapshot.viewport as Record<string, unknown>
              if (['x', 'y', 'width', 'height'].every((key) => typeof bounds[key] === 'number' && Number.isFinite(bounds[key]))
                && ['width', 'height'].every((key) => Number.isSafeInteger(viewport[key]) && Number(viewport[key]) > 0)) {
                annotationTargetRef.current?.({
                  ...(result.element ? { element: result.element } : {}),
                  pagePath: snapshot.pagePath,
                  bounds: bounds as BrowserPreviewAnnotationTarget['bounds'],
                  viewport: viewport as BrowserPreviewAnnotationTarget['viewport'],
                })
              }
            }
          } catch {
            setError(t('预览工具返回了无法识别的数据'))
          }
        }
        if (!result.ok && result.error) setError(result.error.message)
      })
      next.connect()
    } catch (sessionError) {
      if (version !== requestVersion.current) return
      // A persisted target may have stopped since the last visit. Refresh the
      // inventory and let discovery choose the current/first live server
      // instead of leaving Preview pinned to a stale target.
      if (previewTargetId && sessionError instanceof BrowserSessionCreateError && sessionError.code === 'PREVIEW_TARGET_NOT_FOUND') {
        setActivePreviewTargetId(undefined)
        await refreshPreviewTargets()
        await openSession(nextSurface, initialUrl)
        return
      }
      // Callers may opt into using the Agent's Chromium surface when a
      // project preview is unavailable. The chat Preview opts out so opening
      // it cannot silently take over the Agent-owned Realtime session.
      if (allowRealtimeFallback
        && nextSurface === 'native-preview'
        && sessionError instanceof BrowserSessionCreateError
        && sessionError.code === 'PREVIEW_NOT_ATTACHED') {
        setSurface('chromium-stream')
        await openSession('chromium-stream', initialUrl || address || 'about:blank')
        return
      }
      setConnection(null)
      setSessionState(null)
      setStatus('failed')
      setError(sessionError instanceof Error ? sessionError.message : String(sessionError))
    }
  }, [address, allowRealtimeFallback, chatSessionId, projectId, refreshPreviewTargets, t, viewportMode])

  const openSessionRef = useRef(openSession)
  useEffect(() => {
    openSessionRef.current = openSession
  }, [openSession])

  useEffect(() => {
    void refreshPreviewTargets()
    void openSessionRef.current(initialSurfaceRef.current, initialUrlRef.current || undefined, initialPreviewTargetIdRef.current)
    return () => {
      requestVersion.current += 1
      const current = connectionRef.current
      connectionRef.current = null
      // Close this client transport. The Chromium Browser Session is retained
      // for the Agent and for a fast reconnect; only a UI-only native Preview
      // tunnel is released.
      current?.close()
      if (current?.state.surface === 'native-preview') {
        void deleteBrowserSession({ projectId, chatSessionId }, current.state.id).catch(() => undefined)
      }
    }
  }, [chatSessionId, projectId, refreshPreviewTargets])

  useEffect(() => {
    if (!connection || connection.state.surface !== 'chromium-stream') return
    const viewport = viewportMode === 'mobile'
      ? { width: 391, height: 835, deviceScaleFactor: 1 }
      : { width: Math.max(240, window.innerWidth - 390), height: Math.max(240, window.innerHeight - 50), deviceScaleFactor: Math.min(4, Math.max(0.5, window.devicePixelRatio || 1)) }
    try { connection.sendAction({ type: 'viewport.set', viewport }) } catch {}
  }, [connection, viewportMode])

  const activePage = sessionState?.pages.find((page) => page.id === sessionState.activePageId)
  const runPreviewAction = useCallback((action: BrowserAction) => {
    if (!connection || surface !== 'native-preview' || !activePage) return
    try {
      const actionId = connection.sendAction(action)
      previewActionKinds.current.set(actionId, action.type)
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : String(actionError))
    }
  }, [activePage, connection, surface])
  const handleElementSelected = useCallback((element: ElementReference | null) => {
    setSelectedElement(element)
    if (!element || !activePage) {
      setSelectedStyles(undefined)
      return
    }
    runPreviewAction({ type: 'preview.styles.read', pageId: activePage.id, ref: element.ref })
    runPreviewAction({ type: 'preview.layers.read', pageId: activePage.id, rootRef: element.ref })
  }, [activePage, runPreviewAction])
  const handleElementMoved = useCallback((move: BrowserElementMove) => {
    setSelectedElement(move.element)
    setSelectedStyles((current) => current ? { ...current, [move.property]: move.after } : current)
    elementMoveRef.current?.(move)
  }, [])
  const setInspectionModeForPreview = useCallback((mode: PreviewInspectionMode) => {
    setInspectionMode(mode)
  }, [])
  const readElementStyles = useCallback((elementRef: string) => {
    if (activePage) runPreviewAction({ type: 'preview.styles.read', pageId: activePage.id, ref: elementRef })
  }, [activePage, runPreviewAction])
  const readLayers = useCallback((rootRef?: string) => {
    if (activePage) runPreviewAction({ type: 'preview.layers.read', pageId: activePage.id, ...(rootRef ? { rootRef } : {}) })
  }, [activePage, runPreviewAction])
  const readThemeTokens = useCallback(() => {
    if (activePage) runPreviewAction({ type: 'preview.theme.read', pageId: activePage.id })
  }, [activePage, runPreviewAction])
  const activateElement = useCallback((elementRef: string) => {
    if (!activePage) return
    setInspectionMode('edit')
    runPreviewAction({ type: 'preview.element.activate', pageId: activePage.id, ref: elementRef })
    runPreviewAction({ type: 'preview.styles.read', pageId: activePage.id, ref: elementRef })
    runPreviewAction({ type: 'preview.layers.read', pageId: activePage.id, rootRef: elementRef })
  }, [activePage, runPreviewAction])
  const setElementStyle = useCallback((elementRef: string, property: string, value: string) => {
    if (activePage) runPreviewAction({ type: 'preview.style.set', pageId: activePage.id, ref: elementRef, property, value })
  }, [activePage, runPreviewAction])
  const resetElementStyle = useCallback((elementRef: string, property: string) => {
    if (activePage) runPreviewAction({ type: 'preview.style.reset', pageId: activePage.id, ref: elementRef, property })
  }, [activePage, runPreviewAction])
  const setElementContent = useCallback((elementRef: string, content: string) => {
    if (activePage) runPreviewAction({ type: 'preview.content.set', pageId: activePage.id, ref: elementRef, content })
  }, [activePage, runPreviewAction])
  const resetElementContent = useCallback((elementRef: string) => {
    if (activePage) runPreviewAction({ type: 'preview.content.reset', pageId: activePage.id, ref: elementRef })
  }, [activePage, runPreviewAction])
  const setThemeToken = useCallback((token: string, value: string) => {
    if (activePage) runPreviewAction({ type: 'preview.theme.set', pageId: activePage.id, token, value })
  }, [activePage, runPreviewAction])
  const resetThemeToken = useCallback((token: string) => {
    if (activePage) runPreviewAction({ type: 'preview.theme.reset', pageId: activePage.id, token })
  }, [activePage, runPreviewAction])
  const selectAnnotationTarget = useCallback((selection: { x: number; y: number; width?: number; height?: number }) => {
    if (activePage) runPreviewAction({ type: 'preview.annotation.select', pageId: activePage.id, ...selection })
  }, [activePage, runPreviewAction])
  useEffect(() => {
    setSelectedElement(null)
    setSelectedStyles(undefined)
  }, [activePage?.id, activePage?.url])
  const sendPageAction = useCallback((action: 'page.back' | 'page.forward' | 'page.reload') => {
    if (!connection || !activePage) return
    try { connection.sendAction({ type: action, pageId: activePage.id }) } catch {}
  }, [activePage, connection])
  const navigate = useCallback((value: string) => {
    if (!connection || !activePage) return
    const url = normalizeAddress(value)
    setAddress(url)
    try { connection.sendAction({ type: 'page.navigate', pageId: activePage.id, url }) } catch {}
  }, [activePage, connection])

  const externalUrl = (() => {
    if (surface !== 'native-preview') return activePage?.url
    const previewUrl = connection?.descriptor.connection.previewUrl
    if (!previewUrl) return undefined
    const url = new URL(previewUrl)
    url.search = ''
    url.pathname = url.pathname.replace(/\/__openlink_bootstrap$/, '/')
    return url.toString()
  })()

  // The control socket can be connected before the browser session has
  // finished provisioning its page. Keep the same branded loading state for
  // both phases so a realtime surface never flashes an empty/black canvas.
  const sessionInitializing = status === 'connecting'
    || status === 'reconnecting'
    || (surface === 'chromium-stream' && status === 'connected' && sessionState?.status !== 'ready')

  const setNextSurface = useCallback((next: 'native-preview' | 'chromium-stream') => {
    if (next === surface) return
    setSurface(next)
    void openSession(next, address)
  }, [address, openSession, surface])

  const selectPreviewTarget = useCallback((targetId: string) => {
    setActivePreviewTargetId(targetId)
    // A different development server is an authenticated target resolved by
    // Agent Host. The native Preview surface is recreated against it so the
    // proxy receives the correct signing headers and browser path prefix.
    setSurface('native-preview')
    void openSession('native-preview', undefined, targetId)
  }, [openSession])

  const openExternal = useCallback(() => {
    if (externalUrl) window.open(externalUrl, '_blank', 'noopener,noreferrer')
  }, [externalUrl])

  useImperativeHandle(ref, () => ({
    back: () => sendPageAction('page.back'),
    forward: () => sendPageAction('page.forward'),
    navigate,
    openExternal,
    reload: () => sendPageAction('page.reload'),
    setSurface: setNextSurface,
    selectPreviewTarget,
    refreshPreviewTargets: () => { void refreshPreviewTargets() },
    toggleInspector: () => setInspectionMode((value) => value === 'edit' ? 'none' : 'edit'),
    setInspectionMode: setInspectionModeForPreview,
    readElementStyles,
    readLayers,
    readThemeTokens,
    activateElement,
    setElementStyle,
    resetElementStyle,
    setElementContent,
    resetElementContent,
    setThemeToken,
    resetThemeToken,
  }), [activateElement, navigate, openExternal, readElementStyles, readLayers, readThemeTokens, refreshPreviewTargets, resetElementContent, resetElementStyle, resetThemeToken, selectAnnotationTarget, selectPreviewTarget, sendPageAction, setElementContent, setElementStyle, setInspectionModeForPreview, setNextSurface, setThemeToken])

  useEffect(() => {
    onStateChange?.({
      browserSessionId: connection?.state.id,
      address,
      canGoBack: Boolean(activePage?.canGoBack),
      canGoForward: Boolean(activePage?.canGoForward),
      canInspect: Boolean(connection),
      externalUrl,
      inspectMode,
      annotateMode: inspectionMode === 'annotate',
      ...(selectedElement ? { selectedElement } : {}),
      ...(selectedStyles ? { selectedStyles } : {}),
      ...(previewLayers ? { previewLayers } : {}),
      ...(themeTokens ? { themeTokens } : {}),
      status,
      surface,
      previewTargets,
      ...(activePreviewTargetId ? { activePreviewTargetId } : {}),
      previewTargetsLoading,
      ...(previewTargetsError ? { previewTargetsError } : {}),
    })
  }, [activePage?.canGoBack, activePage?.canGoForward, activePreviewTargetId, address, connection, externalUrl, inspectMode, inspectionMode, onStateChange, previewLayers, previewTargets, previewTargetsError, previewTargetsLoading, selectedElement, selectedStyles, status, surface, themeTokens])

  return (
    <section className="flex size-full min-h-0 flex-col bg-[var(--app-background)] text-[var(--app-foreground)]">
      <div className="relative min-h-0 flex-1 overflow-hidden bg-[var(--app-editor-background)]">
        {connection && sessionState?.status === 'ready' && surface === 'native-preview' && (
          <NativePreviewSurface annotationMode={inspectionMode === 'annotate'} connection={connection} inspectMode={inspectMode} onAnnotationSelect={selectAnnotationTarget} onElementMoved={handleElementMoved} onElementSelected={handleElementSelected} />
        )}
        {connection && sessionState?.status === 'ready' && surface === 'chromium-stream' && (
          <ChromiumStreamSurface connection={connection} inspectMode={inspectMode} selectedElement={inspectMode ? selectedElement : null} viewportMode={viewportMode} />
        )}
        {sessionInitializing ? (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-[var(--app-background)]/88 text-sm text-[var(--app-muted)] backdrop-blur-sm">
            <ThinkingOrb aria-label={status === 'reconnecting' ? t('正在恢复浏览器连接') : t('正在启动浏览器')} size={64} state="shaping" />
            <span>{status === 'reconnecting' ? t('正在恢复浏览器连接') : t('正在启动浏览器')}</span>
          </div>
        ) : null}
        {error && !connection ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[var(--app-background)] px-6 text-center">
            <MonitorUp className="size-7 text-[var(--app-muted)]" />
            <div><p className="text-sm font-medium">{t('浏览器运行时尚未就绪')}</p>
              <p className="mt-1 max-w-md text-xs leading-5 text-[var(--app-muted)]">{error}</p></div>
            <div className="flex gap-2">
              <button className="flex h-8 items-center gap-1.5 rounded-md border border-[var(--app-control-border)] px-3 text-xs hover:bg-[var(--app-active)]" onClick={() => void openSession(surface, address)} type="button"><RotateCw className="size-3.5" />{t('重试')}</button>
              {allowRealtimeFallback && surface === 'native-preview' && <button className="h-8 rounded-md bg-[var(--app-foreground)] px-3 text-xs text-[var(--app-background)]" onClick={() => setNextSurface('chromium-stream')} type="button">{t('打开实时浏览器')}</button>}
            </div>
          </div>
        ) : null}
        {error && connection ? <div className="absolute bottom-3 left-1/2 z-30 max-w-[70%] -translate-x-1/2 rounded-full border border-[var(--app-danger)] bg-[var(--app-danger-surface)] px-3 py-1.5 text-xs text-[var(--app-danger)] shadow-lg backdrop-blur">{error}</div> : null}
      </div>
    </section>
  )
})
