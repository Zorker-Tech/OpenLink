import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { DesktopApiError, DesktopRedirect } from './platform/api'
import type { DesktopCapabilities } from './platform/api'
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

function RouteRenderer({ routes }: { routes: DesktopRoute[] }) {
  const { pathname, search, refreshKey, replace } = useDesktopRouter()
  const match = useMemo(() => matchDesktopRoute(routes, pathname), [routes, pathname])
  const [data, setData] = useState<Record<string, unknown> | null>(null)
  const [error, setError] = useState<{ title: string; detail?: string } | null>(null)
  const [loading, setLoading] = useState(Boolean(match?.route.load))
  const requestId = useRef(0)

  const load = useCallback(
    async (route: DesktopRoute, context: DesktopRouteContext) => {
      if (!route.load) {
        setLoading(false)
        setData({})
        setError(null)
        return
      }
      const current = ++requestId.current
      setLoading(true)
      setError(null)
      try {
        const next = (await route.load(context)) ?? {}
        if (current !== requestId.current) return
        setData(next)
      } catch (cause) {
        if (current !== requestId.current) return
        if (cause instanceof DesktopRedirect) {
          replace(cause.path)
          return
        }
        if (cause instanceof DesktopApiError) {
          if ((cause.status === 401 || cause.status === 409) && cause.code === 'AUTH_REQUIRED') {
            replace(`/login?next=${encodeURIComponent(pathname + search)}`)
            return
          }
          setError({ title: 'Unable to load this page', detail: cause.message })
          return
        }
        setError({
          title: 'Unable to load this page',
          detail: cause instanceof Error ? cause.message : undefined,
        })
      } finally {
        if (current === requestId.current) setLoading(false)
      }
    },
    [pathname, replace, search],
  )

  useEffect(() => {
    if (!match) {
      setLoading(false)
      setData(null)
      setError(null)
      return
    }
    void load(match.route, {
      ...match.context,
      search: new URLSearchParams(search),
    })
  }, [load, match, pathname, search, refreshKey])

  if (!match) return <DesktopNotFound />
  if (loading) return <DesktopLoading />
  if (error) {
    return (
      <DesktopError
        detail={error.detail}
        onRetry={() =>
          void load(match.route, {
            ...match.context,
            search: new URLSearchParams(search),
          })
        }
        title={error.title}
      />
    )
  }
  return (
    <RouteContent
      context={{ ...match.context, search: new URLSearchParams(search) }}
      data={data ?? {}}
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
  return (
    <RouterProvider>
      <DesktopProviders locale={locale} messages={messages}>
        <RouteRenderer routes={routes} />
      </DesktopProviders>
    </RouterProvider>
  )
}

export { DesktopError, DesktopLoading }
