import {
  AgentConversationTurnStructure,
  ShellConversationTurnStructure,
  ConversationStateStructure,
  ConversationTurnStructure,
} from "../proto/generated/agent/v1/agent_pb.ts";
import type { Message } from "@bufbuild/protobuf";
import { ProtobufBlobSerde } from "./protobuf-blob-serde-adapter.ts";
import { fromHex, toHex, utf8Serde, type BlobType, type Serde } from "../../../packages/agent-kv/serde.ts";
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

export const slateConversationTurnBlobType = {
  kind: "json",
  typeName: "slate.agent-conversation-turn",
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

/** Projects the persisted envelope into Slate's turn vocabulary. */
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
        invocationBlobId: value.turn.value.shellCommand,
        resultBlobId: value.turn.value.shellOutput,
      })
    default:
      throw new Error("Conversation turn record has no turn case")
  }
}

/** Reconstructs the historical storage message only at the persistence boundary. */
export function toInteropConversationTurn(
  value: SlateConversationTurn,
): InstanceType<typeof ConversationTurnStructure> {
  let outer: InstanceType<typeof ConversationTurnStructure>
  let payload: Message
  if (value.kind === "agent") {
    const agentTurn = createAgentConversationTurnInterop({
      userMessageBlobId: value.userMessageBlobId,
      stepBlobIds: value.stepBlobIds,
      sendMessageStepIndices: value.sendMessageStepIndices,
      ...(value.requestId === undefined ? {} : { requestId: value.requestId }),
      ...(value.encryptedModel === undefined ? {} : { encryptedModel: value.encryptedModel }),
      ...(value.dynamicToolCount === undefined ? {} : { dynamicToolCount: value.dynamicToolCount }),
    })
    outer = wrapAgentConversationTurnInterop(agentTurn)
    payload = agentTurn
  } else {
    const shellTurn = createShellConversationTurnInterop({
      shellCommandBlobId: value.invocationBlobId,
      shellOutputBlobId: value.resultBlobId,
    })
    outer = wrapShellConversationTurnInterop(shellTurn)
    payload = shellTurn
  }
  return outer
}

export interface SlateConversationTurnSerde extends Serde<SlateConversationTurn> {
  getBlobType(): BlobType
}

const SLATE_TURN_HEADER = utf8Serde.serialize("SLATE-AGENT-TURN\n")
const SLATE_TURN_FORMAT = "slate.agent-conversation-turn"

function beginsWith(bytes: Uint8Array, prefix: Uint8Array): boolean {
  if (bytes.length < prefix.length) return false
  for (let index = 0; index < prefix.length; index += 1) {
    if (bytes[index] !== prefix[index]) return false
  }
  return true
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key))
}

function isHexId(value: unknown): value is string {
  return typeof value === "string" && /^(?:[0-9a-f]{2})*$/.test(value)
}

function isSlateTurnEnvelope(value: unknown): value is {
  readonly format: typeof SLATE_TURN_FORMAT
  readonly version: 2
  readonly turn: Record<string, unknown>
} {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const envelope = value as Record<string, unknown>
  if (!hasOnlyKeys(envelope, ["format", "version", "turn"]) ||
      envelope.format !== SLATE_TURN_FORMAT || envelope.version !== 2 ||
      envelope.turn === null || typeof envelope.turn !== "object" || Array.isArray(envelope.turn)) return false
  const turn = envelope.turn as Record<string, unknown>
  if (turn.kind === "agent") {
    return hasOnlyKeys(turn, [
      "kind", "userMessageBlobId", "stepBlobIds", "requestId", "encryptedModel", "dynamicToolCount", "sendMessageStepIndices",
    ]) && isHexId(turn.userMessageBlobId) && Array.isArray(turn.stepBlobIds) && turn.stepBlobIds.every(isHexId) &&
      (turn.requestId === undefined || typeof turn.requestId === "string") &&
      (turn.encryptedModel === undefined || typeof turn.encryptedModel === "string") &&
      (turn.dynamicToolCount === undefined || (Number.isSafeInteger(turn.dynamicToolCount) && (turn.dynamicToolCount as number) >= 0 && (turn.dynamicToolCount as number) <= 0xffff_ffff)) &&
      Array.isArray(turn.sendMessageStepIndices) && turn.sendMessageStepIndices.every(index =>
        Number.isSafeInteger(index) && (index as number) >= 0 && (index as number) <= 0xffff_ffff)
  }
  if (turn.kind === "shell") {
    return hasOnlyKeys(turn, ["kind", "invocationBlobId", "resultBlobId"]) &&
      isHexId(turn.invocationBlobId) && isHexId(turn.resultBlobId)
  }
  return false
}

function serializeSlateConversationTurn(value: SlateConversationTurn): Uint8Array {
  const turn = value.kind === "agent"
    ? {
        kind: "agent",
        userMessageBlobId: toHex(value.userMessageBlobId),
        stepBlobIds: value.stepBlobIds.map(toHex),
        ...(value.requestId === undefined ? {} : { requestId: value.requestId }),
        ...(value.encryptedModel === undefined ? {} : { encryptedModel: value.encryptedModel }),
        ...(value.dynamicToolCount === undefined ? {} : { dynamicToolCount: value.dynamicToolCount }),
        sendMessageStepIndices: [...value.sendMessageStepIndices],
      }
    : {
        kind: "shell",
        invocationBlobId: toHex(value.invocationBlobId),
        resultBlobId: toHex(value.resultBlobId),
      }
  const envelope = {
    format: SLATE_TURN_FORMAT,
    version: 2,
    turn,
  }
  return utf8Serde.serialize(`SLATE-AGENT-TURN\n${JSON.stringify(envelope)}`)
}

function deserializeSlateConversationTurn(bytes: Uint8Array): SlateConversationTurn | undefined {
  if (!beginsWith(bytes, SLATE_TURN_HEADER)) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(utf8Serde.deserialize(bytes.subarray(SLATE_TURN_HEADER.length)))
  } catch (error) {
    throw new TypeError("Slate conversation turn JSON is invalid", { cause: error })
  }
  if (!isSlateTurnEnvelope(parsed)) throw new TypeError("Slate conversation turn record is unsupported or invalid")
  const turn = parsed.turn
  if (turn.kind === "agent") {
    return createSlateAgentConversationTurn({
      userMessageBlobId: fromHex(turn.userMessageBlobId as string),
      stepBlobIds: (turn.stepBlobIds as string[]).map(fromHex),
      ...(turn.requestId === undefined ? {} : { requestId: turn.requestId as string }),
      ...(turn.encryptedModel === undefined ? {} : { encryptedModel: turn.encryptedModel as string }),
      ...(turn.dynamicToolCount === undefined ? {} : { dynamicToolCount: turn.dynamicToolCount as number }),
      sendMessageStepIndices: turn.sendMessageStepIndices as number[],
    })
  }
  return createSlateShellConversationTurn({
    invocationBlobId: fromHex(turn.invocationBlobId as string),
    resultBlobId: fromHex(turn.resultBlobId as string),
  })
}

/** Writes and reads turns in Slate's own versioned format. */
export const slateConversationTurnSerde: SlateConversationTurnSerde = {
  serialize(value) {
    return serializeSlateConversationTurn(value)
  },
  deserialize(bytes) {
    const turn = deserializeSlateConversationTurn(bytes)
    if (turn === undefined) throw new TypeError("Slate conversation turn record is unsupported or invalid")
    return turn
  },
  getBlobType() {
    return { ...slateConversationTurnBlobType }
  },
}
