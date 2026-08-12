import {
  crossAppStateCookie,
  getOpenLinkOrigin,
  getZorkerOrigins,
  openCrossAppSession,
  safeInternalPath,
  validateContinuation,
} from '@/lib/cross-app-auth.server'
import { createClient } from '@/utils/supabase/server'
import { NextResponse } from 'next/server'

export const runtime = 'nodejs'

function clearState(response: NextResponse) {
  response.headers.set('Cache-Control', 'no-store')
  response.headers.set('Referrer-Policy', 'no-referrer')
  response.cookies.set(crossAppStateCookie, '', {
    httpOnly: true,
    maxAge: 0,
    path: '/auth/sso/callback',
    sameSite: 'lax',
  })
  return response
}

export async function GET(request: Request) {
  const requestUrl = new URL(request.url)
  const next = safeInternalPath(requestUrl.searchParams.get('next'))
  const state = requestUrl.searchParams.get('state')
  const expectedState = request.headers.get('cookie')
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${crossAppStateCookie}=`))
    ?.slice(crossAppStateCookie.length + 1)
  const fallback = new URL(`/login?next=${encodeURIComponent(next)}&sso=invalid`, requestUrl.origin)

  if (!state || !expectedState || state !== expectedState) return clearState(NextResponse.redirect(fallback))
  if (requestUrl.searchParams.get('error')) {
    return clearState(NextResponse.redirect(new URL(`/login?next=${encodeURIComponent(next)}&sso=unavailable`, requestUrl.origin)))
  }

  const session = await openCrossAppSession(requestUrl.searchParams.get('grant'))
  if (!session) return clearState(NextResponse.redirect(fallback))

  const supabase = await createClient()
  const { error } = await supabase.auth.setSession({
    access_token: session.accessToken,
    refresh_token: session.refreshToken,
  })
  if (error) return clearState(NextResponse.redirect(fallback))

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return clearState(NextResponse.redirect(fallback))

  try {
    const continuation = validateContinuation(requestUrl.searchParams.get('continue_to'), getZorkerOrigins())
    if (continuation) return clearState(NextResponse.redirect(continuation))
    return clearState(NextResponse.redirect(new URL(next, getOpenLinkOrigin())))
  } catch {
    return clearState(NextResponse.redirect(new URL(next, requestUrl.origin)))
  }
}
