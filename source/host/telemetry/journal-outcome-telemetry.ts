/** Project journal recovery results into the host's structured telemetry event. */
import { slateErrorTags, type SlateErrorValue } from "../../shared/errors/registry.ts"

export const JOURNAL_OUTCOME_EVENT = "slate.journal.outcome"

export interface JournalOutcomeReport {
  readonly outcome: string
  readonly op: string
  readonly conversationId: string
  readonly entryCount?: number | undefined
  readonly bytes?: number | undefined
  readonly durationMs: number
  readonly cause?: SlateErrorValue | undefined
}

export function corruptTailKind(cause: SlateErrorValue | undefined): unknown {
  if (cause === undefined || !("tail" in cause)) return undefined
  return cause.tail
}

function needsWarning(tail: unknown): boolean {
  return tail !== undefined && tail !== "missing"
}

export function journalOutcomeLevel(report: JournalOutcomeReport): "error" | "warn" | "info" {
  if (report.outcome === "failed") return "error"
  return needsWarning(corruptTailKind(report.cause)) ? "warn" : "info"
}

function stringifyOptionalCount(value: number | undefined): string | undefined {
  return value === undefined ? undefined : String(value)
}

function stringifyDuration(milliseconds: number): string {
  return String(Math.round(milliseconds))
}

function journalOutcomeMetadata(report: JournalOutcomeReport): Record<string, string | undefined> {
  return {
    op: report.op,
    outcome: report.outcome,
    conversation_id: report.conversationId,
    entry_count: stringifyOptionalCount(report.entryCount),
    bytes: stringifyOptionalCount(report.bytes),
    duration_ms: stringifyDuration(report.durationMs),
    ...(report.cause === undefined ? {} : slateErrorTags(report.cause)),
  }
}

export function journalOutcomeTelemetry(report: JournalOutcomeReport) {
  return {
    level: journalOutcomeLevel(report),
    event: JOURNAL_OUTCOME_EVENT,
    metadata: journalOutcomeMetadata(report),
  }
}
