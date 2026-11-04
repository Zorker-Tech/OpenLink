import { memoizeConversationBlobs } from "./session-recovery.ts"
import { conversationStructureFullyResolves } from "./conversation-recovery.ts"
import { readWithAgentDatabase } from "./session-conversation-database-reads.ts"
import { withConversationSession } from "./session-conversation-session-reads.ts"
import type {
  ConversationBlobStore,
  ConversationSessionHandles,
  ConversationStateShape,
  SessionConversationStateHost,
} from "./session-conversation-state-contracts.ts"
import type { TranscriptEntry } from "./agent-db.ts"

export class SlateSessionConversationState {
  constructor(readonly host: SessionConversationStateHost) {}

  async resolveConversationState(
    structure: ConversationStateShape,
    blobStore: ConversationBlobStore,
  ): Promise<{ readonly turns: readonly unknown[] } | null> {
    const cachedBlobs = memoizeConversationBlobs(blobStore)
    if (!await conversationStructureFullyResolves(this.host.ctx, structure, cachedBlobs)) return null

    const state = await this.host.deriveState(structure, cachedBlobs)
    return state.turns.length === 0 || state.turns.length < structure.turns.length ? null : state
  }

  async getTranscriptEntries(session: Pick<ConversationSessionHandles, "db">): Promise<TranscriptEntry[]> {
    return session.db.getTranscriptEntries()
  }

  async getSessionOutline(session: Pick<ConversationSessionHandles, "agentStore">): Promise<unknown> {
    const conversation = await session.agentStore.getFullConversation(this.host.ctx)
    return this.host.deriveOutline(conversation)
  }

  getAgentOutline(agentId: string): Promise<unknown> {
    return withConversationSession(this.host, agentId, session => this.getSessionOutline(session))
  }

  readAgentTranscriptEntries(agentId: string): TranscriptEntry[] {
    return readWithAgentDatabase(this.host.rootDir, agentId, database => database.getTranscriptEntries(), [])
  }

  readAgentTranscriptPage(
    agentId: string,
    query: { readonly beforeSeq?: number; readonly sinceMs?: number; readonly untilMs: number; readonly limit: number },
  ) {
    return readWithAgentDatabase(this.host.rootDir, agentId, database => database.getTranscriptPage(query), { entries: [] })
  }

  readAgentTranscriptWindow(agentId: string, query: { readonly beforeSeq?: number; readonly limit: number }) {
    return readWithAgentDatabase(this.host.rootDir, agentId, database => database.getTranscriptWindow(query), { entries: [], threadCounts: {} })
  }

  readAgentTranscriptTail(agentId: string, query: { readonly beforeSeq?: number; readonly limit: number }) {
    return readWithAgentDatabase(this.host.rootDir, agentId, database => database.getTranscriptTail(query), { entries: [] })
  }

  readAgentThread(agentId: string, rootId: string) {
    return readWithAgentDatabase(this.host.rootDir, agentId, database => database.getThread(rootId), { entries: [] })
  }

  getAgentTranscriptEntries(agentId: string): Promise<TranscriptEntry[]> {
    return withConversationSession(this.host, agentId, session => this.getTranscriptEntries(session))
  }
}
