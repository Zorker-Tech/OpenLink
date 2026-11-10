import { EXTERNAL_NOTE_APP_SCHEME } from "../adapters/interop/note-app/external-link-scheme-adapter.ts"

const browserSchemes = new Set(["http:", "https:"])
const addressSchemes = new Set(["mailto:", "tel:"])

export const OPENABLE_PROTOCOLS: ReadonlySet<string> = new Set([
  ...browserSchemes,
  ...addressSchemes,
  EXTERNAL_NOTE_APP_SCHEME,
])

function parseExternalUrl(candidate: unknown): URL | null {
  if (typeof candidate !== "string" || candidate.length === 0) return null
  try {
    return new URL(candidate)
  } catch {
    return null
  }
}

export function openableExternalUrl(value: unknown): string | null {
  const parsed = parseExternalUrl(value)
  return parsed !== null && OPENABLE_PROTOCOLS.has(parsed.protocol) ? parsed.href : null
}

export function isWebUrl(value: unknown): boolean {
  const parsed = parseExternalUrl(value)
  return parsed !== null && browserSchemes.has(parsed.protocol)
}
