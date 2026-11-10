/**
 * What a session's store reported, in the shape the telemetry backend takes: one event per family, and the kinds that
 * are only a warning named here.
 */
export const SESSION_WARN_KINDS = new Set([
  "open_io_retry",
  "wal_unavailable",
  "quarantine_copied",
  "stat_failed",
  "path_stat_failed",
  "connector_secrets_unreadable",
  "fallback_adopt_failed",
  "placeholder_check_failed",
  "degraded",
]);
export const SESSION_EVENT_BY_FAMILY = {
  store_db: "slate.session.store_db",
  maintenance: "slate.session.maintenance",
  materialize: "slate.session.materialize",
  summary_build: "slate.session.summary_build",
} as const;
export interface SessionDiagnostic {
  readonly family: keyof typeof SESSION_EVENT_BY_FAMILY;
  readonly kind: string;
  readonly agentId?: string;
  readonly errorClass?: string;
  readonly outcome?: string;
  readonly quarantine?: string;
  readonly salvagedKv?: number | null;
  readonly salvagedBlobs?: number | null;
  readonly salvagedTranscript?: number | null;
}

function diagnosticLevel(kind: string): "warn" | "error" {
  return SESSION_WARN_KINDS.has(kind) ? "warn" : "error";
}

function commonMetadata(report: SessionDiagnostic) {
  return {
    kind: report.kind,
    agent_id: report.agentId,
    error_class: report.errorClass,
  };
}

function asCount(value: number | null | undefined): string | undefined {
  return value == null ? undefined : String(value);
}

function storeMetadata(report: SessionDiagnostic) {
  return {
    ...commonMetadata(report),
    outcome: report.outcome,
    quarantine: report.quarantine,
    salvaged_kv: asCount(report.salvagedKv),
    salvaged_blobs: asCount(report.salvagedBlobs),
    salvaged_transcript: asCount(report.salvagedTranscript),
  };
}

export function sessionDiagnosticTelemetry(report: SessionDiagnostic) {
  const metadata = report.family === "store_db" ? storeMetadata(report) : commonMetadata(report);
  return {
    level: diagnosticLevel(report.kind),
    event: SESSION_EVENT_BY_FAMILY[report.family],
    metadata,
  };
}
