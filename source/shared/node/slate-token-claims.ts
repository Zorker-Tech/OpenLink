export interface SlateTokenClaims {
  readonly email?: string
  readonly exp?: number
  readonly sub?: string
  readonly [claim: string]: unknown
}

function isClaimsRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasSupportedClaimValues(record: Record<string, unknown>): boolean {
  return (record.email === undefined || typeof record.email === "string")
    && (record.exp === undefined || typeof record.exp === "number")
    && (record.sub === undefined || typeof record.sub === "string")
}

/** Decodes the payload for local account scoping; it does not establish token authenticity. */
export function decodeSlateTokenClaims(accessToken: string): SlateTokenClaims | null {
  const payloadSegment = accessToken.split(".")[1]
  if (payloadSegment == null || payloadSegment.length === 0) return null

  try {
    const value: unknown = JSON.parse(Buffer.from(payloadSegment, "base64url").toString("utf8"))
    if (!isClaimsRecord(value) || !hasSupportedClaimValues(value)) return null
    return value as SlateTokenClaims
  } catch {
    return null
  }
}
