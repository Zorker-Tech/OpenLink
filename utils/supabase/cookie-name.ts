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
