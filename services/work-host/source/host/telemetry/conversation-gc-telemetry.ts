/** What collecting an unread conversation did, in the shape the telemetry backend takes: the outcome and what it collected or why it did not. */
export const CONVERSATION_GC_EVENT = "slate.conversation.gc";
export type ConversationGcReport =
  | { outcome: "failed"; trigger: string; agentId: string }
  | {
      outcome: "skipped";
      trigger: string;
      agentId: string;
      skipReason: string;
      unresolvedProtoRefs?: number;
    }
  | {
      outcome: "collected";
      trigger: string;
      agentId: string;
      stillOverCap: boolean;
      deletedRows: number;
      deletedBytes: number;
      liveRows: number;
      liveBytes: number;
      vacuumed: boolean;
    };
export function cappedCount(value: number): string {
  let rounded = Math.round(value)
  if (rounded < 0) rounded = 0
  if (rounded > Number.MAX_SAFE_INTEGER) rounded = Number.MAX_SAFE_INTEGER
  return String(rounded)
}
export function conversationGcLevel(
  report: ConversationGcReport,
): "info" | "warn" {
  switch (report.outcome) {
    case "failed":
      return "warn"
    case "skipped":
      return report.skipReason === "unresolved-refs" ? "warn" : "info"
    case "collected":
      return report.stillOverCap ? "warn" : "info"
  }
}
export function conversationGcTelemetry(report: ConversationGcReport) {
  const metadata = {
    trigger: report.trigger,
    outcome: report.outcome,
    agent_id: report.agentId,
    skip_reason: undefined as string | undefined,
    unresolved_proto_refs: undefined as string | undefined,
    deleted_rows: undefined as string | undefined,
    deleted_bytes: undefined as string | undefined,
    live_rows: undefined as string | undefined,
    live_bytes: undefined as string | undefined,
    vacuumed: undefined as string | undefined,
  }

  if (report.outcome === "skipped") {
    metadata.skip_reason = report.skipReason
    if (report.unresolvedProtoRefs !== undefined) {
      metadata.unresolved_proto_refs = cappedCount(report.unresolvedProtoRefs)
    }
  } else if (report.outcome === "collected") {
    metadata.deleted_rows = cappedCount(report.deletedRows)
    metadata.deleted_bytes = cappedCount(report.deletedBytes)
    metadata.live_rows = cappedCount(report.liveRows)
    metadata.live_bytes = cappedCount(report.liveBytes)
    metadata.vacuumed = String(report.vacuumed)
  }

  return {
    level: conversationGcLevel(report),
    event: CONVERSATION_GC_EVENT,
    metadata,
  };
}
