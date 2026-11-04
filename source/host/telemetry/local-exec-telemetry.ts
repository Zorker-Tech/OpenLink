import type {
  LocalExecFailureReport,
  LocalExecProviderReport,
  LocalExecRefusalCause,
  LocalExecRefusalReport,
} from "./local-exec-telemetry-contracts.ts"
import { describeLocalExecRefusal } from "./local-exec-refusal-policy.ts"

export const SLATE_LOCAL_EXEC_REFUSAL_EVENT = "slate.local_exec.refused"
export const SLATE_LOCAL_EXEC_FAILURE_EVENT = "slate.local_exec.exec_failed"
export const SLATE_LOCAL_EXEC_PROVIDER_EVENT = "slate.local_exec.provider"

export const LOCAL_EXEC_REFUSED_EVENT = SLATE_LOCAL_EXEC_REFUSAL_EVENT
export const LOCAL_EXEC_FAILED_EVENT = SLATE_LOCAL_EXEC_FAILURE_EVENT
export const LOCAL_EXEC_PROVIDER_EVENT = SLATE_LOCAL_EXEC_PROVIDER_EVENT

export function projectLocalExecRefusal(report: LocalExecRefusalReport) {
  const error = describeLocalExecRefusal(report.cause)
  const metadata = {
    cause: report.cause,
    site: report.site,
    conversation_id: report.conversationId,
    provider_count: String(report.providerCount),
    live_provider_count: String(report.liveProviderCount),
    ever_registered: String(report.everRegistered),
    empty_for_ms: report.emptyForMs === undefined ? undefined : String(Math.round(report.emptyForMs)),
    error_code: error.code,
    error_domain: error.domain,
    error_retryable: String(error.retryable),
  }
  return { level: "warn", event: SLATE_LOCAL_EXEC_REFUSAL_EVENT, metadata }
}

export function projectLocalExecFailure(report: LocalExecFailureReport) {
  return {
    level: "warn",
    event: SLATE_LOCAL_EXEC_FAILURE_EVENT,
    metadata: {
      error_class: report.errorClass,
      errno: report.errno,
      site: report.site,
      surface: "external",
      conversation_id: report.conversationId,
    },
  }
}

export function projectLocalExecProvider(report: LocalExecProviderReport) {
  const shared = {
    phase: report.phase,
    provider_id: report.providerId,
    provider_count: String(report.providerCount),
  }
  const details = report.phase === "hello"
    ? {
        hello_delay_ms: String(Math.round(report.helloDelayMs)),
        computer_id_present: String(report.computerIdPresent),
        rehello: String(report.rehello),
        supervised: report.supervised === undefined ? undefined : String(report.supervised),
        variant: report.variant,
      }
    : {
        age_ms: String(Math.round(report.ageMs)),
        had_hello: String(report.hadHello),
        has_heartbeat: String(report.hasHeartbeat),
        was_live: String(report.wasLive),
        emptied: String(report.emptied),
      }

  return { level: "info", event: SLATE_LOCAL_EXEC_PROVIDER_EVENT, metadata: { ...shared, ...details } }
}

export const refusalError = describeLocalExecRefusal
export const localExecRefusedTelemetry = projectLocalExecRefusal
export const localExecFailedTelemetry = projectLocalExecFailure
export const localExecProviderTelemetry = projectLocalExecProvider
export type { LocalExecRefusalCause, LocalExecProviderReport } from "./local-exec-telemetry-contracts.ts"
