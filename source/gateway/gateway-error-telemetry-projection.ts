import type { GatewayCommandFailureReport, GatewayCommandSuccessReport } from "./gateway-error-contracts.ts"

export function projectGatewayCommandFailure(report: GatewayCommandFailureReport) {
  return {
    level: "error",
    metadata: {
      method: report.method,
      reason: report.reason,
      error_class: report.errorClass,
      errno: report.errno,
      duration_ms: String(Math.round(report.durationMs)),
      request_id: report.requestId,
      trace_id: report.traceId,
      span_id: report.spanId,
    },
  }
}

export function projectGatewayCommandSuccess(report: GatewayCommandSuccessReport) {
  return {
    level: "info",
    metadata: {
      method: report.method,
      duration_ms: String(Math.round(report.durationMs)),
      request_id: report.requestId,
      trace_id: report.traceId,
      span_id: report.spanId,
    },
  }
}
