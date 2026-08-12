import { getOpenLinkOrigin, getZorkerOrigin, safeInternalPath } from '@/lib/cross-app-auth.server'
import { isLocalRuntime } from '@/lib/runtime-mode.server'
import { createClient } from '@/utils/supabase/server'
import type { EmailOtpType } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'

export async function GET(request: Request) {
  const url = new URL(request.url)
  const tokenHash = url.searchParams.get('token_hash')
  const type = url.searchParams.get('type') as EmailOtpType | null
  const next = safeInternalPath(url.searchParams.get('next'), '/')
  const shouldShare = url.searchParams.get('share') === '1'

  if (tokenHash && type) {
    const supabase = await createClient()
    const { error } = await supabase.auth.verifyOtp({
      token_hash: tokenHash,
      type,
    })

    if (!error) {
      if (shouldShare && !isLocalRuntime()) {
        try {
          const receiver = new URL('/auth/sso/receive', getZorkerOrigin())
          receiver.searchParams.set('continue_to', new URL(next, getOpenLinkOrigin()).toString())
          return NextResponse.redirect(receiver)
        } catch {
          // Continue locally if the peer product is unavailable.
        }
      }
      return NextResponse.redirect(new URL(next, url.origin))
    }
  }

  return NextResponse.redirect(new URL('/login?error=auth_confirm', url.origin))
}
