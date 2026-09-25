/**
 * Whether this account may use the platform, and why not.
 *
 * Access is checked before a session starts, so it is reported as one of the states a caller can act on — still being
 * checked, unknown, or blocked — and a block carries the reason it was blocked, which is a fixed set of reasons rather
 * than a free-form string, so a caller that handles one of them can be sure it handles them all.
 */
export const SLATE_ACCESS_CHECKING = { state: "checking", reason: "unspecified" } as const;
export const SLATE_ACCESS_UNKNOWN = { state: "unknown", reason: "unspecified" } as const;
export const SLATE_ACCESS_BLOCK_REASONS = new Set(["unspecified", "none", "teamPrivacyMode", "teamSetupRequired", "teamAccessRequired", "notOffered", "freeTrialAvailable", "paywallIndividual", "paywallTeamMember", "paywallTeamAdmin"]);
export function isSlateAccessBlockReason(value: unknown): value is string { return typeof value === "string" && SLATE_ACCESS_BLOCK_REASONS.has(value); }
