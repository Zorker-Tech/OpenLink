import { updateSession } from '@/utils/supabase/proxy'
import { NextResponse, type NextRequest } from 'next/server'

function isStaticAsset(pathname: string): boolean {
  return /^\/(?:_next\/(?:static|image)|favicon\.ico|.*\.(?:svg|png|jpg|jpeg|gif|webp|woff2?))$/.test(pathname)
}

function requestHostname(request: NextRequest): string {
  return (request.headers.get('host') ?? request.nextUrl.host).split(':', 1)[0]!.toLowerCase()
}

export async function proxy(request: NextRequest) {
  // Supabase Studio is hard-wired to serve from `/`. It is therefore given its
  // own origin (a second port on the same `localhost` host, tagged here) so its
  // root-relative `_next/*` assets stay isolated from the application. Do not
  // run the normal ZOKERBASE session refresh on that origin: Studio receives
  // only its short-lived, project-scoped proxy capability.
  if (request.headers.get('x-openlink-internal-studio') === '1' || requestHostname(request) === 'studio.localhost') {
    const target = request.nextUrl.clone()
    const originalPath = `${request.nextUrl.pathname}${request.nextUrl.search}`
    target.pathname = '/openlink-internal-studio'
    target.search = ''
    const headers = new Headers(request.headers)
    headers.set('x-openlink-studio-path', originalPath)
    return NextResponse.rewrite(target, { request: { headers } })
  }
  // Preserve the previous matcher behavior for the normal application while
  // allowing Studio's root-relative `_next/*` assets to reach the branch
  // above.
  if (isStaticAsset(request.nextUrl.pathname)) return NextResponse.next()
  return updateSession(request)
}

export const config = {
  matcher: ['/:path*'],
}
