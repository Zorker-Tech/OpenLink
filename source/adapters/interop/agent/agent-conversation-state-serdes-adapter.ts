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
  type SlateConversationTurnCompatibility,
  type SlateConversationTurnUnknownField,
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

function unknownTurnFields(message: Message): SlateConversationTurnUnknownField[] {
  return message.getType().runtime.bin.listUnknownFields(message).map(field => ({
    number: field.no,
    wireType: field.wireType,
    dataHex: toHex(field.data),
  }))
}

function applyUnknownTurnFields(message: Message, fields: readonly SlateConversationTurnUnknownField[] | undefined): void {
  for (const field of fields ?? []) {
    message.getType().runtime.bin.onUnknownField(
      message,
      field.number,
      field.wireType as Parameters<typeof ConversationTurnStructure.runtime.bin.onUnknownField>[2],
      fromHex(field.dataHex),
    )
  }
}

/** Projects the historical persisted envelope into Slate's turn vocabulary. */
export function fromInteropConversationTurn(
  value: InstanceType<typeof ConversationTurnStructure>,
): SlateConversationTurn {
  const envelopeUnknownFields = unknownTurnFields(value)
  switch (value.turn.case) {
    case "agentConversationTurn": {
      const payloadUnknownFields = unknownTurnFields(value.turn.value)
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
        ...((envelopeUnknownFields.length === 0 && payloadUnknownFields.length === 0)
          ? {}
          : { compatibility: {
              ...(envelopeUnknownFields.length === 0 ? {} : { envelopeUnknownFields }),
              ...(payloadUnknownFields.length === 0 ? {} : { payloadUnknownFields }),
            } }),
      })
    }
    case "shellConversationTurn": {
      const payloadUnknownFields = unknownTurnFields(value.turn.value)
      return createSlateShellConversationTurn({
        shellCommandBlobId: value.turn.value.shellCommand,
        shellOutputBlobId: value.turn.value.shellOutput,
        ...((envelopeUnknownFields.length === 0 && payloadUnknownFields.length === 0)
          ? {}
          : { compatibility: {
              ...(envelopeUnknownFields.length === 0 ? {} : { envelopeUnknownFields }),
              ...(payloadUnknownFields.length === 0 ? {} : { payloadUnknownFields }),
            } }),
      })
    }
    default:
      throw new Error("Invalid ConversationTurnStructure: missing turn case")
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
      shellCommandBlobId: value.shellCommandBlobId,
      shellOutputBlobId: value.shellOutputBlobId,
    })
    outer = wrapShellConversationTurnInterop(shellTurn)
    payload = shellTurn
  }
  applyUnknownTurnFields(outer, value.compatibility?.envelopeUnknownFields)
  applyUnknownTurnFields(payload, value.compatibility?.payloadUnknownFields)
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

function isTurnUnknownFields(value: unknown): value is SlateConversationTurnUnknownField[] {
  return Array.isArray(value) && value.every(field =>
    field !== null && typeof field === "object" && !Array.isArray(field) &&
    hasOnlyKeys(field as Record<string, unknown>, ["number", "wireType", "dataHex"]) &&
    Number.isSafeInteger((field as Record<string, unknown>).number) &&
    ((field as Record<string, unknown>).number as number) > 0 &&
    ((field as Record<string, unknown>).number as number) <= 536_870_911 &&
    Number.isSafeInteger((field as Record<string, unknown>).wireType) &&
    ((field as Record<string, unknown>).wireType as number) >= 0 &&
    ((field as Record<string, unknown>).wireType as number) <= 5 &&
    isHexId((field as Record<string, unknown>).dataHex))
}

function isTurnCompatibility(value: unknown): value is SlateConversationTurnCompatibility {
  if (value === undefined) return true
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const compatibility = value as Record<string, unknown>
  return hasOnlyKeys(compatibility, ["envelopeUnknownFields", "payloadUnknownFields"]) &&
    (compatibility.envelopeUnknownFields === undefined || isTurnUnknownFields(compatibility.envelopeUnknownFields)) &&
    (compatibility.payloadUnknownFields === undefined || isTurnUnknownFields(compatibility.payloadUnknownFields))
}

function isSlateTurnEnvelope(value: unknown): value is {
  readonly format: typeof SLATE_TURN_FORMAT
  readonly version: 1
  readonly turn: Record<string, unknown>
  readonly compatibility?: SlateConversationTurnCompatibility
} {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const envelope = value as Record<string, unknown>
  if (!hasOnlyKeys(envelope, ["format", "version", "turn", "compatibility"]) ||
      envelope.format !== SLATE_TURN_FORMAT || envelope.version !== 1 ||
      envelope.turn === null || typeof envelope.turn !== "object" || Array.isArray(envelope.turn) ||
      !isTurnCompatibility(envelope.compatibility)) return false
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
    return hasOnlyKeys(turn, ["kind", "shellCommandBlobId", "shellOutputBlobId"]) &&
      isHexId(turn.shellCommandBlobId) && isHexId(turn.shellOutputBlobId)
  }
  return false
}

function turnCompatibilityFromEnvelope(value: SlateConversationTurnCompatibility): SlateConversationTurnCompatibility {
  return {
    ...(value.envelopeUnknownFields === undefined ? {} : { envelopeUnknownFields: value.envelopeUnknownFields.map(field => ({ ...field })) }),
    ...(value.payloadUnknownFields === undefined ? {} : { payloadUnknownFields: value.payloadUnknownFields.map(field => ({ ...field })) }),
  }
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
        shellCommandBlobId: toHex(value.shellCommandBlobId),
        shellOutputBlobId: toHex(value.shellOutputBlobId),
      }
  const envelope = {
    format: SLATE_TURN_FORMAT,
    version: 1,
    turn,
    ...(value.compatibility === undefined ? {} : { compatibility: turnCompatibilityFromEnvelope(value.compatibility) }),
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
      ...(parsed.compatibility === undefined ? {} : { compatibility: turnCompatibilityFromEnvelope(parsed.compatibility) }),
    })
  }
  return createSlateShellConversationTurn({
    shellCommandBlobId: fromHex(turn.shellCommandBlobId as string),
    shellOutputBlobId: fromHex(turn.shellOutputBlobId as string),
    ...(parsed.compatibility === undefined ? {} : { compatibility: turnCompatibilityFromEnvelope(parsed.compatibility) }),
  })
}

/** Writes new turns in Slate's own versioned format and imports legacy Proto turn blobs on read. */
export const slateConversationTurnSerde: SlateConversationTurnSerde = {
  serialize(value) {
    return serializeSlateConversationTurn(value)
  },
  deserialize(bytes) {
    return deserializeSlateConversationTurn(bytes) ?? fromInteropConversationTurn(ConversationTurnStructure.fromBinary(bytes))
  },
  getBlobType() {
    return { ...slateConversationTurnBlobType }
  },
}
