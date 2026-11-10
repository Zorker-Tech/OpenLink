/** Classifies a WebAuthn origin against Slate's gateway host. */

export const SLATE_ORIGIN_DOMAIN = "slate.invalid"

export type SlateWebAuthnOriginClass = "apex" | "subdomain" | "external"

function hostnameFromOrigin(origin: string): string | undefined {
  try {
    return new URL(origin).hostname
  } catch {
    return undefined
  }
}

export function slateWebAuthnOriginClass(origin: string): SlateWebAuthnOriginClass {
  const hostname = hostnameFromOrigin(origin)
  if (hostname === undefined) return "external"
  if (hostname === SLATE_ORIGIN_DOMAIN) return "apex"
  return hostname.endsWith(`.${SLATE_ORIGIN_DOMAIN}`) ? "subdomain" : "external"
}
