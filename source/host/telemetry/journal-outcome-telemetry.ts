/** An outcome of the transcript journal, in the shape the telemetry backend reports it, with the error tags the platform uses. */
import {
  slateErrorTags,
  type SlateErrorValue,
} from "../../shared/errors/registry.ts";

export const JOURNAL_OUTCOME_EVENT = "slate.journal.outcome";
export interface JournalOutcomeReport {
  outcome: string;
  op: string;
  conversationId: string;
  entryCount?: number;
  bytes?: number;
  durationMs: number;
  cause?: SlateErrorValue;
}
export function corruptTailKind(cause: SlateErrorValue | undefined): unknown {
  return cause !== undefined && "tail" in cause ? cause.tail : undefined;
}
export function journalOutcomeLevel(
  report: JournalOutcomeReport,
): "error" | "warn" | "info" {
  if (report.outcome === "failed") return "error";
  const tail = corruptTailKind(report.cause);
  if (tail !== undefined && tail !== "missing") return "warn";
  return "info";
}
export function journalOutcomeTelemetry(r: JournalOutcomeReport) {
  return {
    level: journalOutcomeLevel(r),
    event: JOURNAL_OUTCOME_EVENT,
    metadata: {
      op: r.op,
      outcome: r.outcome,
      conversation_id: r.conversationId,
      entry_count:
        r.entryCount !== undefined ? String(r.entryCount) : undefined,
      bytes: r.bytes !== undefined ? String(r.bytes) : undefined,
      duration_ms: String(Math.round(r.durationMs)),
      ...(r.cause !== undefined ? slateErrorTags(r.cause) : {}),
    },
  };
}
