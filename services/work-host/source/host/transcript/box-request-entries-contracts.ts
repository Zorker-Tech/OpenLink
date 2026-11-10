import type { TranscriptEntry } from "./transcript-hub.ts"

export interface ActiveBoxRequest {
  readonly agentId: string
  readonly entryId: string
  readonly requestId: string
}

export interface BoxRequestSession {
  readonly id: string
  readonly db: {
    getTranscriptEntries(): TranscriptEntry[]
    updateTranscriptEntry(id: string, change: (entry: TranscriptEntry) => TranscriptEntry): unknown
    close(): void
  }
  readonly agentStore: { dispose(): Promise<void> }
}

export interface BoxRequestSessionIndex {
  readonly activeSession?: BoxRequestSession | null
  readonly liveSessions: Map<string, BoxRequestSession>
  readonly inMemoryTranscriptAgentId?: string
  isAgentGone(agentId: string): boolean
}

export interface BoxRequestEntryHost {
  readonly sessions?: BoxRequestSessionIndex
  readonly sessionStore: { openSession(agentId: string): Promise<BoxRequestSession> }
  readonly roster: { emit(event: { type: "updated"; entry: TranscriptEntry }): void }
  resolveBoxRequestEntry(agentId: string, requestId: string, resolution: string): Promise<void> | void
}
