'use client'

import { ChromiumStreamSurface } from '@/components/browser/chromium-stream-surface'
import { NativePreviewSurface } from '@/components/browser/native-preview-surface'
import { ThinkingOrb } from '@/components/thinking/src'
import { useT } from '@/lib/i18n/client'
import { BrowserConnection, BrowserSessionCreateError, createBrowserSession, deleteBrowserSession, type BrowserConnectionStatus } from '@/lib/browser-runtime/client'
import type { BrowserActionResult, BrowserSessionState, ElementReference } from '@/packages/browser-protocol/src/index'
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
  status: BrowserConnectionStatus
  surface: 'native-preview' | 'chromium-stream'
}

export interface BrowserWorkbenchHandle {
  back: () => void
  forward: () => void
  navigate: (address: string) => void
  openExternal: () => void
  reload: () => void
  setSurface: (surface: 'native-preview' | 'chromium-stream') => void
  toggleInspector: () => void
}

interface BrowserWorkbenchProps {
  chatSessionId: string
  /** Surface to launch when this workbench is mounted from a newly opened tab. */
  initialSurface?: BrowserWorkbenchUiState['surface']
  onStateChange?: (state: BrowserWorkbenchUiState) => void
  viewportMode: 'mobile' | 'browser'
}

export const BrowserWorkbench = forwardRef<BrowserWorkbenchHandle, BrowserWorkbenchProps>(function BrowserWorkbench({ chatSessionId, initialSurface = 'native-preview', onStateChange, viewportMode }, ref) {
  const t = useT()
  const initialSurfaceRef = useRef<BrowserWorkbenchUiState['surface']>(initialSurface)
  const [surface, setSurface] = useState<BrowserWorkbenchUiState['surface']>(initialSurface)
  const [connection, setConnection] = useState<BrowserConnection | null>(null)
  const [sessionState, setSessionState] = useState<BrowserSessionState | null>(null)
  const [status, setStatus] = useState<BrowserConnectionStatus>('connecting')
  const [error, setError] = useState<string | null>(null)
  const [address, setAddress] = useState('')
  const [inspectMode, setInspectMode] = useState(false)
  const [selectedElement, setSelectedElement] = useState<ElementReference | null>(null)
  const requestVersion = useRef(0)
  const connectionRef = useRef<BrowserConnection | null>(null)

  const openSession = useCallback(async (nextSurface: 'native-preview' | 'chromium-stream', initialUrl?: string) => {
    const version = ++requestVersion.current
    setError(null)
    setStatus('connecting')
    setInspectMode(false)
    setSelectedElement(null)
    const previous = connectionRef.current
    connectionRef.current = null
    previous?.close()
    // Chromium sessions use a durable profile keyed by the chat session.
    // Wait for the old Browser Host runtime to release that profile before
    // creating the replacement surface; launching two persistent contexts
    // against the same profile races Chromium's lock file and makes switching
    // between Preview/Realtime intermittently fail with a black canvas.
    if (previous) await deleteBrowserSession(chatSessionId, previous.state.id).catch(() => undefined)
    try {
      const descriptor = await createBrowserSession({
        chatSessionId,
        surface: nextSurface,
        initialUrl: nextSurface === 'chromium-stream' ? normalizeAddress(initialUrl || address || 'about:blank') : undefined,
        viewport: viewportMode === 'mobile'
          ? { width: 391, height: 835, deviceScaleFactor: 1 }
          : { width: Math.max(240, window.innerWidth - 390), height: Math.max(240, window.innerHeight - 50), deviceScaleFactor: Math.min(4, Math.max(0.5, window.devicePixelRatio || 1)) },
      })
      if (version !== requestVersion.current) {
        void deleteBrowserSession(chatSessionId, descriptor.session.id)
        return
      }
      const next = new BrowserConnection(descriptor)
      connectionRef.current = next
      setConnection(next)
      setSessionState(descriptor.session)
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
        void openSession(nextSurface, currentAddress)
      })
      next.onEvent((envelope) => {
        if (envelope.event.type !== 'action.result') return
        const result: BrowserActionResult = envelope.event.result
        if (result.element) setSelectedElement(result.element)
        if (!result.ok && result.error) setError(result.error.message)
      })
      next.connect()
    } catch (sessionError) {
      if (version !== requestVersion.current) return
      // A Project preview is optional, but the session-scoped Browser agent
      // capability is not. Fall back to the realtime Chromium surface when no
      // project web server is listening so @Browser can still navigate and
      // inspect external pages instead of disappearing from an active chat.
      if (nextSurface === 'native-preview'
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
  }, [address, chatSessionId, t, viewportMode])

  const openSessionRef = useRef(openSession)
  useEffect(() => {
    openSessionRef.current = openSession
  }, [openSession])

  useEffect(() => {
    void openSessionRef.current(initialSurfaceRef.current)
    return () => {
      requestVersion.current += 1
      const current = connectionRef.current
      connectionRef.current = null
      current?.close()
      if (current) void deleteBrowserSession(chatSessionId, current.state.id).catch(() => undefined)
    }
  }, [chatSessionId])

  useEffect(() => {
    if (!connection || connection.state.surface !== 'chromium-stream') return
    const viewport = viewportMode === 'mobile'
      ? { width: 391, height: 835, deviceScaleFactor: 1 }
      : { width: Math.max(240, window.innerWidth - 390), height: Math.max(240, window.innerHeight - 50), deviceScaleFactor: Math.min(4, Math.max(0.5, window.devicePixelRatio || 1)) }
    try { connection.sendAction({ type: 'viewport.set', viewport }) } catch {}
  }, [connection, viewportMode])

  const activePage = sessionState?.pages.find((page) => page.id === sessionState.activePageId)
  useEffect(() => {
    if (!inspectMode) setSelectedElement(null)
  }, [inspectMode])
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
    toggleInspector: () => setInspectMode((value) => !value),
  }), [navigate, openExternal, sendPageAction, setNextSurface])

  useEffect(() => {
    onStateChange?.({
      browserSessionId: connection?.state.id,
      address,
      canGoBack: Boolean(activePage?.canGoBack),
      canGoForward: Boolean(activePage?.canGoForward),
      canInspect: Boolean(connection),
      externalUrl,
      inspectMode,
      status,
      surface,
    })
  }, [activePage?.canGoBack, activePage?.canGoForward, address, connection, externalUrl, inspectMode, onStateChange, status, surface])

  return (
    <section className="flex size-full min-h-0 flex-col bg-[var(--app-background)] text-[var(--app-foreground)]">
      <div className="relative min-h-0 flex-1 overflow-hidden bg-[var(--app-editor-background)]">
        {connection && sessionState?.status === 'ready' && surface === 'native-preview' && (
          <NativePreviewSurface connection={connection} inspectMode={inspectMode} onElementSelected={setSelectedElement} />
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
              {surface === 'native-preview' && <button className="h-8 rounded-md bg-[var(--app-foreground)] px-3 text-xs text-[var(--app-background)]" onClick={() => setNextSurface('chromium-stream')} type="button">{t('打开实时浏览器')}</button>}
            </div>
          </div>
        ) : null}
        {error && connection ? <div className="absolute bottom-3 left-1/2 z-30 max-w-[70%] -translate-x-1/2 rounded-full border border-[var(--app-danger)] bg-[var(--app-danger-surface)] px-3 py-1.5 text-xs text-[var(--app-danger)] shadow-lg backdrop-blur">{error}</div> : null}
      </div>
    </section>
  )
})
