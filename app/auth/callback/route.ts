import { getOpenLinkOrigin, getZorkerOrigin, safeInternalPath } from '@/lib/cross-app-auth.server'
import { isLocalRuntime } from '@/lib/runtime-mode.server'
import { createClient } from '@/utils/supabase/server'
import { NextResponse } from 'next/server'

export async function GET(request: Request) {
  const url = new URL(request.url)
  const code = url.searchParams.get('code')
  const next = safeInternalPath(url.searchParams.get('next'), '/')
  const shouldShare = url.searchParams.get('share') === '1'

  if (code) {
    const supabase = await createClient()
    const { error } = await supabase.auth.exchangeCodeForSession(code)

    if (!error) {
      if (shouldShare && !isLocalRuntime()) {
        try {
          const receiver = new URL('/auth/sso/receive', getZorkerOrigin())
          receiver.searchParams.set('continue_to', new URL(next, getOpenLinkOrigin()).toString())
          return NextResponse.redirect(receiver)
        } catch {
          // A missing peer configuration must not prevent a local login.
        }
      }
      return NextResponse.redirect(new URL(next, url.origin))
    }
  }

  return NextResponse.redirect(new URL('/login?error=auth_callback', url.origin))
}
