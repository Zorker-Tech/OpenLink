/**
 * Where a session's diagnostics go.
 *
 * The reporter is pinned once by whoever owns it, and a session that reports before that has happened simply reports
 * into nothing rather than being kept.
 */

/** What one diagnostic says: the family it belongs to, the kind of thing it is, and whatever else it carries. */
export type SessionDiagnostic = Readonly<Record<string, unknown>> & {
  readonly family: string;
  readonly kind: string;
};

/** The one function a session's diagnostics are handed to. */
export type SessionDiagnosticsReporter = (diagnostic: SessionDiagnostic) => void;

/** The reporter pinned for the whole host, or nothing while none is pinned. */
let pinnedSink: SessionDiagnosticsReporter | null = null;

/** Pin the reporter diagnostics are handed to; pinning nothing turns reporting off again. */
export function pinSessionDiagnosticsReporter(reporter: SessionDiagnosticsReporter | null): void {
  pinnedSink = reporter;
}

/** Hand one diagnostic to the pinned reporter, and drop it when none is pinned. */
export function reportSessionDiagnostic(diagnostic: SessionDiagnostic): void {
  pinnedSink?.(diagnostic);
}
