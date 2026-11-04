/**
 * How long a command is allowed to run.
 *
 * A caller's own timeout is used as it is. A timeout of zero means "no timeout", which is only allowed for a command
 * that runs in the background or that was given a hard timeout of its own; a foreground command with no timeout is
 * given the default one instead of running forever.
 */
export const DEFAULT_SHELL_FOREGROUND_TIMEOUT_MS = 30_000;
export function resolveShellTimeoutMs(args: { timeout: number; isBackground: boolean; timeoutBehavior?: "background" | "foreground"; hardTimeout?: number }): number {
  if (args.timeout !== 0) return args.timeout;
  if (args.isBackground || args.timeoutBehavior === "background" || (args.hardTimeout !== undefined && args.hardTimeout > 0)) return 0;
  return DEFAULT_SHELL_FOREGROUND_TIMEOUT_MS;
}
