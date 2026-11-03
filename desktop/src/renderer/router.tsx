import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

import { setDesktopNavigator } from './platform/navigation-runtime'

interface RouterLocation {
  pathname: string
  search: string
}

export interface DesktopRouter extends RouterLocation {
  refreshKey: number
  push: (href: string) => void
  replace: (href: string) => void
  refresh: () => void
  back: () => void
  forward: () => void
  prefetch: (href: string) => void
}

const RouterContext = createContext<DesktopRouter | null>(null)

function currentLocation(): RouterLocation {
  if (typeof window === 'undefined') return { pathname: '/', search: '' }
  return {
    pathname: window.location.pathname || '/',
    search: window.location.search || '',
  }
}

function isExternal(href: string) {
  try {
    return new URL(href, window.location.href).origin !== window.location.origin
  } catch {
    return false
  }
}

function isHashOnly(href: string) {
  return href.startsWith('#')
}

export function RouterProvider({ children }: { children: ReactNode }) {
  const [location, setLocation] = useState<RouterLocation>(currentLocation)
  const [refreshKey, setRefreshKey] = useState(0)

  const commit = useCallback((href: string, mode: 'push' | 'replace') => {
    if (!href || isHashOnly(href)) return
    if (isExternal(href)) {
      window.location.assign(href)
      return
    }
    const url = new URL(href, window.location.href)
    const next = { pathname: url.pathname || '/', search: url.search }
    const historyMethod = mode === 'replace' ? 'replaceState' : 'pushState'
    window.history[historyMethod](window.history.state, '', `${next.pathname}${next.search}${url.hash}`)
    setLocation((previous) =>
      previous.pathname === next.pathname && previous.search === next.search
        ? previous
        : next,
    )
    if (!url.hash) window.scrollTo(0, 0)
  }, [])

  const push = useCallback((href: string) => commit(href, 'push'), [commit])
  const replace = useCallback((href: string) => commit(href, 'replace'), [commit])
  const refresh = useCallback(() => setRefreshKey((value) => value + 1), [])
  const back = useCallback(() => window.history.back(), [])
  const forward = useCallback(() => window.history.forward(), [])
  const prefetch = useCallback(() => undefined, [])

  useEffect(() => {
    const onPopState = () => setLocation(currentLocation())
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  useEffect(() => {
    setDesktopNavigator(push)
    return () => setDesktopNavigator(null)
  }, [push])

  const value = useMemo<DesktopRouter>(
    () => ({
      ...location,
      refreshKey,
      push,
      replace,
      refresh,
      back,
      forward,
      prefetch,
    }),
    [location, refreshKey, push, replace, refresh, back, forward, prefetch],
  )

  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>
}

export function useDesktopRouter(): DesktopRouter {
  const router = useContext(RouterContext)
  if (!router) throw new Error('Desktop router is not mounted')
  return router
}

export interface DesktopRouteContext {
  params: Record<string, string>
  search: URLSearchParams
  pathname: string
}

export interface DesktopRoute {
  pattern: string
  load?: (context: DesktopRouteContext) => Promise<Record<string, unknown> | void>
  render: (data: Record<string, unknown>, context: DesktopRouteContext) => ReactNode
}

function matchPattern(pattern: string, pathname: string): Record<string, string> | null {
  const patternSegments = pattern.split('/').filter(Boolean)
  const pathSegments = pathname.split('/').filter(Boolean)
  const params: Record<string, string> = {}

  let index = 0
  for (; index < patternSegments.length; index += 1) {
    const segment = patternSegments[index]
    if (segment === '*') {
      params['*'] = pathSegments.slice(index).join('/')
      return params
    }
    const value = pathSegments[index]
    if (!value) return null
    if (segment.startsWith(':')) {
      params[segment.slice(1)] = decodeURIComponent(value)
    } else if (segment !== value) {
      return null
    }
  }
  return pathSegments.length === index ? params : null
}

export function matchDesktopRoute(
  routes: DesktopRoute[],
  pathname: string,
): { route: DesktopRoute; context: DesktopRouteContext } | null {
  for (const route of routes) {
    const params = matchPattern(route.pattern, pathname)
    if (params) {
      return {
        route,
        context: {
          params,
          pathname,
          search: new URLSearchParams(window.location.search),
        },
      }
    }
  }
  return null
}
