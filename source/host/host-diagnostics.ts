/** The seam that lets a caller watch what the host reports about itself. */
export type HostDiagnostic = Readonly<Record<string, unknown> & { kind: string }>;
let pinnedReporter: ((diagnostic: HostDiagnostic) => void) | null = null;
export function pinHostDiagnosticsReporter(reporter: ((diagnostic: HostDiagnostic) => void) | null): void { pinnedReporter = reporter; }
export function reportHostDiagnostic(diagnostic: HostDiagnostic): void { pinnedReporter?.(diagnostic); }
