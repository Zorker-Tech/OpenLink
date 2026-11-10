/** Map memory-synthesis outcomes onto the host's structured telemetry contract. */
import { slateErrorTags, type SlateErrorValue } from "../../shared/errors/registry.ts"

export const MEMORY_SYNTHESIS_EVENT = "slate.memory.synthesis"

export type MemorySynthesisReport =
  | { readonly outcome: "skipped_gate" }
  | {
      readonly outcome: "shed"
      readonly cause: SlateErrorValue
      readonly itemCount: number
    }
  | {
      readonly outcome: "failed"
      readonly cause: SlateErrorValue
      readonly durationMs: number
      readonly itemCount: number
    }
  | {
      readonly outcome: "ok"
      readonly durationMs: number
      readonly itemCount: number
    }

function telemetryEvent(level: "info" | "warn", metadata: Record<string, string>): {
  readonly level: "info" | "warn"
  readonly event: string
  readonly metadata: Record<string, string>
} {
  return { level, event: MEMORY_SYNTHESIS_EVENT, metadata }
}

function runMetrics(durationMs: number, itemCount: number): Record<string, string> {
  return {
    duration_ms: String(Math.round(durationMs)),
    item_count: String(itemCount),
  }
}

export function memorySynthesisTelemetry(report: MemorySynthesisReport) {
  switch (report.outcome) {
    case "skipped_gate":
      return telemetryEvent("info", { outcome: report.outcome })
    case "shed":
      return telemetryEvent("warn", {
        outcome: report.outcome,
        ...slateErrorTags(report.cause),
        item_count: String(report.itemCount),
      })
    case "failed":
      return telemetryEvent("warn", {
        outcome: report.outcome,
        ...slateErrorTags(report.cause),
        ...runMetrics(report.durationMs, report.itemCount),
      })
    case "ok":
      return telemetryEvent("info", {
        outcome: report.outcome,
        ...runMetrics(report.durationMs, report.itemCount),
      })
  }
}
