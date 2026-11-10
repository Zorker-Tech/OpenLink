/**
 * Checking the numbers a sync client is configured with.
 *
 * A value that is not finite or not positive is refused with what it was for, so a configuration mistake is reported
 * where it is made rather than as a strange failure later.
 */

/** A configured number and the words a refusal names it by. */
interface NumberSetting { value: number; name: string; context: string }

/** Whether a configured number is one this platform can use: finite, and above zero. */
function isFinitePositive(candidate: number): boolean {
  return Number.isFinite(candidate) && candidate > 0;
}

export function ensureFinitePositive({ value, name, context }: NumberSetting): number {
  if (!isFinitePositive(value)) throw new RangeError(`${context} ${name} must be a finite positive number, got ${value}`);
  return value;
}