export type AgentTranscriptEntry = Record<string, unknown>

export interface AgentTranscriptSqlRow {
  readonly seq?: number
  readonly entry?: string
}

export interface AgentTranscriptSqlStatement {
  all(...parameters: unknown[]): AgentTranscriptSqlRow[]
}

export interface AgentTranscriptSqlStatements {
  readonly listTranscriptPage: AgentTranscriptSqlStatement
  readonly listTranscriptWindow: AgentTranscriptSqlStatement
  readonly listTranscriptTail: AgentTranscriptSqlStatement
}

export interface AgentTranscriptPageRequest {
  readonly beforeSeq?: number
  readonly sinceMs?: number
  readonly untilMs: number
  readonly limit: number
}

export type AgentTranscriptPageResult = {
  entries: AgentTranscriptEntry[]
  nextBeforeSeq?: number
}
