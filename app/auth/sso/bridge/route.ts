import { getZorkerOrigins, sealCrossAppSession, validatePeerCallback } from '@/lib/cross-app-auth.server'
import { createClient } from '@/utils/supabase/server'
import { NextResponse } from 'next/server'

export const runtime = 'nodejs'

function privateRedirect(url: URL) {
  const response = NextResponse.redirect(url)
  response.headers.set('Cache-Control', 'no-store')
  response.headers.set('Referrer-Policy', 'no-referrer')
  return response
}

export async function GET(request: Request) {
  const requestUrl = new URL(request.url)
  let returnTo: URL

  try {
    const candidate = validatePeerCallback(requestUrl.searchParams.get('return_to'), getZorkerOrigins())
    if (!candidate) return NextResponse.json({ error: 'Invalid cross-product callback.' }, { status: 400 })
    returnTo = candidate
  } catch {
    return NextResponse.json({ error: 'Cross-product sign-in is unavailable.' }, { status: 503 })
  }

  const supabase = await createClient()
  const { data: claimsData } = await supabase.auth.getClaims()
  const { data: sessionData } = await supabase.auth.getSession()

  if (!claimsData?.claims || !sessionData.session) {
    returnTo.searchParams.set('error', 'source_missing')
    return privateRedirect(returnTo)
  }

  try {
    returnTo.searchParams.set('grant', await sealCrossAppSession(sessionData.session))
    return privateRedirect(returnTo)
  } catch {
    returnTo.searchParams.set('error', 'grant_unavailable')
    return privateRedirect(returnTo)
  }
}
