/**
 * Slate's in-memory shape for one persisted conversation turn.
 *
 * The shape is intentionally small: turn messages refer to immutable blobs, while the envelope carries
 * only the metadata needed to resume and reconstruct a turn.
 */
export interface SlateAgentConversationTurn {
  readonly kind: "agent"
  readonly userMessageBlobId: Uint8Array
  readonly stepBlobIds: readonly Uint8Array[]
  readonly requestId?: string
  readonly encryptedModel?: string
  readonly dynamicToolCount?: number
  readonly sendMessageStepIndices: readonly number[]
}

export interface SlateShellConversationTurn {
  readonly kind: "shell"
  readonly invocationBlobId: Uint8Array
  readonly resultBlobId: Uint8Array
}

export type SlateConversationTurn =
  | SlateAgentConversationTurn
  | SlateShellConversationTurn

export interface SlateAgentConversationTurnInput {
  readonly userMessageBlobId: Uint8Array
  readonly stepBlobIds: readonly Uint8Array[]
  readonly requestId?: string
  readonly encryptedModel?: string
  readonly dynamicToolCount?: number
  readonly sendMessageStepIndices: readonly number[]
}

export interface SlateShellConversationTurnInput {
  readonly invocationBlobId: Uint8Array
  readonly resultBlobId: Uint8Array
}

function cloneBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes)
}

/**
 * Creates a turn without aliasing caller-owned byte arrays or index collections.
 *
 * Blob ids and persisted metadata are immutable by contract. Copying at construction keeps a later
 * mutation of an input buffer or array from silently changing a turn that has already been queued.
 */
export function createSlateAgentConversationTurn(
  input: SlateAgentConversationTurnInput,
): SlateAgentConversationTurn {
  return {
    kind: "agent",
    userMessageBlobId: cloneBytes(input.userMessageBlobId),
    stepBlobIds: input.stepBlobIds.map(cloneBytes),
    ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    ...(input.encryptedModel === undefined ? {} : { encryptedModel: input.encryptedModel }),
    ...(input.dynamicToolCount === undefined ? {} : { dynamicToolCount: input.dynamicToolCount }),
    sendMessageStepIndices: [...input.sendMessageStepIndices],
  }
}

export function createSlateShellConversationTurn(
  input: SlateShellConversationTurnInput,
): SlateShellConversationTurn {
  return {
    kind: "shell",
    invocationBlobId: cloneBytes(input.invocationBlobId),
    resultBlobId: cloneBytes(input.resultBlobId),
  }
}
