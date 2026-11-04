/**
 * Slate's in-memory shape for one persisted conversation turn.
 *
 * The shape is intentionally small: turn messages refer to immutable blobs, while the envelope carries
 * only the metadata needed to resume and reconstruct a turn. The storage adapter writes Slate's own
 * versioned envelope and imports the historical encoding only when reading older blobs.
 */
export interface SlateAgentConversationTurn {
  readonly kind: "agent"
  readonly userMessageBlobId: Uint8Array
  readonly stepBlobIds: readonly Uint8Array[]
  readonly requestId?: string
  readonly encryptedModel?: string
  readonly dynamicToolCount?: number
  readonly sendMessageStepIndices: readonly number[]
  readonly compatibility?: SlateConversationTurnCompatibility
}

export interface SlateShellConversationTurn {
  readonly kind: "shell"
  readonly shellCommandBlobId: Uint8Array
  readonly shellOutputBlobId: Uint8Array
  readonly compatibility?: SlateConversationTurnCompatibility
}

export interface SlateConversationTurnCompatibility {
  readonly envelopeUnknownFields?: readonly SlateConversationTurnUnknownField[]
  readonly payloadUnknownFields?: readonly SlateConversationTurnUnknownField[]
}

export interface SlateConversationTurnUnknownField {
  readonly number: number
  readonly wireType: number
  readonly dataHex: string
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
  readonly compatibility?: SlateConversationTurnCompatibility
}

export interface SlateShellConversationTurnInput {
  readonly shellCommandBlobId: Uint8Array
  readonly shellOutputBlobId: Uint8Array
  readonly compatibility?: SlateConversationTurnCompatibility
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
    ...(input.compatibility === undefined ? {} : { compatibility: cloneCompatibility(input.compatibility) }),
  }
}

export function createSlateShellConversationTurn(
  input: SlateShellConversationTurnInput,
): SlateShellConversationTurn {
  return {
    kind: "shell",
    shellCommandBlobId: cloneBytes(input.shellCommandBlobId),
    shellOutputBlobId: cloneBytes(input.shellOutputBlobId),
    ...(input.compatibility === undefined ? {} : { compatibility: cloneCompatibility(input.compatibility) }),
  }
}

function cloneCompatibility(
  value: SlateConversationTurnCompatibility,
): SlateConversationTurnCompatibility {
  return {
    ...(value.envelopeUnknownFields === undefined
      ? {}
      : { envelopeUnknownFields: value.envelopeUnknownFields.map(field => ({ ...field })) }),
    ...(value.payloadUnknownFields === undefined
      ? {}
      : { payloadUnknownFields: value.payloadUnknownFields.map(field => ({ ...field })) }),
  }
}
