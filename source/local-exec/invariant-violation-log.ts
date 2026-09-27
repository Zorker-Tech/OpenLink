/**
 * A line written when the local-exec daemon finds its own invariant broken.
 *
 * The line is one JSON object with the time, the name that was violated and where it happened, so a violation that
 * only ever happens in the field can be reconstructed from the log.
 */
export const DAEMON_INVARIANT_VIOLATION_EVENT = "slate.local_exec_daemon.invariant_violation";

export function writeInvariantViolationLog(
  report: { readonly name: string },
  write: (line: string) => void = (line) => { void process.stdout.write(line); }
): void {
  write(`${JSON.stringify({ event: DAEMON_INVARIANT_VIOLATION_EVENT, name: report.name })}\n`);
}

