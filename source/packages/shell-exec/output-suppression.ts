/**
 * When a shell is producing more output than is worth streaming, and what the user is told instead.
 *
 * A command that prints faster than a person can read — a build log, a spinning progress bar — costs the
 * platform more to stream than the user gets from watching it. So output is suppressed once it exceeds a
 * rate and a total, with a higher rate allowed while the event loop is under pressure, since a busy loop is
 * exactly when streaming hurts most. The command keeps running; the user is told that its output is not
 * being shown.
 */

export const SHELL_OUTPUT_SUPPRESSION_DEFAULTS = { windowMs: 60_000, minimumThresholdCharsPerSecond: 64 * 1024, thresholdCharsPerSecondWithoutPressure: 2 * 1024 * 1024, minChars: 256 * 1024 } as const
export const SHELL_OUTPUT_SUPPRESSED_NOTICE = "\n[This shell is producing too much output to stream. The command will still run.]\n"
