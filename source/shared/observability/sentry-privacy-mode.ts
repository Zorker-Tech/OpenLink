/** Converts Slate privacy choices into the restricted reporting levels this observer accepts. */
import { PrivacyMode as SlatePrivacyMode, type PrivacyMode } from "../../packages/redaction/privacy-mode.ts";

/** How much of a report a crash reporter may send. */
export type SlateSentryPrivacyTier = "full" | "scrubbed" | "fatal-metadata";

/** The tiers the modes that name one are paid, by the mode they name. */
const TIER_BY_MODE: Readonly<Partial<Record<PrivacyMode, SlateSentryPrivacyTier>>> = {
  [SlatePrivacyMode.USAGE_DATA_TRAINING_ALLOWED]: "full",
  [SlatePrivacyMode.USAGE_CODEBASE_TRAINING_ALLOWED]: "full",
  [SlatePrivacyMode.NO_TRAINING]: "scrubbed",
};

/** The tier everything else is sent as: only what identifies the crash. */
const LEAST_TIER: SlateSentryPrivacyTier = "fatal-metadata";

/** The tier a session's privacy mode may be sent as. */
export function slateSentryPrivacyTierForMode(mode?: PrivacyMode): SlateSentryPrivacyTier {
  if (mode === undefined) return LEAST_TIER;
  return TIER_BY_MODE[mode] ?? LEAST_TIER;
}
