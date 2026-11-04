import { parseTranscriptEntry } from "./agent-db-serde.ts"
import type { AgentTranscriptEntry, AgentTranscriptPageResult, AgentTranscriptSqlRow } from "./agent-transcript-page-contracts.ts"

export function projectTranscriptRows(rows: readonly AgentTranscriptSqlRow[], limit: number): AgentTranscriptPageResult {
  const hasMore = rows.length > limit
  const selected = rows.slice(0, limit)
  const entries: AgentTranscriptEntry[] = []

  for (const row of selected.toReversed()) {
    if (typeof row.entry !== "string") continue
    const parsed = parseTranscriptEntry(row.entry)
    if (parsed !== null) entries.push(parsed)
  }

  const oldestSelectedSequence = selected.at(-1)?.seq
  return {
    entries,
    ...(hasMore && typeof oldestSelectedSequence === "number" ? { nextBeforeSeq: oldestSelectedSequence } : {}),
  }
}

export function finiteTranscriptCursor(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

export function boundedTranscriptPageSize(value: number): number {
  return Number.isInteger(value) && value > 0 ? Math.min(value, 5_000) : 500
}
