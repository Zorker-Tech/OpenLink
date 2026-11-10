/** Stream limits and the user-facing notice for a command whose output is being held back. */
const OBSERVATION_WINDOW_MS = 60_000;
const MINIMUM_STREAM_RATE = 64 * 1024;
const UNPRESSURED_STREAM_RATE = 2 * 1024 * 1024;
const MINIMUM_SUPPRESSED_OUTPUT = 256 * 1024;

const SUPPRESSION_LIMIT_ENTRIES = [
  ["windowMs", OBSERVATION_WINDOW_MS],
  ["minimumThresholdCharsPerSecond", MINIMUM_STREAM_RATE],
  ["thresholdCharsPerSecondWithoutPressure", UNPRESSURED_STREAM_RATE],
  ["minChars", MINIMUM_SUPPRESSED_OUTPUT],
] as const;

export const SHELL_OUTPUT_SUPPRESSION_DEFAULTS = Object.fromEntries(SUPPRESSION_LIMIT_ENTRIES) as {
  readonly windowMs: typeof OBSERVATION_WINDOW_MS;
  readonly minimumThresholdCharsPerSecond: typeof MINIMUM_STREAM_RATE;
  readonly thresholdCharsPerSecondWithoutPressure: typeof UNPRESSURED_STREAM_RATE;
  readonly minChars: typeof MINIMUM_SUPPRESSED_OUTPUT;
};

const SUPPRESSED_OUTPUT_NOTICE_LINE = "[Output is being limited to keep the stream readable. The command will continue running.]";
export const SHELL_OUTPUT_SUPPRESSED_NOTICE = `\n${SUPPRESSED_OUTPUT_NOTICE_LINE}\n`;
