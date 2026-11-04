/** Record the local executor's invariant failures in the host log format. */
export const LOCAL_EXEC_DAEMON_INVARIANT_EVENT_NAME = "slate.local_exec_daemon.invariant_violation";

export interface LocalExecInvariantReport {
  readonly name: string;
}

export function writeLocalExecInvariantRecord(
  report: LocalExecInvariantReport,
  emitLine: (line: string) => void = (line) => { void process.stdout.write(line); },
): void {
  const record = { event: LOCAL_EXEC_DAEMON_INVARIANT_EVENT_NAME, name: report.name };
  emitLine(JSON.stringify(record) + "\n");
}
