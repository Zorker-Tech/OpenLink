/** A subagent or shell that was revived, in the shape the telemetry backend reports it: the same fields, under the two event names. */
type RevivalFields = Record<
  string,
  string | number | boolean | null | undefined
>;
export const SUBAGENT_REVIVAL_EVENT = "slate.subagent.revival",
  SHELL_REVIVAL_EVENT = "slate.shell.revival";
export function subagentRevivalTelemetry(r: RevivalFields) {
  return {
    level:
      r.outcome === "dropped" && r.reason !== "agent_deleted" ? "warn" : "info",
    event: SUBAGENT_REVIVAL_EVENT,
    metadata: {
      conversation_id: r.parentAgentId,
      outcome: r.outcome,
      completion_count: String(r.completionCount),
      subagent_type: r.subagentType,
      subagent_agent_id: r.subagentAgentId,
      reason: r.reason,
      sent_message_count:
        r.sentMessageCount != null ? String(r.sentMessageCount) : undefined,
      quiet_origin:
        r.isQuietOrigin != null ? String(r.isQuietOrigin) : undefined,
    },
  };
}
export function shellRevivalTelemetry(r: RevivalFields) {
  return {
    level:
      r.outcome === "dropped" && r.reason !== "agent_gone" ? "warn" : "info",
    event: SHELL_REVIVAL_EVENT,
    metadata: {
      conversation_id: r.conversationId,
      outcome: r.outcome,
      completion_count: String(r.completionCount),
      sent_message_count:
        r.sentMessageCount != null ? String(r.sentMessageCount) : undefined,
      quiet_origin:
        r.isQuietOrigin != null ? String(r.isQuietOrigin) : undefined,
      reason: r.reason,
    },
  };
}
