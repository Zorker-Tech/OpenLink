/** A host diagnostic, in the shape the telemetry backend reports it — a degraded send ledger is an error, the rest a warning. */
export const HOST_DIAGNOSTIC_EVENT = "slate.host.diagnostic";
export interface HostDiagnostic {
  kind: string;
  stage?: string;
  agentId?: string;
  reason?: string;
  errorClass?: string;
}
export function hostDiagnosticTelemetry(diagnostic: HostDiagnostic) {
  return {
    level: diagnostic.kind === "send_ledger_degraded" ? "error" : "warn",
    event: HOST_DIAGNOSTIC_EVENT,
    metadata: {
      kind: diagnostic.kind,
      stage: diagnostic.stage,
      agent_id: diagnostic.agentId,
      reason: diagnostic.reason,
      error_class: diagnostic.errorClass,
    },
  };
}
