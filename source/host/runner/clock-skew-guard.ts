/**
 * Durations measured across two clocks.
 *
 * A duration computed from two machines' clocks can be negative or implausibly large when the clocks disagree, so it is
 * either accepted — rounded, within a ceiling — or reported as the skew it looks like, and a skew is bucketed for
 * reporting rather than carried as a raw number.
 */

/** The largest plausible send-dispatch duration, and the largest plausible time to first token. */
export const SEND_DISPATCH_MAX_PLAUSIBLE_MS = 120_000;
export const TTFT_MAX_PLAUSIBLE_MS = 1_800_000;

/** One bucket of a skew: the magnitude up to which it applies, and the name it is reported under. */
type SkewBucket = readonly [largestMs: number, bucket: string];

/** The buckets a positive skew falls into, smallest first, and the name beyond the last of them. */
const POSITIVE_SKEW_BUCKETS: readonly SkewBucket[] = [[60_000, "le_1m"], [300_000, "le_5m"], [900_000, "le_15m"]];
const BEYOND_POSITIVE_BUCKETS = "gt_15m";

/** The buckets a negative skew falls into, by its magnitude, and the name beyond the last of them. */
const NEGATIVE_SKEW_BUCKETS: readonly SkewBucket[] = [[1_000, "neg_le_1s"], [60_000, "neg_le_1m"]];
const BEYOND_NEGATIVE_BUCKETS = "neg_gt_1m";

/** The bucket a magnitude falls into: the first whose limit it does not exceed, or the one beyond them all. */
function bucketOf(magnitudeMs: number, buckets: readonly SkewBucket[], beyond: string): string {
  for (const [largestMs, bucket] of buckets) {
    if (magnitudeMs <= largestMs) return bucket;
  }
  return beyond;
}

/** A duration measured across two clocks, rounded when it is plausible, or the skew it looks like. */
export function sanitizeCrossClockDurationMs(
  rawDeltaMs: number,
  ceilingMs: number,
): { ms: number } | { skewReason: "negative" | "too_large" } {
  if (!Number.isFinite(rawDeltaMs)) return { skewReason: "too_large" };
  if (rawDeltaMs < 0) return { skewReason: "negative" };
  if (rawDeltaMs > ceilingMs) return { skewReason: "too_large" };
  return { ms: Math.round(rawDeltaMs) };
}

/** The bucket a clock skew is reported under. */
export function bucketClockSkewDeltaMs(raw: number): string {
  if (!Number.isFinite(raw)) return "nonfinite";
  if (raw < 0) return bucketOf(-raw, NEGATIVE_SKEW_BUCKETS, BEYOND_NEGATIVE_BUCKETS);
  return bucketOf(raw, POSITIVE_SKEW_BUCKETS, BEYOND_POSITIVE_BUCKETS);
}
