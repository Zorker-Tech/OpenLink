import type { TranscriptEntry } from "./agent-db.ts"
import type { SlateConversationCheckpointV2 } from "../../../packages/agent/conversation-checkpoint-state.ts"

export interface ConversationBlobStore<Value = Uint8Array> {
  getBlob(context: unknown, id: Uint8Array): Promise<Value | null>
  setBlob(context: unknown, id: Uint8Array, value: Value): Promise<void>
  flush(context: unknown): Promise<void>
}

export type ConversationStateShape = SlateConversationCheckpointV2

export interface ConversationSessionHandles {
  readonly db: { getTranscriptEntries(): TranscriptEntry[]; close(): void }
  readonly agentStore: { getFullConversation(context: unknown): Promise<unknown>; dispose(): Promise<void> }
}

export interface SessionConversationStateHost {
  readonly rootDir: string
  readonly ctx: unknown
  openSession(id: string): Promise<ConversationSessionHandles>
  deriveOutline(state: unknown): unknown
  deriveState(structure: ConversationStateShape, blobs: ConversationBlobStore): Promise<{ readonly turns: readonly unknown[] }>
}
