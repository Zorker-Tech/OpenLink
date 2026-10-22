/**
 * The seam that lets a caller watch what the box's store sync reports.
 *
 * Nothing is reported until a reporter is pinned, so the sync can report freely and a host that does not collect
 * diagnostics pays nothing for it.
 */

/** One diagnostic the box store sync reports: a kind, and whatever else the report carries. */
type BoxStoreDiagnostic = Record<string, unknown>;

/** The function diagnostics are reported to. */
export type BoxStoreDiagnosticReporter = (diagnostic: BoxStoreDiagnostic) => void;

/** The reporter diagnostics go to, or null while none is pinned. */
let pinnedReporter: BoxStoreDiagnosticReporter | null = null;

/** Pin the reporter diagnostics go to, or pin nothing to stop reporting. */
export function pinBoxStoreDiagnosticsReporter(reporter: BoxStoreDiagnosticReporter | null): void {
  pinnedReporter = reporter;
}

/** Report one diagnostic to the pinned reporter, when there is one. */
export function reportBoxStoreDiagnostic(diagnostic: BoxStoreDiagnostic): void {
  if (pinnedReporter == null) return;
  pinnedReporter(diagnostic);
}
