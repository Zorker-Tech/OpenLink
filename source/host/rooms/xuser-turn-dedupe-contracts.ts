export const XUSER_TURN_DEDUPE_TTL_MS = 3 * 24 * 60 * 60 * 1_000

export interface XuserTurnDedupe {
  markSeenIfNew(nonce: string): boolean
}
