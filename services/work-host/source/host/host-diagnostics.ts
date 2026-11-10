/** The seam that lets a caller watch what the host reports about itself. */
export type HostDiagnostic = Readonly<Record<string, unknown> & { kind: string }>;

/** A function that reports one diagnostic; it is what a caller pins here. */
type HostDiagnosticReporter = (diagnostic: HostDiagnostic) => void;

/** The reporter a caller pinned, or nothing when nobody is watching. */
let reporterPinnedByCaller: HostDiagnosticReporter | null = null;

/** Pins the reporter host diagnostics go to, or unpins it with null. */
export function pinHostDiagnosticsReporter(reporter: HostDiagnosticReporter | null): void {
  reporterPinnedByCaller = reporter;
}

/** Reports a diagnostic to the pinned reporter, when one is pinned. */
export function reportHostDiagnostic(diagnostic: HostDiagnostic): void {
  reporterPinnedByCaller?.(diagnostic);
}
