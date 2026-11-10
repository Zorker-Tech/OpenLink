import { isDeepStrictEqual } from "node:util"

/** Compares transcript fields that recovery reconstructs, ignoring unrelated persisted metadata. */
export function sameRecoveredTranscriptEntry(
  stored: Record<string, unknown>,
  rebuilt: Record<string, unknown>,
): boolean {
  if (stored.kind !== rebuilt.kind) return false

  switch (stored.kind) {
    case "message":
      return stored.role === rebuilt.role && stored.content === rebuilt.content
    case "send-message":
      return isDeepStrictEqual(stored.message, rebuilt.message)
    case "tool-call":
      return stored.name === rebuilt.name
        && stored.status === rebuilt.status
        && stored.summary === rebuilt.summary
    default:
      return false
  }
}
