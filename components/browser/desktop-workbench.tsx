'use client'

import type RFB from '@novnc/novnc'
import { AgentAvatar } from '@zorker/avatar'
import { ThinkingOrb } from '@/components/thinking/src'
import { browserReachableGatewayUrl } from '@/lib/browser-runtime/client'
import { useT } from '@/lib/i18n/client'
import { theme } from '@/lib/theme'
import { Monitor, RotateCw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

interface DesktopSessionResponse {
  desktopUrl?: string
  error?: { message?: string; retryable?: boolean }
}

type DesktopStatus = 'connecting' | 'ready' | 'failed'

const DESKTOP_CONNECT_TIMEOUT_MS = 5 * 60_000
const DESKTOP_HANDSHAKE_TIMEOUT_MS = 6_000
const DESKTOP_SOCKET_RETRY_MS = 750

let rfbModule: Promise<typeof RFB> | undefined

function loadDesktopClient() {
  if (rfbModule) return rfbModule
  // noVNC captures the console logger on import. Suppress its generic LAN
  // warning while leaving actual connection errors available to the viewer.
  const originalConsoleError = console.error
  const filter = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].includes('noVNC requires a secure context')) return
    originalConsoleError(...args)
  }
  console.error = filter
  rfbModule = import('@novnc/novnc').then(({ default: RFB }) => RFB).catch((error) => {
    rfbModule = undefined
    throw error
  }).finally(() => {
    if (console.error === filter) console.error = originalConsoleError
  })
  return rfbModule
}

function desktopWebSocketUrl(desktopPageUrl: string): string {
  const page = new URL(desktopPageUrl)
  const path = page.searchParams.get('path')?.replace(/^\/+/, '')
  if (!path?.startsWith('v1/desktop/gateway/sessions/')) {
    throw new Error('桌面连接地址无效')
  }

  page.protocol = page.protocol === 'https:' ? 'wss:' : 'ws:'
  page.pathname = `/${path}`
  page.search = ''
  page.hash = ''
  return page.toString()
}

function DesktopCanvas({
  desktopUrl,
  onRefreshAddress,
  onStatusChange,
}: {
  desktopUrl: string
  onRefreshAddress: () => void
  onStatusChange: (status: DesktopStatus, message?: string) => void
}) {
  const t = useT()
  const targetRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const target = targetRef.current
    if (!target) return

    let disposed = false
    let rfb: RFB | undefined
    let handshakeTimer: number | undefined
    let reconnectTimer: number | undefined
    let retried = false

    const clearHandshakeTimer = () => {
      window.clearTimeout(handshakeTimer)
      handshakeTimer = undefined
    }

    const fail = (message?: string) => {
      clearHandshakeTimer()
      const connection = rfb
      rfb = undefined
      connection?.disconnect()
      if (!disposed) onStatusChange('failed', message || t('桌面环境未就绪'))
    }

    const reconnect = (connection: RFB, disconnect: boolean) => {
      if (disposed || rfb !== connection) return
      rfb = undefined
      clearHandshakeTimer()
      if (disconnect) connection.disconnect()
      if (retried) {
        onRefreshAddress()
        return
      }
      retried = true
      onStatusChange('connecting')
      reconnectTimer = window.setTimeout(() => void connect(), DESKTOP_SOCKET_RETRY_MS)
    }

    async function connect() {
      try {
        const RFB = await loadDesktopClient()
        if (disposed || !target) return

        target.replaceChildren()

        const connection = new RFB(target, desktopWebSocketUrl(desktopUrl), { shared: true })
        rfb = connection
        handshakeTimer = window.setTimeout(() => reconnect(connection, true), DESKTOP_HANDSHAKE_TIMEOUT_MS)
        connection.background = '#000000'
        connection.scaleViewport = true
        // GNOME Remote Desktop treats SetDesktopSize as a session change and
        // can restart the stream. Let the local viewport scale the fixed remote
        // framebuffer instead of requesting repeated remote resizes.
        connection.resizeSession = false
        connection.focusOnClick = true
        connection.addEventListener('connect', () => {
          if (rfb !== connection) return
          clearHandshakeTimer()
          retried = false
          if (!disposed) onStatusChange('ready')
        })
        connection.addEventListener('disconnect', () => reconnect(connection, false))
        connection.addEventListener('securityfailure', (event) => {
          if (rfb === connection) fail((event as CustomEvent<{ reason?: string }>).detail?.reason)
        })
        connection.addEventListener('credentialsrequired', () => {
          if (rfb === connection) fail(t('桌面环境未就绪'))
        })
      } catch (error) {
        fail(error instanceof Error ? error.message : undefined)
      }
    }

    void connect()
    return () => {
      disposed = true
      clearHandshakeTimer()
      window.clearTimeout(reconnectTimer)
      rfb?.disconnect()
    }
  }, [desktopUrl, onRefreshAddress, onStatusChange, t])

  return (
    <div
      aria-label={t('OpenLink 桌面环境')}
      className="absolute inset-0 min-h-0 min-w-0 overflow-hidden bg-black"
      onPointerDown={() => rfbFocus(targetRef.current)}
      ref={targetRef}
    />
  )
}

function rfbFocus(target: HTMLElement | null) {
  target?.querySelector('canvas')?.focus({ preventScroll: true })
}

type DesktopWorkbenchProps = {
  chatSessionId?: string
  botId?: string
  loadingAvatar?: {
    color: string
    shape: string
    theme: 'light' | 'dark'
  }
  loadingLabel?: string
}

export function DesktopWorkbench({ chatSessionId, botId, loadingAvatar, loadingLabel }: DesktopWorkbenchProps) {
  const t = useT()
  const [desktopUrl, setDesktopUrl] = useState<string | null>(null)
  const [status, setStatus] = useState<DesktopStatus>('connecting')
  const [connectionVersion, setConnectionVersion] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const request = useRef<AbortController | null>(null)
  const refreshedAddress = useRef(false)

  const handleDesktopStatus = useCallback((nextStatus: DesktopStatus, message?: string) => {
    if (nextStatus === 'ready') refreshedAddress.current = false
    setStatus(nextStatus)
    setError(message || null)
  }, [])

  const connect = useCallback(async () => {
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    const deadline = Date.now() + DESKTOP_CONNECT_TIMEOUT_MS
    const timeout = AbortSignal.timeout(DESKTOP_CONNECT_TIMEOUT_MS)
    const signal = AbortSignal.any([controller.signal, timeout])
    setStatus('connecting')
    setDesktopUrl(null)
    setError(null)
    // Fetch the desktop address while loading the noVNC bundle.
    void loadDesktopClient().catch(() => undefined)
    let retryableMessage: string | null = null
    while (!signal.aborted && Date.now() < deadline) {
      try {
        if (!botId && !chatSessionId) throw new Error(t('桌面环境未就绪'))
        const response = await fetch(
          botId ? `/api/bots/${encodeURIComponent(botId)}/computer` : '/api/desktop/sessions',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(botId ? {} : { chatSessionId }),
            cache: 'no-store',
            signal,
          },
        )
        const payload = await response.json().catch(() => null) as DesktopSessionResponse | null
        if (signal.aborted) break
        if (response.ok && typeof payload?.desktopUrl === 'string') {
          setDesktopUrl(browserReachableGatewayUrl(payload.desktopUrl))
          setConnectionVersion((version) => version + 1)
          return
        }
        if (payload?.error?.retryable !== true) {
          throw new Error(payload?.error?.message || t('桌面环境未就绪'))
        }
        retryableMessage = payload?.error?.message || t('桌面环境未就绪')
      } catch (requestError) {
        if (signal.aborted) break
        if (requestError instanceof Error && requestError.message !== t('桌面环境未就绪')) {
          setError(requestError.message)
          setStatus('failed')
          return
        }
      }
      await new Promise((resolve) => window.setTimeout(resolve, Math.min(1_000, Math.max(0, deadline - Date.now()))))
    }
    if (!controller.signal.aborted) {
      setError(retryableMessage || t('桌面环境未就绪'))
      setStatus('failed')
    }
  }, [botId, chatSessionId, t])

  const refreshAddress = useCallback(() => {
    if (refreshedAddress.current) {
      handleDesktopStatus('failed', t('桌面环境未就绪'))
      return
    }
    refreshedAddress.current = true
    void connect()
  }, [connect, handleDesktopStatus, t])

  useEffect(() => {
    refreshedAddress.current = false
    void connect()
    return () => request.current?.abort()
  }, [connect])

  return (
    <section aria-label={t('桌面')} className={`flex size-full min-h-0 flex-col ${theme('editor')}`}>
      <div className={`relative min-h-0 min-w-0 flex-1 overflow-hidden ${loadingAvatar ? 'bg-[var(--app-active)]' : 'bg-black'}`}>
        {desktopUrl && status !== 'failed' && (
          <DesktopCanvas
            desktopUrl={desktopUrl}
            key={connectionVersion}
            onRefreshAddress={refreshAddress}
            onStatusChange={handleDesktopStatus}
          />
        )}
        {status === 'connecting' && (
          <div className={`absolute inset-0 flex flex-col items-center justify-center text-[var(--app-muted)] ${loadingAvatar ? 'gap-1.5' : 'gap-2 text-sm'}`}>
            {loadingAvatar ? (
              <span className="flex flex-col items-center gap-1.5">
                <AgentAvatar
                  color={loadingAvatar.color}
                  renderer="complete"
                  shape={loadingAvatar.shape}
                  size={24}
                  state="idle"
                  theme={loadingAvatar.theme}
                />
                <span className="text-[11px] leading-4">{loadingLabel ?? t('正在启动桌面环境')}</span>
              </span>
            ) : (
              <>
                <ThinkingOrb aria-label={t('正在启动桌面环境')} size={64} state="shaping" />
                <span>{loadingLabel ?? t('正在启动桌面环境')}</span>
              </>
            )}
          </div>
        )}
        {status === 'failed' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[var(--app-background)] px-6 text-center">
            <Monitor aria-hidden className="size-7 text-[var(--app-muted)]" />
            <div>
              <p className="text-sm font-medium">{t('桌面环境未就绪')}</p>
              {error && <p className="mt-1 max-w-md text-xs leading-5 text-[var(--app-muted)]">{error}</p>}
            </div>
            <button className="flex h-8 items-center gap-1.5 rounded-md border border-[var(--app-control-border)] px-3 text-xs hover:bg-[var(--app-active)]" onClick={() => {
              refreshedAddress.current = false
              void connect()
            }} type="button">
              <RotateCw className="size-3.5" />{t('重试')}
            </button>
          </div>
        )}
      </div>
    </section>
  )
}
