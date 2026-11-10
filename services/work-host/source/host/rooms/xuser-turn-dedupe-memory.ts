import type { XuserTurnDedupe } from "./xuser-turn-dedupe-contracts.ts"
import { XUSER_TURN_DEDUPE_TTL_MS } from "./xuser-turn-dedupe-contracts.ts"

export function createInMemoryXuserTurnDedupe(
  ttlMs = XUSER_TURN_DEDUPE_TTL_MS,
  nowMs: () => number = Date.now,
): XuserTurnDedupe {
  const expiresAt = new Map<string, number>()
  return {
    markSeenIfNew(nonce: string): boolean {
      if (nonce.length === 0) return false
      const now = nowMs()
      for (const [seenNonce, deadline] of expiresAt) {
        if (deadline <= now) expiresAt.delete(seenNonce)
      }
      if (expiresAt.has(nonce)) return false
      expiresAt.set(nonce, now + ttlMs)
      return true
    },
  }
}
