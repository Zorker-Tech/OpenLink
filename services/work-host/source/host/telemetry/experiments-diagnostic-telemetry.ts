/** Classify experiments-client diagnostics and project their bounded event metadata. */
export const EXPERIMENTS_DIAGNOSTIC_EVENT = "slate.experiments.diagnostic"

export const INFO_KINDS = new Set<string>([
  "bootstrap_resolved",
  "bootstrap_anonymous",
  "bootstrap_discarded_auth_changed",
  "exposure_flush_failed",
  "shutdown_failed",
])

export const WARN_KINDS = new Set<string>([
  "bootstrap_config_unparseable",
  "bootstrap_cache_read_failed",
])

export interface ExperimentsDiagnostic {
  readonly kind: string
  readonly stage?: string | undefined
  readonly reason?: string | undefined
  readonly errorClass?: string | undefined
  readonly gatesOnCount?: number | null | undefined
  readonly authenticated?: boolean | null | undefined
}

export function levelFor(diagnostic: ExperimentsDiagnostic): "info" | "warn" | "error" {
  if (diagnostic.kind === "config_not_applied") {
    return diagnostic.reason === "identity_unhydrated" ? "info" : "warn"
  }
  if (INFO_KINDS.has(diagnostic.kind)) return "info"
  if (WARN_KINDS.has(diagnostic.kind)) return "warn"
  return "error"
}

function optionalMetadataTag(value: number | boolean | null | undefined): string | undefined {
  return value == null ? undefined : String(value)
}

function metadataFor(diagnostic: ExperimentsDiagnostic): Record<string, string | undefined> {
  return {
    kind: diagnostic.kind,
    stage: diagnostic.stage,
    reason: diagnostic.reason,
    error_class: diagnostic.errorClass,
    gates_on_count: optionalMetadataTag(diagnostic.gatesOnCount),
    authenticated: optionalMetadataTag(diagnostic.authenticated),
  }
}

export function experimentsDiagnosticTelemetry(diagnostic: ExperimentsDiagnostic) {
  return {
    level: levelFor(diagnostic),
    event: EXPERIMENTS_DIAGNOSTIC_EVENT,
    metadata: metadataFor(diagnostic),
  }
}
