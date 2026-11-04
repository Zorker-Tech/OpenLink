import {
  AgentConversationTurnStructure,
  ShellConversationTurnStructure,
  ConversationStateStructure,
  ConversationTurnStructure,
} from "../proto/generated/agent/v1/agent_pb.ts";
import { ProtobufBlobSerde } from "./protobuf-blob-serde-adapter.ts";
import type { BlobType, Serde } from "../../../packages/agent-kv/serde-contracts.ts";
import {
  createSlateAgentConversationTurn,
  createSlateShellConversationTurn,
  type SlateConversationTurn,
} from "../../../packages/agent/conversation-turn-state.ts";

export type ConversationTurnEnvelopeViewInterop =
  | { readonly kind: "agent"; readonly value: InstanceType<typeof AgentConversationTurnStructure> }
  | { readonly kind: "shell"; readonly value: InstanceType<typeof ShellConversationTurnStructure> }
  | { readonly kind: "unknown" }

export type AgentConversationTurnInterop = InstanceType<typeof AgentConversationTurnStructure>
export type ShellConversationTurnInterop = InstanceType<typeof ShellConversationTurnStructure>

export const conversationStateStructureSerde = new ProtobufBlobSerde(ConversationStateStructure);
export const conversationTurnStructureSerde = new ProtobufBlobSerde(ConversationTurnStructure);

export const conversationTurnStructureBlobTypeInterop = {
  kind: "proto",
  typeName: "agent.v1.ConversationTurnStructure",
} as const

export function wrapAgentConversationTurnInterop(turn: AgentConversationTurnInterop): InstanceType<typeof ConversationTurnStructure> {
  return new ConversationTurnStructure({ turn: { case: "agentConversationTurn", value: turn } })
}

export function wrapShellConversationTurnInterop(turn: ShellConversationTurnInterop): InstanceType<typeof ConversationTurnStructure> {
  return new ConversationTurnStructure({ turn: { case: "shellConversationTurn", value: turn } })
}

export function createShellConversationTurnInterop(input: {
  readonly shellCommandBlobId: Uint8Array
  readonly shellOutputBlobId: Uint8Array
}): ShellConversationTurnInterop {
  return new ShellConversationTurnStructure({
    shellCommand: new Uint8Array(input.shellCommandBlobId),
    shellOutput: new Uint8Array(input.shellOutputBlobId),
  })
}

export function createAgentConversationTurnInterop(input: {
  readonly userMessageBlobId: Uint8Array
  readonly stepBlobIds: readonly Uint8Array[]
  readonly sendMessageStepIndices: readonly number[]
  readonly requestId?: string
  readonly encryptedModel?: string
  readonly dynamicToolCount?: number
}): AgentConversationTurnInterop {
  return new AgentConversationTurnStructure({
    userMessage: new Uint8Array(input.userMessageBlobId),
    steps: [...input.stepBlobIds],
    sendMessageStepIndices: [...input.sendMessageStepIndices],
    ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    ...(input.encryptedModel === undefined ? {} : { encryptedModel: input.encryptedModel }),
    ...(input.dynamicToolCount === undefined ? {} : { dynamicToolCount: input.dynamicToolCount }),
  })
}

export function projectConversationTurnEnvelopeInterop(
  outer: InstanceType<typeof ConversationTurnStructure>,
): ConversationTurnEnvelopeViewInterop {
  switch (outer.turn.case) {
    case "agentConversationTurn":
      return { kind: "agent", value: outer.turn.value }
    case "shellConversationTurn":
      return { kind: "shell", value: outer.turn.value }
    default:
      return { kind: "unknown" }
  }
}

/** Projects the historical persisted envelope into Slate's turn vocabulary. */
export function fromInteropConversationTurn(
  value: InstanceType<typeof ConversationTurnStructure>,
): SlateConversationTurn {
  switch (value.turn.case) {
    case "agentConversationTurn":
      return createSlateAgentConversationTurn({
        userMessageBlobId: value.turn.value.userMessage,
        stepBlobIds: value.turn.value.steps,
        ...(value.turn.value.requestId === undefined ? {} : { requestId: value.turn.value.requestId }),
        ...(value.turn.value.encryptedModel === undefined
          ? {}
          : { encryptedModel: value.turn.value.encryptedModel }),
        ...(value.turn.value.dynamicToolCount === undefined
          ? {}
          : { dynamicToolCount: value.turn.value.dynamicToolCount }),
        sendMessageStepIndices: value.turn.value.sendMessageStepIndices,
      })
    case "shellConversationTurn":
      return createSlateShellConversationTurn({
        shellCommandBlobId: value.turn.value.shellCommand,
        shellOutputBlobId: value.turn.value.shellOutput,
      })
    default:
      throw new Error("Invalid ConversationTurnStructure: missing turn case")
  }
}

/** Reconstructs the historical storage message only at the persistence boundary. */
export function toInteropConversationTurn(
  value: SlateConversationTurn,
): InstanceType<typeof ConversationTurnStructure> {
  if (value.kind === "agent") {
    return wrapAgentConversationTurnInterop(createAgentConversationTurnInterop({
      userMessageBlobId: value.userMessageBlobId,
      stepBlobIds: value.stepBlobIds,
      sendMessageStepIndices: value.sendMessageStepIndices,
      ...(value.requestId === undefined ? {} : { requestId: value.requestId }),
      ...(value.encryptedModel === undefined ? {} : { encryptedModel: value.encryptedModel }),
      ...(value.dynamicToolCount === undefined ? {} : { dynamicToolCount: value.dynamicToolCount }),
    }))
  }
  return wrapShellConversationTurnInterop(createShellConversationTurnInterop({
    shellCommandBlobId: value.shellCommandBlobId,
    shellOutputBlobId: value.shellOutputBlobId,
  }))
}

export interface SlateConversationTurnSerde extends Serde<SlateConversationTurn> {
  getBlobType(): BlobType
}

/** Keeps legacy turn bytes behind the adapter while state handles Slate-owned turns. */
export const slateConversationTurnSerde: SlateConversationTurnSerde = {
  serialize(value) {
    return toInteropConversationTurn(value).toBinary()
  },
  deserialize(bytes) {
    return fromInteropConversationTurn(ConversationTurnStructure.fromBinary(bytes))
  },
  getBlobType() {
    return { ...conversationTurnStructureBlobTypeInterop }
  },
}
