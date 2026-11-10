import type { SlateAgentDb, TranscriptEntry } from "./agent-db.ts"
import type {
  ConversationStatePort,
  OpenAgentSession,
  TranscriptPageQuery,
  TranscriptWindowQuery,
} from "./agent-session.ts"

export class SessionTranscriptReader {
  constructor(
    private readonly getConversationState: () => ConversationStatePort | undefined,
    private readonly withAgentDb: <T>(
      agentId: string,
      operation: (db: SlateAgentDb, dbPath: string) => T | Promise<T>,
    ) => Promise<T>,
  ) {}

  async entries(session: OpenAgentSession): Promise<TranscriptEntry[]> {
    return this.getConversationState()?.getTranscriptEntries(session) ?? session.db.getTranscriptEntries()
  }

  async sessionOutline(session: OpenAgentSession): Promise<unknown> {
    return this.#required().getSessionOutline(session)
  }

  async agentOutline(agentId: string): Promise<unknown> {
    return this.#required().getAgentOutline(agentId)
  }

  async agentEntries(agentId: string): Promise<TranscriptEntry[]> {
    const state = this.getConversationState()
    return state?.getAgentTranscriptEntries(agentId)
      ?? this.withAgentDb(agentId, db => db.getTranscriptEntries())
  }

  synchronousEntries(agentId: string): TranscriptEntry[] {
    return this.getConversationState()?.readAgentTranscriptEntries(agentId) ?? []
  }

  page(agentId: string, query: TranscriptPageQuery) {
    return this.getConversationState()?.readAgentTranscriptPage(agentId, query) ?? { entries: [] }
  }

  window(agentId: string, query: TranscriptWindowQuery) {
    return this.getConversationState()?.readAgentTranscriptWindow(agentId, query)
      ?? { entries: [], threadCounts: {} }
  }

  tail(agentId: string, query: TranscriptWindowQuery) {
    return this.getConversationState()?.readAgentTranscriptTail(agentId, query) ?? { entries: [] }
  }

  thread(agentId: string, rootId: string) {
    return this.getConversationState()?.readAgentThread(agentId, rootId) ?? { entries: [] }
  }

  #required(): ConversationStatePort {
    const state = this.getConversationState()
    if (state === undefined) throw new Error("Session conversation-state provider is required")
    return state
  }
}
