'use client'

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
  onStatusChange,
}: {
  desktopUrl: string
  onStatusChange: (status: DesktopStatus, message?: string) => void
}) {
  const t = useT()
  const targetRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const target = targetRef.current
    if (!target) return

    let disposed = false
    let rfb: import('@novnc/novnc').default | undefined
    let reconnectTimer: number | undefined
    let reconnectAttempts = 0

    const fail = (message?: string) => {
      if (!disposed) onStatusChange('failed', message || t('桌面环境未就绪'))
    }

    const handleDisconnect = (connection: import('@novnc/novnc').default, event: Event) => {
      if (rfb !== connection) return
      const detail = (event as CustomEvent<{ clean?: boolean }>).detail
      if (disposed || detail?.clean) return
      if (reconnectAttempts >= 60) {
        fail()
        return
      }
      reconnectAttempts += 1
      onStatusChange('connecting')
      reconnectTimer = window.setTimeout(() => void connect(), 1_000)
    }
    const handleSecurityFailure = (connection: import('@novnc/novnc').default, event: Event) => {
      if (rfb !== connection) return
      const detail = (event as CustomEvent<{ reason?: string }>).detail
      fail(detail?.reason)
    }

    async function connect() {
      try {
        const { default: RFB } = await import('@novnc/novnc')
        if (disposed || !target) return

        const previous = rfb
        rfb = undefined
        previous?.disconnect()
        target.replaceChildren()

        const connection = new RFB(target, desktopWebSocketUrl(desktopUrl), { shared: true })
        rfb = connection
        connection.background = '#000000'
        connection.scaleViewport = true
        connection.resizeSession = true
        connection.focusOnClick = true
        connection.addEventListener('connect', () => {
          if (rfb !== connection) return
          if (!disposed) {
            reconnectAttempts = 0
            onStatusChange('ready')
          }
        })
        connection.addEventListener('disconnect', (event) => handleDisconnect(connection, event))
        connection.addEventListener('securityfailure', (event) => handleSecurityFailure(connection, event))
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
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer)
      rfb?.disconnect()
    }
  }, [desktopUrl, onStatusChange, t])

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

export function DesktopWorkbench({ chatSessionId }: { chatSessionId: string }) {
  const t = useT()
  const [desktopUrl, setDesktopUrl] = useState<string | null>(null)
  const [status, setStatus] = useState<DesktopStatus>('connecting')
  const [connectionVersion, setConnectionVersion] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const handleDesktopStatus = useCallback((nextStatus: DesktopStatus, message?: string) => {
    setStatus(nextStatus)
    setError(message || null)
  }, [])

  const connect = useCallback(async (signal?: AbortSignal) => {
    setStatus('connecting')
    setDesktopUrl(null)
    setError(null)
    const deadline = Date.now() + DESKTOP_CONNECT_TIMEOUT_MS
    let retryableMessage: string | null = null
    while (Date.now() < deadline) {
      if (signal?.aborted) return
      try {
        const response = await fetch('/api/desktop/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chatSessionId }),
          cache: 'no-store',
          signal,
        })
        const payload = await response.json().catch(() => null) as DesktopSessionResponse | null
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
        if (signal?.aborted) return
        if (requestError instanceof Error && requestError.name === 'AbortError') return
        if (requestError instanceof Error && requestError.message !== t('桌面环境未就绪')) {
          setError(requestError.message)
          setStatus('failed')
          return
        }
      }
      await new Promise((resolve) => window.setTimeout(resolve, Math.min(1_000, Math.max(0, deadline - Date.now()))))
    }
    if (!signal?.aborted) {
      setError(retryableMessage || t('桌面环境未就绪'))
      setStatus('failed')
    }
  }, [chatSessionId, t])

  useEffect(() => {
    const controller = new AbortController()
    void connect(controller.signal)
    return () => controller.abort()
  }, [connect])

  return (
    <section aria-label={t('桌面')} className={`flex size-full min-h-0 flex-col ${theme('editor')}`}>
      <div className={`flex h-9 shrink-0 items-center justify-between border-b px-3 ${theme('border', 'surface')}`}>
        <div className="flex min-w-0 items-center gap-2 text-xs font-medium">
          <Monitor aria-hidden className="size-3.5 text-[var(--app-muted)]" />
          <span className="truncate">{t('桌面')}</span>
          {status === 'ready' && <span aria-hidden="true" className="size-1.5 rounded-full bg-[var(--app-success)]" />}
        </div>
        <button
          aria-label={t('刷新')}
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-[var(--app-muted)] hover:bg-[var(--app-active)] hover:text-[var(--app-foreground)] disabled:opacity-50"
          disabled={status === 'connecting'}
          onClick={() => void connect()}
          type="button"
        >
          <RotateCw className="size-3.5" />
        </button>
      </div>
      <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden bg-black">
        {desktopUrl && status !== 'failed' && (
          <DesktopCanvas
            desktopUrl={desktopUrl}
            key={connectionVersion}
            onStatusChange={handleDesktopStatus}
          />
        )}
        {status === 'connecting' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-[var(--app-background)] text-sm text-[var(--app-muted)]">
            <ThinkingOrb aria-label={t('正在启动桌面环境')} size={64} state="shaping" />
            <span>{t('正在启动桌面环境')}</span>
          </div>
        )}
        {status === 'failed' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[var(--app-background)] px-6 text-center">
            <Monitor aria-hidden className="size-7 text-[var(--app-muted)]" />
            <div>
              <p className="text-sm font-medium">{t('桌面环境未就绪')}</p>
              {error && <p className="mt-1 max-w-md text-xs leading-5 text-[var(--app-muted)]">{error}</p>}
            </div>
            <button className="flex h-8 items-center gap-1.5 rounded-md border border-[var(--app-control-border)] px-3 text-xs hover:bg-[var(--app-active)]" onClick={() => void connect()} type="button">
              <RotateCw className="size-3.5" />{t('重试')}
            </button>
          </div>
        )}
      </div>
    </section>
  )
}
