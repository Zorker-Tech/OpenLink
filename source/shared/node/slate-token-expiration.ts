import { decodeSlateTokenClaims } from "./slate-token-claims.ts"

export const ACCESS_TOKEN_REFRESH_LEEWAY_MS = 5 * 60 * 1_000

export function slateAccessTokenExpiresAtMs(accessToken: string): number | null {
  const expirySeconds = decodeSlateTokenClaims(accessToken)?.exp
  return expirySeconds == null || !Number.isFinite(expirySeconds) ? null : expirySeconds * 1_000
}

export function isSlateAccessTokenNearExpiry(accessToken: string, nowMs = Date.now()): boolean {
  const claims = decodeSlateTokenClaims(accessToken)
  return claims?.exp == null || claims.exp * 1_000 - nowMs < ACCESS_TOKEN_REFRESH_LEEWAY_MS
}
