import { useMemo } from 'react'

import { useDesktopRouter } from '../router'

/**
 * Drop-in implementation of the `next/navigation` API surface used by the
 * shared product UI. The desktop host aliases this module at build time, so
 * components keep their imports and web stays untouched.
 */
export function useRouter() {
  const router = useDesktopRouter()
  return useMemo(
    () => ({
      push: router.push,
      replace: router.replace,
      refresh: router.refresh,
      back: router.back,
      forward: router.forward,
      prefetch: router.prefetch,
    }),
    [router],
  )
}

export function usePathname() {
  return useDesktopRouter().pathname
}

export function useSearchParams() {
  const { search } = useDesktopRouter()
  return useMemo(() => new URLSearchParams(search), [search])
}

export function useParams() {
  return useMemo(() => ({}), [])
}

export function useSelectedLayoutSegment() {
  return null
}

export function redirect(path: string): never {
  window.location.assign(path)
  throw new Error(`Redirected to ${path}`)
}

export function notFound(): never {
  throw new Error('NOT_FOUND')
}
