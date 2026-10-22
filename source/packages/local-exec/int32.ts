/**
 * The numbers a duration is reported as.
 *
 * Durations travel as 32-bit integers, so a value outside that range is clamped rather than wrapped around, and a
 * value that is not a number at all is nothing rather than zero — an absent duration is not a zero-length one.
 */

/** The range a 32-bit signed integer covers. */
const INT32_LOWEST = -(2 ** 31);
const INT32_HIGHEST = 2 ** 31 - 1;

/** A number pulled into that range; a number that is not one at all reads as zero rather than as a duration. */
export function clampInt32(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(INT32_HIGHEST, Math.max(INT32_LOWEST, value));
}

/** Whether a value can be a duration: a finite number of milliseconds, and not a negative one. */
function isDurationMs(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function toOptionalDurationMsInt32(value: unknown): number | undefined {
  if (!isDurationMs(value)) return undefined;
  return clampInt32(Math.trunc(value));
}
