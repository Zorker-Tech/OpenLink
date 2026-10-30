'use client'

import type { BrowserWorkbenchHandle, BrowserWorkbenchUiState } from '@/components/browser/browser-workbench'
import { ThinkingOrb } from '@/components/thinking/src'
import { useT } from '@/lib/i18n/client'
import { theme } from '@/lib/theme'
import { AlertCircle, RefreshCw } from 'lucide-react'
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'

interface ComputerService {
  id: string
  name: string
  port: number
  status: 'running' | 'stopped' | 'unavailable'
  httpStatus?: number
}

interface ServicesPayload {
  computerStatus?: unknown
  services?: unknown
  error?: { code?: unknown }
}

interface TunnelPayload {
  tunnel?: { url?: unknown; expiresAt?: unknown; service?: { id?: unknown } }
  error?: { code?: unknown }
}

function isComputerService(value: unknown): value is ComputerService {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const service = value as Record<string, unknown>
  const validId = service.id === 'code-server'
    || (typeof service.id === 'string' && /^web-\d{1,5}$/.test(service.id)
      && Number(service.id.slice(4)) > 0 && Number(service.id.slice(4)) <= 65_535
      && ![8443, 8444].includes(Number(service.id.slice(4))))
  return validId
    && typeof service.name === 'string'
    && Number.isSafeInteger(service.port)
    && ((service.id === 'code-server' && service.port === 8443)
      || (typeof service.id === 'string' && service.id === `web-${service.port}`))
    && service.status !== undefined
    && ['running', 'stopped', 'unavailable'].includes(String(service.status))
}

function chooseActiveWebsite(services: ComputerService[]) {
  return services
    .filter((service) => service.id.startsWith('web-') && service.status === 'running')
    .sort((left, right) => {
      const leftHealthy = left.httpStatus !== undefined && left.httpStatus >= 200 && left.httpStatus < 500 ? 0 : 1
      const rightHealthy = right.httpStatus !== undefined && right.httpStatus >= 200 && right.httpStatus < 500 ? 0 : 1
      return leftHealthy - rightHealthy || left.port - right.port
    })[0]
}

function pathFromAddress(value: string, origin: string, currentPath: string): { serviceId?: string; path: string } {
  const trimmed = value.trim()
  if (!trimmed) return { path: '/' }
  if (trimmed.startsWith('/')) return { path: trimmed }

  let url: URL
  try {
    const address = /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d{1,5}(?:\/|$)/i.test(trimmed)
      ? `http://${trimmed}`
      : trimmed
    url = new URL(address, `${origin}${currentPath}`)
  } catch {
    throw new Error('INVALID_PREVIEW_ADDRESS')
  }
  if (['localhost', '127.0.0.1', '0.0.0.0', '[::1]'].includes(url.hostname) && url.port) {
    const port = Number(url.port)
    if (port < 1 || port > 65_535 || [8443, 8444].includes(port)) throw new Error('INVALID_PREVIEW_ADDRESS')
    return { serviceId: `web-${port}`, path: `${url.pathname}${url.search}` }
  }
  if (url.origin !== origin) throw new Error('PREVIEW_EXTERNAL_NAVIGATION_UNAVAILABLE')
  return { path: `${url.pathname}${url.search}` }
}

export const CloudComputerPreviewWorkbench = forwardRef<BrowserWorkbenchHandle, {
  chatSessionId: string
  onStateChange?: (state: BrowserWorkbenchUiState) => void
}>(function CloudComputerPreviewWorkbench({ chatSessionId, onStateChange }, ref) {
  const t = useT()
  const [services, setServices] = useState<ComputerService[]>([])
  const [selectedService, setSelectedService] = useState<ComputerService | null>(null)
  const [frameUrl, setFrameUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [browserState, setBrowserState] = useState<BrowserWorkbenchUiState>({
    address: '',
    canGoBack: false,
    canGoForward: false,
    canInspect: false,
    inspectMode: false,
    status: 'connecting',
    surface: 'native-preview',
  })
  const currentPath = useRef('/')
  const tunnelOrigin = useRef<string | null>(null)
  const pendingPath = useRef('/')
  const selectedServiceRef = useRef<ComputerService | null>(null)
  const discoveryInFlight = useRef(false)

  useEffect(() => { onStateChange?.(browserState) }, [browserState, onStateChange])

  const updateService = useCallback((service: ComputerService) => {
    selectedServiceRef.current = service
    setSelectedService(service)
  }, [])

  const requestTunnel = useCallback(async (serviceId: string) => {
    const response = await fetch(`/api/chat/${encodeURIComponent(chatSessionId)}/computer-services`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serviceId }),
      cache: 'no-store',
      signal: AbortSignal.timeout(60_000),
    })
    const payload = await response.json().catch(() => ({})) as TunnelPayload
    const candidate = payload.tunnel?.url
    if (!response.ok || typeof candidate !== 'string' || !candidate) {
      const code = typeof payload.error?.code === 'string' ? payload.error.code : 'CLOUD_COMPUTER_TUNNEL_UNAVAILABLE'
      throw new Error(code)
    }
    return candidate
  }, [chatSessionId])

  const openTunnel = useCallback(async (service: ComputerService, path = '/') => {
    setError(null)
    setBrowserState((current) => ({ ...current, status: 'connecting' }))
    const nextUrl = await requestTunnel(service.id)
    const nextOrigin = new URL(nextUrl).origin
    tunnelOrigin.current = nextOrigin
    currentPath.current = path
    pendingPath.current = path
    updateService(service)
    setFrameUrl(nextUrl)
    setBrowserState((current) => ({
      ...current,
      address: `${nextOrigin}${path}`,
      externalUrl: `${nextOrigin}/`,
      status: 'connecting',
      canGoBack: false,
      canGoForward: false,
      canInspect: false,
      inspectMode: false,
      surface: 'native-preview',
    }))
  }, [requestTunnel, updateService])

  const discoverAndOpen = useCallback(async (force = false) => {
    if (discoveryInFlight.current) return
    discoveryInFlight.current = true
    try {
      setError(null)
      const response = await fetch(`/api/chat/${encodeURIComponent(chatSessionId)}/computer-services`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(60_000),
      })
      const payload = await response.json().catch(() => ({})) as ServicesPayload
      if (!response.ok) throw new Error(typeof payload.error?.code === 'string' ? payload.error.code : 'CLOUD_COMPUTER_SERVICES_UNAVAILABLE')
      const nextServices = Array.isArray(payload.services) ? payload.services.filter(isComputerService) : []
      setServices(nextServices)
      const current = selectedServiceRef.current
      const candidate = !force && current && nextServices.some((service) => service.id === current.id && service.status === 'running')
        ? nextServices.find((service) => service.id === current.id)!
        : chooseActiveWebsite(nextServices)
      if (!candidate) {
        const errorCode = payload.computerStatus === 'sleeping' ? 'CLOUD_COMPUTER_SLEEPING' : 'CLOUD_WEBSITE_NOT_RUNNING'
        selectedServiceRef.current = null
        setSelectedService(null)
        setFrameUrl(null)
        tunnelOrigin.current = null
        setBrowserState((state) => ({
          ...state,
          address: '',
          externalUrl: undefined,
          status: 'failed',
          canGoBack: false,
          canGoForward: false,
          canInspect: false,
          inspectMode: false,
        }))
        setError(errorCode)
        return
      }
      if (current && candidate.id === current.id && !force) {
        updateService(candidate)
        return
      }
      await openTunnel(candidate, force && current?.id === candidate.id ? currentPath.current : '/')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'CLOUD_COMPUTER_SERVICES_UNAVAILABLE')
      setBrowserState((current) => ({ ...current, status: 'failed' }))
    } finally {
      discoveryInFlight.current = false
    }
  }, [chatSessionId, openTunnel, updateService])

  useEffect(() => {
    let disposed = false
    let timer: number | undefined
    const schedule = (delay: number) => {
      if (disposed) return
      timer = window.setTimeout(() => {
        void discoverAndOpen().finally(() => schedule(selectedServiceRef.current ? 60_000 : 15_000))
      }, delay)
    }
    void discoverAndOpen().finally(() => schedule(selectedServiceRef.current ? 60_000 : 15_000))
    return () => {
      disposed = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [discoverAndOpen, chatSessionId])

  const reload = useCallback(() => {
    const service = selectedServiceRef.current
    if (service) void openTunnel(service, currentPath.current).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : 'CLOUD_COMPUTER_TUNNEL_UNAVAILABLE')
      setBrowserState((current) => ({ ...current, status: 'failed' }))
    })
    else void discoverAndOpen(true)
  }, [discoverAndOpen, openTunnel])

  const navigate = useCallback((address: string) => {
    const origin = tunnelOrigin.current
    if (!origin) return
    try {
      const target = pathFromAddress(address, origin, currentPath.current)
      const service = target.serviceId
        ? services.find((item) => item.id === target.serviceId && item.status === 'running')
        : selectedServiceRef.current
      if (!service) throw new Error('CLOUD_WEBSITE_NOT_RUNNING')
      if (service.id !== selectedServiceRef.current?.id) {
        void openTunnel(service, target.path).catch((reason: unknown) => {
          setError(reason instanceof Error ? reason.message : 'CLOUD_COMPUTER_TUNNEL_UNAVAILABLE')
          setBrowserState((current) => ({ ...current, status: 'failed' }))
        })
        return
      }
      currentPath.current = target.path
      setFrameUrl(`${origin}${target.path}`)
      setBrowserState((current) => ({ ...current, address: `${origin}${target.path}`, status: 'connecting' }))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'INVALID_PREVIEW_ADDRESS')
    }
  }, [openTunnel, services])

  const openExternal = useCallback(() => {
    const service = selectedServiceRef.current
    if (!service) return
    const popup = window.open('about:blank', '_blank')
    if (!popup) return
    popup.opener = null
    void requestTunnel(service.id).then((url) => popup.location.replace(url)).catch(() => popup.close())
  }, [requestTunnel])

  useImperativeHandle(ref, () => ({
    back: () => undefined,
    forward: () => undefined,
    navigate,
    openExternal,
    reload,
    setSurface: () => undefined,
    toggleInspector: () => undefined,
  }), [navigate, openExternal, reload])

  const displayedError = error === 'CLOUD_WEBSITE_NOT_RUNNING'
    ? t('未检测到正在运行的网站服务。启动项目 Web 服务后可自动预览。')
    : error === 'CLOUD_COMPUTER_SLEEPING'
      ? t('Cloud Computer 当前未运行。发送消息启动项目环境后再刷新预览。')
      : error === 'COMPUTER_SERVICE_ZONE_NOT_CONFIGURED'
        ? t('Cloud 预览隧道尚未配置。')
        : error === 'COMPUTER_SERVICE_NOT_RUNNING'
          ? t('该网站服务已停止，请刷新检测活跃端口。')
          : error
            ? t('Cloud 预览暂时无法连接，请稍后重试。')
            : null

  if (!frameUrl) {
    return (
      <main aria-label={t('Cloud 项目预览')} className={`flex size-full items-center justify-center p-6 ${theme('canvas')}`}>
        <div className="flex max-w-sm flex-col items-center text-center">
          {displayedError
            ? <span className={`mb-4 flex size-10 items-center justify-center rounded-xl ${theme('border', 'criticalSurface')}`}><AlertCircle className={`size-5 ${theme('critical')}`} /></span>
            : <ThinkingOrb aria-label={t('正在检测活跃网站端口')} className="mb-4 shrink-0" size={64} state="breathing" />}
          <h2 className="text-sm font-medium">{displayedError ? t('项目预览暂不可用') : t('正在检测项目网站服务…')}</h2>
          {displayedError && <p className={`mt-2 text-xs leading-5 ${theme('muted')}`}>{displayedError}</p>}
          <button className={`mt-4 inline-flex h-8 items-center gap-2 rounded-md px-3 text-xs transition-colors ${theme('border', 'hover')}`} onClick={() => { void discoverAndOpen(true) }} type="button"><RefreshCw className="size-3.5" />{t('重新检测')}</button>
        </div>
      </main>
    )
  }

  return (
    <main aria-label={t('Cloud 项目预览')} className={`size-full overflow-hidden ${theme('surface')}`}>
      <iframe
        allow="clipboard-read; clipboard-write; fullscreen"
        className={`block size-full border-0 ${theme('surface')}`}
        onLoad={() => {
          const path = pendingPath.current
          pendingPath.current = '/'
          if (path !== '/' && tunnelOrigin.current) {
            setFrameUrl(`${tunnelOrigin.current}${path}`)
            return
          }
          setBrowserState((current) => ({ ...current, status: 'connected' }))
        }}
        referrerPolicy="no-referrer"
        sandbox="allow-downloads allow-forms allow-modals allow-popups allow-pointer-lock allow-presentation allow-same-origin allow-scripts"
        src={frameUrl}
        title={selectedService ? t('{name} 项目预览', { name: selectedService.name }) : t('Cloud 项目预览')}
      />
    </main>
  )
})
