import { createHash } from "node:crypto"

import { decodeSlateTokenClaims } from "./slate-token-claims.ts"

/** Produces a stable, non-reversible cache scope for an account or opaque credential. */
export function slateAccountCacheScope(accessToken: string): string {
  const accountId = decodeSlateTokenClaims(accessToken)?.sub
  return createHash("sha256").update(accountId ?? accessToken).digest("hex")
}
