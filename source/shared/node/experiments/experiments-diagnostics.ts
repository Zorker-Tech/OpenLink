/**
 * What an experiment reports before anyone is listening.
 *
 * Diagnostics are produced while the platform starts, which is before the reporter that sends them is installed, so
 * they are buffered until a reporter is pinned and handed over then; a buffer that fills before that drops what comes
 * after rather than growing without end, since a diagnostic is worth having but not worth unbounded memory.
 */
export const PRE_PIN_BUFFER_CAP = 64;
export type ExperimentDiagnostic = Readonly<Record<string, unknown> & { kind: string }>;
let pinnedReporter: ((diagnostic: ExperimentDiagnostic) => void) | null = null;
let buffered: ExperimentDiagnostic[] = [];
export function pinExperimentsDiagnosticsReporter(reporter: ((diagnostic: ExperimentDiagnostic) => void) | null): void { pinnedReporter = reporter; const backlog = buffered; buffered = []; if (reporter != null) for (const diagnostic of backlog) reporter(diagnostic); }
export function reportExperimentsDiagnostic(diagnostic: ExperimentDiagnostic): void { if (pinnedReporter != null) { pinnedReporter(diagnostic); return; } if (buffered.length < PRE_PIN_BUFFER_CAP) buffered.push(diagnostic); }
