/** How long a teaching recording may run, and the state a recording that is not running is in. */

/** Ten minutes, as the duration a teaching recording may run for. */
const TEN_MINUTES_MS = 10 * 60 * 1_000;

export const SLATE_TEACH_MAX_DURATION_MS = TEN_MINUTES_MS;

/** A recording that is not running: no agent, no start, and the limit it would run under. */
const NOT_RECORDING = {
  state: "idle",
  agentId: null,
  startedAtMs: null,
} as const;

export const IDLE_TEACH_RECORDING_STATUS = {
  ...NOT_RECORDING,
  maxDurationMs: TEN_MINUTES_MS,
} as const;
