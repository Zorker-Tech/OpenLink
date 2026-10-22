/**
 * What an experiment reports before anyone is listening.
 *
 * Diagnostics are produced while the platform starts, which is before the reporter that sends them is installed, so
 * they are buffered until a reporter is pinned and handed over then; a buffer that fills before that drops what comes
 * after rather than growing without end, since a diagnostic is worth having but not worth unbounded memory.
 */

/** The most diagnostics that are kept before a reporter is pinned; later ones are dropped. */
export const PRE_PIN_BUFFER_CAP = 64;

/** One diagnostic: a kind and whatever else the report carries. */
export type ExperimentDiagnostic = Readonly<Record<string, unknown> & { kind: string }>;

/** The function diagnostics are handed to once one is pinned. */
type ExperimentDiagnosticReporter = (diagnostic: ExperimentDiagnostic) => void;

/** The reporter diagnostics are handed to, or null while none is pinned. */
let pinnedSink: ExperimentDiagnosticReporter | null = null;

/** The diagnostics produced before a reporter was pinned, oldest first. */
let pending: ExperimentDiagnostic[] = [];

/** Pin the reporter diagnostics go to, and hand it whatever was produced before it arrived. */
export function pinExperimentsDiagnosticsReporter(reporter: ExperimentDiagnosticReporter | null): void {
  pinnedSink = reporter;
  const backlog = pending;
  pending = [];
  if (reporter == null) return;
  for (const diagnostic of backlog) reporter(diagnostic);
}

/** Report one diagnostic: to the reporter when there is one, otherwise into the bounded buffer. */
export function reportExperimentsDiagnostic(diagnostic: ExperimentDiagnostic): void {
  if (pinnedSink == null) {
    if (pending.length < PRE_PIN_BUFFER_CAP) pending.push(diagnostic);
    return;
  }
  pinnedSink(diagnostic);
}
