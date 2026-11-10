import type { AutomationRunTelemetryInput, DroppedAutomationFireTelemetryInput } from "./automation-fire-contracts.ts"
import { isAutomationRunLate, SLATE_AUTOMATION_FIRE_DROPPED_EVENT, SLATE_AUTOMATION_RUN_EVENT } from "./automation-fire-policy.ts"

export function projectAutomationRunTelemetry(report: AutomationRunTelemetryInput) {
  const late = isAutomationRunLate(report)
  return {
    level: report.outcome === "ok" && !late ? "info" : "warn",
    event: SLATE_AUTOMATION_RUN_EVENT,
    metadata: {
      conversation_id: report.conversationId,
      automation_id: report.automationId,
      trigger: report.trigger,
      outcome: report.outcome,
      is_group: String(report.isGroup),
      duration_ms: String(report.durationMs),
      lateness_ms: report.latenessMs == null ? undefined : String(report.latenessMs),
      scheduled_for_ms: report.scheduledForMs == null ? undefined : String(report.scheduledForMs),
      late: report.latenessMs == null ? undefined : String(late),
      sent_message_count: report.sentMessageCount == null ? undefined : String(report.sentMessageCount),
      event_batch_size: report.eventBatchSize == null ? undefined : String(report.eventBatchSize),
    },
  }
}

export function projectDroppedAutomationFire(report: DroppedAutomationFireTelemetryInput) {
  return {
    level: "warn",
    event: SLATE_AUTOMATION_FIRE_DROPPED_EVENT,
    metadata: {
      conversation_id: report.conversationId,
      trigger: report.trigger,
      reason: report.reason,
      scheduled_for_ms: report.scheduledForMs == null ? undefined : String(report.scheduledForMs),
      lateness_ms: report.latenessMs == null ? undefined : String(report.latenessMs),
      error_type: report.errorType,
      error_code: report.errorCode,
      run_uuid: report.runUuid,
      fire_age_ms: report.fireAgeMs == null ? undefined : String(report.fireAgeMs),
      has_definition_revision: report.hasDefinitionRevision == null ? undefined : String(report.hasDefinitionRevision),
      box_uptime_ms: report.boxUptimeMs == null ? undefined : String(report.boxUptimeMs),
    },
  }
}
