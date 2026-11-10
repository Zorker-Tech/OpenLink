/** Project revived background work into the two structured telemetry events. */
type RevivalFields = Record<string, string | number | boolean | null | undefined>

export const SUBAGENT_REVIVAL_EVENT = "slate.subagent.revival"
export const SHELL_REVIVAL_EVENT = "slate.shell.revival"

function severityForDroppedOutcome(outcome: unknown, reason: unknown, expectedDropReason: string): "warn" | "info" {
  return outcome === "dropped" && reason !== expectedDropReason ? "warn" : "info"
}

function optionalTag(value: string | number | boolean | null | undefined): string | undefined {
  return value == null ? undefined : String(value)
}

function commonRevivalMetadata(
  report: RevivalFields,
  conversationId: string | number | boolean | null | undefined,
) {
  return {
    conversation_id: conversationId,
    outcome: report.outcome,
    completion_count: String(report.completionCount),
  }
}

export function subagentRevivalTelemetry(report: RevivalFields) {
  return {
    level: severityForDroppedOutcome(report.outcome, report.reason, "agent_deleted"),
    event: SUBAGENT_REVIVAL_EVENT,
    metadata: {
      ...commonRevivalMetadata(report, report.parentAgentId),
      subagent_type: report.subagentType,
      subagent_agent_id: report.subagentAgentId,
      reason: report.reason,
      sent_message_count: optionalTag(report.sentMessageCount),
      quiet_origin: optionalTag(report.isQuietOrigin),
    },
  }
}

export function shellRevivalTelemetry(report: RevivalFields) {
  return {
    level: severityForDroppedOutcome(report.outcome, report.reason, "agent_gone"),
    event: SHELL_REVIVAL_EVENT,
    metadata: {
      ...commonRevivalMetadata(report, report.conversationId),
      sent_message_count: optionalTag(report.sentMessageCount),
      quiet_origin: optionalTag(report.isQuietOrigin),
      reason: report.reason,
    },
  }
}
