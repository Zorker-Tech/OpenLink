import { createBrowserClient } from '@supabase/ssr'
import { localSupabaseCookieName } from '@/utils/supabase/cookie-name'

function localSupabaseFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  // Supabase SSR stores the session in document cookies. The API proxy does
  // not need the browser's application cookies, and forwarding them can exceed
  // Kong's request-header limit as the browser accumulates auth cookies.
  return fetch(input, { ...init, credentials: 'omit' })
}

export function runtimePublicConfig(name: string, fallback: string | undefined) {
  if (typeof document !== 'undefined') {
    const element = document.querySelector(`meta[name="${name}"]`)
    if (element) {
      const value = element.getAttribute('content')?.trim()
      if (!value) {
        throw new Error(`OpenLink runtime configuration is missing ${name}`)
      }
      return value
    }
  }
  const value = fallback?.trim()
  if (!value) throw new Error(`OpenLink build configuration is missing ${name}`)
  return value
}

export function createClient() {
  const configuredUrl = runtimePublicConfig('openlink-supabase-url', process.env.NEXT_PUBLIC_SUPABASE_URL)!
  const runtimeMode = typeof document === 'undefined'
    ? process.env.NEXT_PUBLIC_OPENLINK_RUNTIME_MODE || 'cloud'
    : runtimePublicConfig('openlink-runtime-mode', process.env.NEXT_PUBLIC_OPENLINK_RUNTIME_MODE || 'cloud')
  const browserUrl = runtimeMode === 'local' && typeof window !== 'undefined'
    ? new URL('/api/openlink-zokerbase/', window.location.origin).toString()
    : configuredUrl

  const local = runtimeMode === 'local'

  return createBrowserClient(
    browserUrl,
    runtimePublicConfig('openlink-supabase-publishable-key', process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY)!,
    local
      ? {
          cookieOptions: {
            name: localSupabaseCookieName(
              typeof window === 'undefined' ? undefined : window.location.host,
              configuredUrl,
            ),
          },
          global: { fetch: localSupabaseFetch },
        }
      : undefined,
  )
}
