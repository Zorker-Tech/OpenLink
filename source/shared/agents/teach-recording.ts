/** How long a teaching recording may run, and the state a recording that is not running is in. */
export const SLATE_TEACH_MAX_DURATION_MS = 10 * 60 * 1_000;

export const IDLE_TEACH_RECORDING_STATUS = {
  state: "idle",
  agentId: null,
  startedAtMs: null,
  maxDurationMs: SLATE_TEACH_MAX_DURATION_MS,
} as const;
