import {
  crossAppStateCookie,
  createCrossAppState,
  getOpenLinkOrigin,
  getZorkerOriginForContinuation,
  getZorkerOrigins,
  safeInternalPath,
  stateCookieOptions,
  validateContinuation,
} from '@/lib/cross-app-auth.server'
import { NextResponse } from 'next/server'

export const runtime = 'nodejs'

export async function GET(request: Request) {
  const requestUrl = new URL(request.url)
  const next = safeInternalPath(requestUrl.searchParams.get('next'))

  try {
    const openLinkOrigin = getOpenLinkOrigin()
    const continuationValue = requestUrl.searchParams.get('continue_to')
    const zorkerOrigin = getZorkerOriginForContinuation(continuationValue)
    const continuation = validateContinuation(continuationValue, getZorkerOrigins())
    const state = createCrossAppState()
    const callback = new URL('/auth/sso/callback', openLinkOrigin)
    callback.searchParams.set('next', next)
    callback.searchParams.set('state', state)
    if (continuation) callback.searchParams.set('continue_to', continuation.toString())

    const bridge = new URL('/auth/sso/bridge', zorkerOrigin)
    bridge.searchParams.set('return_to', callback.toString())

    const response = NextResponse.redirect(bridge)
    response.cookies.set(crossAppStateCookie, state, stateCookieOptions())
    return response
  } catch {
    return NextResponse.redirect(new URL(`/login?next=${encodeURIComponent(next)}&sso=unavailable`, requestUrl.origin))
  }
}
