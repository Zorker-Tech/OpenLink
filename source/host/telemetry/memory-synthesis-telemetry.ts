/** What the memory synthesis did, in the shape the telemetry backend reports it: the outcome, the tagged cause and what it held. */
import {
  slateErrorTags,
  type SlateErrorValue,
} from "../../shared/errors/registry.ts";

export const MEMORY_SYNTHESIS_EVENT = "slate.memory.synthesis";
export type MemorySynthesisReport =
  | { outcome: "skipped_gate" }
  | {
      outcome: "shed";
      cause: SlateErrorValue;
      itemCount: number;
    }
  | {
      outcome: "failed";
      cause: SlateErrorValue;
      durationMs: number;
      itemCount: number;
    }
  | {
      outcome: "ok";
      durationMs: number;
      itemCount: number;
    };

export function memorySynthesisTelemetry(r: MemorySynthesisReport) {
  if (r.outcome === "skipped_gate")
    return {
      level: "info",
      event: MEMORY_SYNTHESIS_EVENT,
      metadata: { outcome: r.outcome },
    };
  if (r.outcome === "shed")
    return {
      level: "warn",
      event: MEMORY_SYNTHESIS_EVENT,
      metadata: {
        outcome: r.outcome,
        ...slateErrorTags(r.cause),
        item_count: String(r.itemCount),
      },
    };
  return {
    level: r.outcome === "failed" ? "warn" : "info",
    event: MEMORY_SYNTHESIS_EVENT,
    metadata: {
      outcome: r.outcome,
      ...(r.outcome === "failed" ? slateErrorTags(r.cause) : {}),
      duration_ms: String(Math.round(r.durationMs)),
      item_count: String(r.itemCount),
    },
  };
}
