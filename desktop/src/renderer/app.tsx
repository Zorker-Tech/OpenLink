import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { DesktopConnectionPanel } from './connection-panel'
import { DesktopApiError, DesktopRedirect } from './platform/api'
import type { DesktopCapabilities } from './platform/api'
import { desktopBridge } from './platform/desktop-bridge'
import { DesktopProviders } from './providers'
import {
  matchDesktopRoute,
  RouterProvider,
  useDesktopRouter,
  type DesktopRoute,
  type DesktopRouteContext,
} from './router'
import { createDesktopRoutes } from './routes'

function DesktopLoading({ label = 'Loading…' }: { label?: string }) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background text-foreground">
      <div className="flex items-center gap-3 text-sm text-muted-foreground">
        <span className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
        {label}
      </div>
    </main>
  )
}

function DesktopError({
  title,
  detail,
  onRetry,
}: {
  title: string
  detail?: string
  onRetry?: () => void
}) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background p-8 text-foreground">
      <div className="max-w-lg text-center">
        <h1 className="text-xl font-semibold">{title}</h1>
        {detail && <p className="mt-2 break-words text-sm text-muted-foreground">{detail}</p>}
        <div className="mt-6 flex items-center justify-center gap-3">
          {onRetry && (
            <button
              className="rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-muted"
              onClick={onRetry}
              type="button"
            >
              Retry
            </button>
          )}
          <a
            className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background"
            href="/"
            onClick={(event) => {
              event.preventDefault()
              window.location.reload()
            }}
          >
            Reload
          </a>
        </div>
      </div>
    </main>
  )
}

type LoadedState =
  | { key: string; status: 'ready'; data: Record<string, unknown> }
  | { key: string; status: 'error'; error: { title: string; detail?: string } }

function RouteRenderer({ routes }: { routes: DesktopRoute[] }) {
  const { pathname, search, refreshKey, replace } = useDesktopRouter()
  const match = useMemo(() => matchDesktopRoute(routes, pathname), [routes, pathname])
  const [retryKey, setRetryKey] = useState(0)
  const [loaded, setLoaded] = useState<LoadedState | null>(null)
  const requestId = useRef(0)
  // The key includes the location so a redirect into a data-heavy route can
  // never render with the previous route's payload. This matters for the
  // `/app` -> `/app/:workspace` server redirect: reusing the app-entry data
  // would pass undefined props to the workspace shell.
  const requestKey = `${pathname}\u0000${search}\u0000${refreshKey}\u0000${retryKey}`

  const load = useCallback(
    async (route: DesktopRoute, context: DesktopRouteContext, key: string) => {
      if (!route.load) {
        setLoaded({ key, status: 'ready', data: {} })
        return
      }
      const current = ++requestId.current
      try {
        const next = (await route.load(context)) ?? {}
        if (current !== requestId.current) return
        setLoaded({ key, status: 'ready', data: next })
      } catch (cause) {
        if (current !== requestId.current) return
        if (cause instanceof DesktopRedirect) {
          replace(cause.path)
          return
        }
        if (cause instanceof DesktopApiError) {
          if ((cause.status === 401 || cause.status === 409) && cause.code === 'AUTH_REQUIRED') {
            const currentLocation = `${window.location.pathname}${window.location.search}`
            replace(`/login?next=${encodeURIComponent(currentLocation)}`)
            return
          }
          setLoaded({
            key,
            status: 'error',
            error: { title: 'Unable to load this page', detail: cause.message },
          })
          return
        }
        setLoaded({
          key,
          status: 'error',
          error: {
            title: 'Unable to load this page',
            detail: cause instanceof Error ? cause.message : undefined,
          },
        })
      }
    },
    [replace],
  )

  useEffect(() => {
    if (!match) return
    void load(
      match.route,
      { ...match.context, search: new URLSearchParams(search) },
      requestKey,
    )
  }, [load, match, requestKey, search])

  if (!match) return <DesktopNotFound />
  if (!loaded || loaded.key !== requestKey) return <DesktopLoading />
  if (loaded.status === 'error') {
    return (
      <DesktopError
        detail={loaded.error.detail}
        onRetry={() => setRetryKey((value) => value + 1)}
        title={loaded.error.title}
      />
    )
  }
  return (
    <RouteContent
      context={{ ...match.context, search: new URLSearchParams(search) }}
      data={loaded.data}
      key={pathname}
      route={match.route}
    />
  )
}

function RouteContent({
  route,
  data,
  context,
}: {
  route: DesktopRoute
  data: Record<string, unknown>
  context: DesktopRouteContext
}) {
  // Remounting on path change mirrors the web page boundary: session-scoped
  // client state (chat timeline, scroll, streams) must not leak across routes.
  return <div className="contents">{route.render(data, context)}</div>
}

function DesktopNotFound() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background p-8 text-foreground">
      <div className="max-w-md text-center">
        <h1 className="text-2xl font-semibold">404</h1>
        <p className="mt-2 text-sm text-muted-foreground">This page is not available.</p>
        <a className="mt-6 inline-flex text-sm font-medium underline" href="/">
          Home
        </a>
      </div>
    </main>
  )
}

export function DesktopApp({
  capabilities,
  locale,
  messages,
}: {
  capabilities: DesktopCapabilities
  locale: import('@/lib/i18n/locales').Locale
  messages: import('@/lib/i18n/messages').Messages
}) {
  const routes = createDesktopRoutes(capabilities)
  const bridge = useMemo(() => desktopBridge(), [])
  const [connectionsOpen, setConnectionsOpen] = useState(false)

  useEffect(() => {
    if (!bridge) return
    const off = bridge.onOpenConnections(() => setConnectionsOpen(true))
    const onCustom = () => setConnectionsOpen(true)
    window.addEventListener('openlink:connections', onCustom)
    return () => {
      off()
      window.removeEventListener('openlink:connections', onCustom)
    }
  }, [bridge])

  return (
    <RouterProvider>
      <DesktopProviders locale={locale} messages={messages}>
        <RouteRenderer routes={routes} />
        <DesktopConnectionPanel
          open={connectionsOpen}
          onClose={() => setConnectionsOpen(false)}
        />
        {bridge && !connectionsOpen && (
          <button
            className="fixed bottom-4 right-4 z-[90] inline-flex h-8 items-center gap-1.5 rounded-full border border-border bg-background/90 px-3 text-xs font-medium text-foreground shadow-lg backdrop-blur transition-colors hover:bg-muted"
            onClick={() => setConnectionsOpen(true)}
            type="button"
          >
            Connections
          </button>
        )}
      </DesktopProviders>
    </RouterProvider>
  )
}

export { DesktopError, DesktopLoading }
