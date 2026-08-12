import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { supabaseFetch } from '@/utils/supabase/fetch'

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request })
  const hasAuthCookie = request.cookies.getAll().some(({ name }) => name.includes('auth-token'))
  if (!hasAuthCookie) return supabaseResponse

  const local = (process.env.OPENLINK_RUNTIME_MODE ?? 'local').trim().toLowerCase() === 'local'
  const supabaseUrl = local
    ? process.env.OPENLINK_LOCAL_ZOKERBASE_URL || process.env.OPENLINK_LOCAL_SUPABASE_URL
    : process.env.OPENLINK_CLOUD_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = local
    ? process.env.OPENLINK_LOCAL_ZOKERBASE_PUBLISHABLE_KEY || process.env.OPENLINK_LOCAL_SUPABASE_PUBLISHABLE_KEY
    : process.env.OPENLINK_CLOUD_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
  if (!supabaseUrl || !supabaseKey) return supabaseResponse

  const supabase = createServerClient(supabaseUrl, supabaseKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll()
      },
      setAll(cookiesToSet, headers) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
        supabaseResponse = NextResponse.next({ request })
        cookiesToSet.forEach(({ name, value, options }) => supabaseResponse.cookies.set(name, value, options))
        Object.entries(headers).forEach(([key, value]) => supabaseResponse.headers.set(key, value))
      },
    },
    global: { fetch: supabaseFetch },
  })

  await supabase.auth.getClaims().catch(() => undefined)
  return supabaseResponse
}
