/**
 * How long to wait, as a server asked.
 *
 * The header a server sends says either how many seconds to wait or when to come back, and both are read here: a
 * moment that has already passed is no wait at all rather than a negative one, and a header that says neither is
 * nothing rather than a guess.
 */
export function parseRetryAfterHeaderMs(raw: string | null | undefined, nowMs = Date.now()): number | undefined { const trimmed = raw?.trim(); if (trimmed == null || trimmed === "") return undefined; const seconds = Number(trimmed); if (Number.isFinite(seconds)) return seconds <= 0 ? 0 : Math.round(seconds * 1_000); const whenMs = Date.parse(trimmed); if (Number.isNaN(whenMs)) return undefined; const delta = whenMs - nowMs; return delta <= 0 ? 0 : delta; }
