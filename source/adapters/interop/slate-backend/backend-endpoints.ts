/**
 * The external service endpoints this build talks to.
 *
 * The literal hosts belong to the service that implements the wire protocols in this directory; product
 * code asks for a Slate-named URL and never spells a host itself. A deployment can point either endpoint
 * somewhere else with the Slate environment variables.
 */

const DEFAULT_WEBSITE_URL = "https://cursor.com"
const DEFAULT_API_URL = "https://api2.cursor.sh"

function withoutTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, "")
}

export function resolveSlateBackendWebsiteUrl(url?: string): string {
  return withoutTrailingSlashes(url ?? process.env.SLATE_BACKEND_WEBSITE_URL ?? DEFAULT_WEBSITE_URL)
}

export function resolveSlateBackendApiUrl(url?: string): string {
  return withoutTrailingSlashes(url ?? process.env.SLATE_BACKEND_API_URL ?? DEFAULT_API_URL)
}
