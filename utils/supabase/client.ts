import { createBrowserClient } from '@supabase/ssr'

function runtimePublicConfig(name: string, fallback: string | undefined) {
  if (typeof document !== 'undefined') {
    const value = document.querySelector(`meta[name="${name}"]`)?.getAttribute('content')
    if (value) return value
  }
  return fallback
}

export function createClient() {
  return createBrowserClient(
    runtimePublicConfig('openlink-supabase-url', process.env.NEXT_PUBLIC_SUPABASE_URL)!,
    runtimePublicConfig('openlink-supabase-publishable-key', process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY)!,
  )
}
