import { createServerClient } from '@supabase/ssr'
import { cookies, headers } from 'next/headers'
import { isLocalRuntime } from '@/lib/runtime-mode.server'
import { localSupabaseCookieName } from '@/utils/supabase/cookie-name'
import { supabaseFetch } from '@/utils/supabase/fetch'

export async function createClient(): Promise<Awaited<ReturnType<typeof createServerClient>>> {
  const cookieStore = await cookies()
  if (isLocalRuntime()) {
    const endpoint = localEndpoint()
    const requestHeaders = await headers()
    return createZokerbaseClient(
      cookieStore,
      endpoint,
      localSupabaseCookieName(requestHeaders.get('host'), endpoint.url),
    )
  }
  const cloudUrl = process.env.OPENLINK_CLOUD_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL!
  const cloudKey = process.env.OPENLINK_CLOUD_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!
  const cloudClient = createServerClient(
    cloudUrl,
    cloudKey,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) => {
              cookieStore.set(name, value, options)
            })
          } catch {
            // Server Components cannot write cookies. proxy.ts refreshes them.
          }
        },
      },
      global: { fetch: supabaseFetch },
    },
  )
  return cloudClient
}

function localEndpoint() {
  const url = process.env.OPENLINK_LOCAL_ZOKERBASE_URL || process.env.OPENLINK_LOCAL_SUPABASE_URL
  const key = process.env.OPENLINK_LOCAL_ZOKERBASE_PUBLISHABLE_KEY || process.env.OPENLINK_LOCAL_SUPABASE_PUBLISHABLE_KEY
  if (!url || !key) throw new Error('Local ZOKERBASE is not configured')
  return { url, key }
}

function createZokerbaseClient(
  cookieStore: Awaited<ReturnType<typeof cookies>>,
  endpoint: ReturnType<typeof localEndpoint>,
  cookieName: string,
) {
  const { url, key } = endpoint
  return createServerClient(url, key, {
    cookieOptions: { name: cookieName },
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options))
        } catch {
          // Server Components cannot write cookies. proxy.ts refreshes them.
        }
      },
    },
    global: { fetch: supabaseFetch },
  })
}
