/**
 * The numbers a duration is reported as.
 *
 * Durations travel as 32-bit integers, so a value outside that range is clamped rather than wrapped around, and a
 * value that is not a number at all is nothing rather than zero — an absent duration is not a zero-length one.
 */
const INT32_MIN = -(2 ** 31);
const INT32_MAX = 2 ** 31 - 1;
export function clampInt32(value: number): number {
  if (Number.isNaN(value)) return 0;
  if (value < INT32_MIN) return INT32_MIN;
  if (value > INT32_MAX) return INT32_MAX;
  return value;
}

export function toOptionalDurationMsInt32(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return clampInt32(Math.trunc(value));
}
