import { getSlateRetryAfterMs, isSlateRateLimitError } from "../network/remote-rpc-error.ts"
import type { LogShipResult } from "./log-ship-contracts.ts"

export const LOG_SHIP_INTERVAL_MS = 15_000
export const LOG_SHIP_MAX_BATCH_ENTRIES = 128
export const LOG_SHIP_MAX_BATCH_BYTES = 256 * 1_024
export const LOG_SHIP_FAILURE_MAX_BACKOFF_MS = 60_000
export const LOG_SHIP_RATE_LIMIT_MAX_BACKOFF_MS = 5 * 60_000
export const LOG_SHIP_JITTER_RATIO = 0.25

export function nextLogShipDelayMs(input: {
  readonly outcome: "shipped" | "failed" | "rate_limited"
  readonly streak: number
  readonly retryAfterMs?: number
  readonly random?: () => number
}): number {
  const sample = input.random ?? Math.random
  const backoffWindow = (capMs: number): number =>
    Math.min(capMs, LOG_SHIP_INTERVAL_MS * 2 ** Math.max(0, input.streak))
  const lowerBound = input.outcome === "shipped"
    ? LOG_SHIP_INTERVAL_MS
    : input.outcome === "failed"
      ? backoffWindow(LOG_SHIP_FAILURE_MAX_BACKOFF_MS)
      : Math.max(input.retryAfterMs ?? 0, backoffWindow(LOG_SHIP_RATE_LIMIT_MAX_BACKOFF_MS))
  return Math.round(lowerBound + sample() * lowerBound * LOG_SHIP_JITTER_RATIO)
}

export function nextLogShipWindow(result: LogShipResult, failureStreak: number, rateLimitStreak: number, nowMs: number): {
  readonly nextShipAtMs: number
  readonly failureStreak: number
  readonly rateLimitStreak: number
} {
  if (result.delivered) {
    return {
      nextShipAtMs: nowMs + nextLogShipDelayMs({ outcome: "shipped", streak: 0 }),
      failureStreak: 0,
      rateLimitStreak: 0,
    }
  }
  if (isSlateRateLimitError(result.error)) {
    const nextRateLimitStreak = rateLimitStreak + 1
    const retryAfterMs = getSlateRetryAfterMs(result.error, nowMs)
    return {
      nextShipAtMs: nowMs + nextLogShipDelayMs({
        outcome: "rate_limited",
        streak: nextRateLimitStreak,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      }),
      failureStreak: 0,
      rateLimitStreak: nextRateLimitStreak,
    }
  }

  const nextFailureStreak = failureStreak + 1
  return {
    nextShipAtMs: nowMs + nextLogShipDelayMs({ outcome: "failed", streak: nextFailureStreak }),
    failureStreak: nextFailureStreak,
    rateLimitStreak: 0,
  }
}
