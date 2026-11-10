import type { BlobStore } from "./blob-store.ts"

export type ConversationBlobReader<Context> = Pick<BlobStore<Context>, "getBlob">

/** Opaque persisted child metadata; child type details are interpreted only at an adapter boundary. */
export interface PersistedAgentSubconversation<Checkpoint> {
  readonly conversationState?: Checkpoint | undefined
  readonly createdTimestampMs: bigint
  readonly lastUsedTimestampMs: bigint
  readonly subagentType?: unknown
}

export interface AgentConversationBundle<Conversation> {
  readonly conversationState: Conversation
  readonly subagentStates: Record<string, {
    readonly conversationState: Conversation
    readonly createdTimestampMs: bigint
    readonly lastUsedTimestampMs: bigint
    readonly subagentType?: unknown
  }>
}

/** The blob-owning class supplies storage mechanics; a codec owns every persisted/wire shape. */
export interface AgentConversationCodec<Context, Checkpoint, Conversation> {
  createEmptyCheckpoint(): Checkpoint
  /** Optionally normalizes a legacy host value into the codec's owned checkpoint model. */
  normalizeCheckpoint?(checkpoint: unknown): Checkpoint
  encodeCheckpoint(checkpoint: Checkpoint): Uint8Array
  decodeCheckpoint(blob: Uint8Array): Checkpoint
  getLastRequestId(
    context: Context,
    checkpoint: Checkpoint,
    blobs: ConversationBlobReader<Context>,
  ): Promise<string | null>
  hydrateConversation(
    context: Context,
    checkpoint: Checkpoint,
    blobs: ConversationBlobReader<Context>,
  ): Promise<Conversation>
  resolveSubconversations(
    context: Context,
    checkpoint: Checkpoint,
    blobs: ConversationBlobReader<Context>,
  ): Promise<Record<string, PersistedAgentSubconversation<Checkpoint>>>
}
