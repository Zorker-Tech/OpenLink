function parseOrigin(value: string): URL | undefined {
  try {
    const url = new URL(value)
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.origin !== value) return undefined
    return url
  } catch {
    return undefined
  }
}

function normalizedHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
}

/**
 * Match the explicitly configured scheme and host while allowing its port to
 * vary between app launches.
 */
export function isAllowedOrigin(origin: string | undefined, allowedOrigins: Iterable<string>): boolean {
  if (!origin) return false

  const configured = [...allowedOrigins]
  if (configured.includes(origin)) return true

  const candidate = parseOrigin(origin)
  if (!candidate) return false

  return configured.some((value) => {
    const allowed = parseOrigin(value)
    return Boolean(
      allowed
      && allowed.protocol === candidate.protocol
      && normalizedHostname(allowed.hostname) === normalizedHostname(candidate.hostname),
    )
  })
}

/** Include wildcard-port CSP sources for configured origins. */
export function originSourcesForCsp(origins: Iterable<string>): string[] {
  const sources = new Set<string>()
  for (const origin of origins) {
    sources.add(origin)
    const url = parseOrigin(origin)
    if (url) sources.add(`${url.protocol}//${url.hostname}:*`)
  }
  return [...sources]
}
