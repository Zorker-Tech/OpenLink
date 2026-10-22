/**
 * How much of a report may be sent, given the privacy mode the session is in.
 *
 * The modes are the platform's own, and the tiers are what a crash reporter is told: a session that allows its usage
 * to train models may send everything, one that allows storage but not training is scrubbed, and everything else
 * sends only what a crash needs to be identifiable at all.
 */
export enum PrivacyMode {
  UNSPECIFIED = 0,
  NO_STORAGE = 1,
  NO_TRAINING = 2,
  USAGE_DATA_TRAINING_ALLOWED = 3,
  USAGE_CODEBASE_TRAINING_ALLOWED = 4,
}

/** How much of a report a crash reporter may send. */
export type SlateSentryPrivacyTier = "full" | "scrubbed" | "fatal-metadata";

/** The tiers the modes that name one are paid, by the mode they name. */
const TIER_BY_MODE: Readonly<Partial<Record<PrivacyMode, SlateSentryPrivacyTier>>> = {
  [PrivacyMode.USAGE_DATA_TRAINING_ALLOWED]: "full",
  [PrivacyMode.USAGE_CODEBASE_TRAINING_ALLOWED]: "full",
  [PrivacyMode.NO_TRAINING]: "scrubbed",
};

/** The tier everything else is sent as: only what identifies the crash. */
const LEAST_TIER: SlateSentryPrivacyTier = "fatal-metadata";

/** The tier a session's privacy mode may be sent as. */
export function slateSentryPrivacyTierForMode(mode?: PrivacyMode): SlateSentryPrivacyTier {
  if (mode === undefined) return LEAST_TIER;
  return TIER_BY_MODE[mode] ?? LEAST_TIER;
}
