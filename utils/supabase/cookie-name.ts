/**
 * Keep Local Supabase auth cookies keyed to the hostname the browser uses.
 * The browser reaches Supabase through a same-origin proxy, while server
 * clients use the upstream URL; deriving the key from those different URLs
 * would make the browser session invisible to the server.
 */
export function localSupabaseCookieName(host: string | null | undefined, fallbackUrl: string) {
  let fallbackHostname = 'localhost'
  try {
    fallbackHostname = new URL(fallbackUrl).hostname
  } catch {
    // Use the Local hostname fallback when runtime configuration is malformed.
  }

  let hostname = fallbackHostname
  if (host) {
    try {
      hostname = new URL(`http://${host}`).hostname
    } catch {
      // Ignore an invalid Host header and use the configured Local endpoint.
    }
  }

  const projectRef = hostname.split('.')[0] || fallbackHostname.split('.')[0] || 'local'
  const safeProjectRef = /^[a-z0-9_-]+$/i.test(projectRef) ? projectRef : 'local'
  return `sb-${safeProjectRef}-auth-token`
}

/**
 * Resolve the cookie name from the host the browser actually used. Next.js can
 * expose an internal `Host` (for example `localhost:3000`) while a Server
 * Action runs even though the page was loaded from `127.0.0.1:3000`; the public
 * host is forwarded separately. Reading only `host` in that path makes the
 * action look for a cookie the browser never wrote, which signs the user out
 * mid-onboarding.
 */
export function localSupabaseCookieNameForHeaders(
  headers: Pick<Headers, 'get'>,
  fallbackUrl: string,
) {
  const forwardedHost = headers.get('x-forwarded-host')?.split(',')[0]?.trim()
  return localSupabaseCookieName(forwardedHost || headers.get('host'), fallbackUrl)
}
