import type {
  AgentTranscriptPageRequest,
  AgentTranscriptPageResult,
  AgentTranscriptSqlStatements,
  AgentTranscriptEntry,
} from "./agent-transcript-page-contracts.ts"
import {
  boundedTranscriptPageSize,
  finiteTranscriptCursor,
  projectTranscriptRows,
} from "./agent-transcript-page-projections.ts"

export type { AgentTranscriptEntry, AgentTranscriptPageRequest, AgentTranscriptPageResult, AgentTranscriptSqlStatements } from "./agent-transcript-page-contracts.ts"
export { boundedTranscriptPageSize, finiteTranscriptCursor, projectTranscriptRows } from "./agent-transcript-page-projections.ts"

/** Reads one page under the transcript's time and sequence filters. */
export function loadAgentTranscriptPage(
  statements: AgentTranscriptSqlStatements,
  request: AgentTranscriptPageRequest,
): AgentTranscriptPageResult {
  const beforeSequence = request.beforeSeq ?? null
  const earliestTimestamp = request.sinceMs ?? null
  const rows = statements.listTranscriptPage.all(
    beforeSequence,
    beforeSequence,
    earliestTimestamp,
    earliestTimestamp,
    request.untilMs,
    request.limit + 1,
  )
  return projectTranscriptRows(rows, request.limit)
}

export function loadAgentTranscriptWindow(
  statements: AgentTranscriptSqlStatements,
  request: Pick<AgentTranscriptPageRequest, "beforeSeq" | "limit">,
  countThreads: (entries: readonly AgentTranscriptEntry[]) => unknown,
): AgentTranscriptPageResult & { threadCounts: unknown } {
  const beforeSequence = finiteTranscriptCursor(request.beforeSeq)
  const limit = boundedTranscriptPageSize(request.limit)
  const page = projectTranscriptRows(statements.listTranscriptWindow.all(beforeSequence, beforeSequence, limit + 1), limit)
  return { ...page, threadCounts: countThreads(page.entries) }
}

export function loadAgentTranscriptTail(
  statements: AgentTranscriptSqlStatements,
  request: Pick<AgentTranscriptPageRequest, "beforeSeq" | "limit">,
): AgentTranscriptPageResult {
  const beforeSequence = finiteTranscriptCursor(request.beforeSeq)
  const limit = boundedTranscriptPageSize(request.limit)
  return projectTranscriptRows(statements.listTranscriptTail.all(beforeSequence, beforeSequence, limit + 1), limit)
}
