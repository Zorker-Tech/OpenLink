/** Shared bounds for replaying structured logs across a host restart. */
const MILLISECONDS_PER_HOUR = 60 * 60 * 1_000;
const LOG_TIMESTAMP_BOUNDS_HOURS = {
  replayAge: 17,
  futureClockSkew: 2,
} as const;

export const STRUCTURED_LOG_REPLAY_MAX_AGE_MS = LOG_TIMESTAMP_BOUNDS_HOURS.replayAge * MILLISECONDS_PER_HOUR;
export const STRUCTURED_LOG_FUTURE_TIMESTAMP_MAX_SKEW_MS = LOG_TIMESTAMP_BOUNDS_HOURS.futureClockSkew * MILLISECONDS_PER_HOUR;
