/**
 * How long to wait, as a server asked.
 *
 * The header a server sends says either how many seconds to wait or when to come back, and both are read here: a
 * moment that has already passed is no wait at all rather than a negative one, and a header that says neither is
 * nothing rather than a guess.
 */
function delayFromSeconds(value: string): number | undefined {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return undefined;
  return Math.max(0, Math.round(seconds * 1_000));
}

export function parseRetryAfterHeaderMs(
  raw: string | null | undefined,
  nowMs = Date.now(),
): number | undefined {
  if (raw == null) return undefined;

  const value = raw.trim();
  if (value.length === 0) return undefined;

  const secondsDelay = delayFromSeconds(value);
  if (secondsDelay !== undefined) return secondsDelay;

  const retryAtMs = Date.parse(value);
  if (Number.isNaN(retryAtMs)) return undefined;
  return Math.max(0, retryAtMs - nowMs);
}
