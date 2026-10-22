/**
 * How far a replayed structured log may reach back or forward.
 *
 * Batches are written to disk before they are shipped, so a restart can replay what was never sent —
 * but only within a window: an old batch is dropped rather than shipped as if it were current, and a
 * timestamp too far in the future is treated as a clock problem, not as an event that has happened.
 */

/** The oldest a replayed batch may be, in milliseconds: seventeen hours. */
export const STRUCTURED_LOG_REPLAY_MAX_AGE_MS = 17 * 60 * 60 * 1_000

/** How far a timestamp may be ahead of the clock before it is a clock problem: two hours. */
export const STRUCTURED_LOG_FUTURE_TIMESTAMP_MAX_SKEW_MS = 2 * 60 * 60 * 1_000
