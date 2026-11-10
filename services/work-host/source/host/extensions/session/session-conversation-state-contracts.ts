import type { TranscriptEntry } from "./agent-db.ts"
import type { SlateHydratedConversation } from "../../../packages/agent/conversation-transcript-state.ts"
import type { SlateConversationCheckpointV2 } from "../../../packages/agent/conversation-checkpoint-state.ts"

export interface ConversationBlobStore<Value = Uint8Array> {
  getBlob(context: unknown, id: Uint8Array): Promise<Value | null>
  setBlob(context: unknown, id: Uint8Array, value: Value): Promise<void>
  flush(context: unknown): Promise<void>
}

export type ConversationStateShape = SlateConversationCheckpointV2

export interface ConversationSessionHandles {
  readonly db: { getTranscriptEntries(): TranscriptEntry[]; close(): void }
  readonly agentStore: { getFullConversation(context: unknown): Promise<SlateHydratedConversation>; dispose(): Promise<void> }
}

export interface SessionConversationStateHost {
  readonly rootDir: string
  readonly ctx: unknown
  openSession(id: string): Promise<ConversationSessionHandles>
  deriveOutline(state: SlateHydratedConversation): unknown
  deriveState(structure: ConversationStateShape, blobs: ConversationBlobStore): Promise<SlateHydratedConversation>
}
