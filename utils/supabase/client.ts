import { createBrowserClient } from '@supabase/ssr'

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
  return createBrowserClient(
    runtimePublicConfig('openlink-supabase-url', process.env.NEXT_PUBLIC_SUPABASE_URL)!,
    runtimePublicConfig('openlink-supabase-publishable-key', process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY)!,
  )
}
