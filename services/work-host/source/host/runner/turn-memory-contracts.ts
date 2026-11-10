import type { EpisodeTurn, MemoryRecall, MemoryRecord, MemoryStore, TextExecutor } from "./slate-memory.ts"

export interface TurnEvidenceRecord {
  readonly occurredAt: number
  readonly user: string
  readonly assistant: string
}

export interface SlateTurnMemoryStore extends MemoryStore {
  recall(limit: number): MemoryRecall
  listMemories(limit: number): readonly MemoryRecord[]
  recordMemoryEvidence?(evidence: TurnEvidenceRecord): void
}

export interface MemoryEpisodeProgress {
  clearPendingEpisodeTurns(): void
  recordEpisodeTurn(turn: EpisodeTurn): void
  getPendingEpisodeTurns(): readonly EpisodeTurn[]
}

export interface TurnMemorySession {
  getExecutor(): TextExecutor
}

export interface FinishedTurnExchange {
  readonly user: string
  readonly agent: string
}
