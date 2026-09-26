/**
 * The seam that lets a caller watch what the box's store sync reports.
 *
 * Nothing is reported until a reporter is pinned, so the sync can report freely and a host that does not collect
 * diagnostics pays nothing for it.
 */
export type BoxStoreDiagnosticReporter = (diagnostic: Record<string, unknown>) => void;
let pinnedReporter: BoxStoreDiagnosticReporter | null = null;
export function pinBoxStoreDiagnosticsReporter(reporter: BoxStoreDiagnosticReporter | null): void { pinnedReporter = reporter; }
export function reportBoxStoreDiagnostic(diagnostic: Record<string, unknown>): void { pinnedReporter?.(diagnostic); }
