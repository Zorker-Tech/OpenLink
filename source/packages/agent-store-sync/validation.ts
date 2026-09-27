/**
 * Checking the numbers a sync client is configured with.
 *
 * A value that is not finite or not positive is refused with what it was for, so a configuration mistake is reported
 * where it is made rather than as a strange failure later.
 */
export function ensureFinitePositive({ value, name, context }: { value: number; name: string; context: string }): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${context} ${name} must be a finite positive number, got ${value}`);
  return value;
}
