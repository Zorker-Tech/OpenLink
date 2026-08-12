const DEFAULT_SUPABASE_TIMEOUT_MS = 5_000

function timeoutMs(): number {
  const configured = Number(process.env.OPENLINK_SUPABASE_REQUEST_TIMEOUT_MS)
  return Number.isSafeInteger(configured) && configured >= 1_000 && configured <= 60_000
    ? configured
    : DEFAULT_SUPABASE_TIMEOUT_MS
}

/** Keep auth/database calls from pinning a Next request forever on an outage. */
export function supabaseFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const timeout = AbortSignal.timeout(timeoutMs())
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout
  const startedAt = Date.now()
  return fetch(input, { ...init, signal }).catch((error: unknown) => {
    if (timeout.aborted) {
      // A generic AbortError is converted by Next into an opaque digest, which
      // makes a failed chat-session navigation impossible to diagnose. Log
      // only the request method and URL path: Supabase query strings can carry
      // user identifiers and must not enter application logs.
      const source = input instanceof Request ? input.url : input.toString()
      let target = 'unknown Supabase endpoint'
      try {
        const url = new URL(source)
        target = `${init.method ?? (input instanceof Request ? input.method : 'GET')} ${url.pathname}`
      } catch {
        // Keep the original abort error when a custom RequestInfo is malformed.
      }
      console.error(`OpenLink Supabase request timed out after ${Date.now() - startedAt}ms: ${target}`)
    }
    throw error
  })
}
