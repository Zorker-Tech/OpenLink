/**
 * How much of a report may be sent, given the privacy mode the session is in.
 *
 * The modes are the platform's own, and the tiers are what a crash reporter is told: a session that allows its usage
 * to train models may send everything, one that allows storage but not training is scrubbed, and everything else
 * sends only what a crash needs to be identifiable at all.
 */
export enum PrivacyMode { UNSPECIFIED = 0, NO_STORAGE = 1, NO_TRAINING = 2, USAGE_DATA_TRAINING_ALLOWED = 3, USAGE_CODEBASE_TRAINING_ALLOWED = 4 }
export type SlateSentryPrivacyTier = "full" | "scrubbed" | "fatal-metadata";
export function slateSentryPrivacyTierForMode(mode?: PrivacyMode): SlateSentryPrivacyTier { switch (mode) { case PrivacyMode.USAGE_DATA_TRAINING_ALLOWED: case PrivacyMode.USAGE_CODEBASE_TRAINING_ALLOWED: return "full"; case PrivacyMode.NO_TRAINING: return "scrubbed"; default: return "fatal-metadata"; } }
