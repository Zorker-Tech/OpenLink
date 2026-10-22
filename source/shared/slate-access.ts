/**
 * Whether this account may use the platform, and why not.
 *
 * Access is checked before a session starts, so it is reported as one of the states a caller can act on — still being
 * checked, unknown, or blocked — and a block carries the reason it was blocked, which is a fixed set of reasons rather
 * than a free-form string, so a caller that handles one of them can be sure it handles them all.
 */

/** The reason the state carries while there is no block to name. */
const UNSPECIFIED_REASON = "unspecified" as const;

export const SLATE_ACCESS_CHECKING = { state: "checking", reason: UNSPECIFIED_REASON } as const;
export const SLATE_ACCESS_UNKNOWN = { state: "unknown", reason: UNSPECIFIED_REASON } as const;

/** The reasons a block can carry, in the order reports read them. */
const SLATE_ACCESS_BLOCK_REASON_NAMES = ["unspecified", "none", "teamPrivacyMode", "teamSetupRequired", "teamAccessRequired", "notOffered", "freeTrialAvailable", "paywallIndividual", "paywallTeamMember", "paywallTeamAdmin"] as const;

export const SLATE_ACCESS_BLOCK_REASONS = new Set<string>(SLATE_ACCESS_BLOCK_REASON_NAMES);

/** Whether a block reason is one of the fixed ones. */
function isKnownBlockReason(candidate: string): boolean {
  return SLATE_ACCESS_BLOCK_REASONS.has(candidate);
}

export function isSlateAccessBlockReason(candidate: unknown): candidate is string {
  return typeof candidate === "string" && isKnownBlockReason(candidate);
}