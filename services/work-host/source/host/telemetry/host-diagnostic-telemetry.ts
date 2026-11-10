interface DiagnosticOrigin {
  kind: string;
  stage?: string;
}

interface DiagnosticOwner {
  agentId?: string;
}

interface DiagnosticDetail {
  reason?: string;
  errorClass?: string;
}

export interface HostDiagnostic extends DiagnosticOrigin, DiagnosticOwner, DiagnosticDetail {}

export const HOST_DIAGNOSTIC_EVENT = "slate.host.diagnostic";

function severityFor(kind: string): "error" | "warn" {
  return kind === "send_ledger_degraded" ? "error" : "warn";
}

function diagnosticMetadata(report: HostDiagnostic) {
  return {
    kind: report.kind,
    stage: report.stage,
    agent_id: report.agentId,
    reason: report.reason,
    error_class: report.errorClass,
  };
}

export function hostDiagnosticTelemetry(report: HostDiagnostic) {
  return {
    level: severityFor(report.kind),
    event: HOST_DIAGNOSTIC_EVENT,
    metadata: diagnosticMetadata(report),
  };
}
