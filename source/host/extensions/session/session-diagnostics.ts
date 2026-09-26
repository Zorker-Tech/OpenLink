/**
 * Where a session's diagnostics go.
 *
 * The reporter is pinned once by whoever owns it, and a session that reports before that has happened simply reports
 * into nothing rather than being kept.
 */
export type SessionDiagnostic = Readonly<Record<string, unknown>> & {
  readonly family: string;
  readonly kind: string;
};

export type SessionDiagnosticsReporter = (report: SessionDiagnostic) => void;

let pinnedReporter: SessionDiagnosticsReporter | null = null;

export function pinSessionDiagnosticsReporter(reporter: SessionDiagnosticsReporter | null): void {
  pinnedReporter = reporter;
}

export function reportSessionDiagnostic(report: SessionDiagnostic): void {
  pinnedReporter?.(report);
}
