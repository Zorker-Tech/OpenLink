import { isMessage, type FieldInfo, type Message } from "@bufbuild/protobuf"
import {
  AgentConversationTurn,
  ConversationState,
  ConversationStateStructure,
  ConversationStep,
  ConversationTurn,
  ShellConversationTurn,
  type ConversationState as ConversationStateMessage,
} from "../proto/generated/agent/v1/agent_pb.ts"
import { ProtobufBlobSerde } from "./protobuf-blob-serde-adapter.ts"
import { slateConversationTurnSerde } from "./agent-conversation-state-serdes-adapter.ts"
import {
  deserializeSlateConversationStepInterop,
  deserializeSlateSubagentPersistedStateInterop,
  deserializeSlateShellInvocationInterop,
  deserializeSlateShellResultInterop,
  deserializeSlateUserMessageInterop,
  deserializeSlateTodoItemInterop,
} from "./agent-state-message-serdes-adapter.ts"
import { deserializeSlateConversationSummaryInterop } from "./conversation-summary-storage-adapter.ts"
import type {
  AgentConversationCodec,
  ConversationBlobReader,
} from "../../../packages/agent-kv/agent-conversation-store-contracts.ts"
import {
  deserializeSlateAgentCheckpoint,
  serializeSlateAgentCheckpointV2,
  type AgentCheckpointJsonObject,
} from "../../../packages/agent-kv/agent-checkpoint-schema.ts"
import { fromHex, toHex } from "../../../packages/agent-kv/serde.ts"
import { resolveSubagentPersistedStates } from "../../../packages/agent-kv/subagent-states.ts"
import {
  createEmptySlateConversationCheckpointV2,
  isSlateConversationCheckpointV2,
  type SlateConversationCheckpointV2,
  type SlateCheckpointUnknownField,
} from "../../../packages/agent/conversation-checkpoint-state.ts"
import {
  slateCheckpointSubagentFromInterop,
  interopConversationCheckpointFromSlate,
  slateConversationCheckpointFromInterop,
} from "./slate-agent-checkpoint-interop-adapter.ts"

const checkpointSerde = new ProtobufBlobSerde(ConversationStateStructure)
const PRESERVED_UNKNOWN_FIELDS_KEY = "$slateInteropUnknownFields"

function turnValueOrUndefined(bytes: Uint8Array) {
  try {
    return slateConversationTurnSerde.deserialize(bytes)
  } catch (error) {
    if (error instanceof Error && error.message === "Invalid ConversationTurnStructure: missing turn case") {
      return undefined
    }
    throw error
  }
}

type UnknownFieldPathStep = { readonly field: string } | { readonly index: number } | { readonly key: string }

interface PreservedUnknownField {
  readonly path: readonly UnknownFieldPathStep[]
  readonly number: number
  readonly wireType: number
  readonly dataHex: string
}

function protoFieldValue(message: Message, field: FieldInfo): unknown {
  const record = message as unknown as Record<string, unknown>
  if (field.oneof == null) return record[field.localName]
  const selection = record[field.oneof.localName]
  if (selection == null || typeof selection !== "object") return undefined
  const selected = selection as { readonly case?: unknown; readonly value?: unknown }
  return selected.case === field.localName ? selected.value : undefined
}

function collectUnknownFields(message: Message): PreservedUnknownField[] {
  const preserved: PreservedUnknownField[] = []

  function visit(current: Message, path: readonly UnknownFieldPathStep[]): void {
    for (const field of current.getType().runtime.bin.listUnknownFields(current)) {
      preserved.push({ path, number: field.no, wireType: field.wireType, dataHex: toHex(field.data) })
    }

    for (const field of current.getType().fields.list()) {
      const value = protoFieldValue(current, field)
      if (value == null) continue
      if (field.kind === "message") {
        if (field.repeated && Array.isArray(value)) {
          for (const [index, child] of value.entries()) {
            if (isMessage(child)) visit(child, [...path, { field: field.localName }, { index }])
          }
        } else if (!field.repeated && isMessage(value)) {
          visit(value, [...path, { field: field.localName }])
        }
      } else if (field.kind === "map" && field.V.kind === "message" && typeof value === "object") {
        for (const [key, child] of Object.entries(value)) {
          if (isMessage(child)) visit(child, [...path, { field: field.localName }, { key }])
        }
      }
    }
  }

  visit(message, [])
  return preserved
}

function parseUnknownFieldPathStep(value: unknown): UnknownFieldPathStep {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Slate checkpoint unknown-field path is invalid")
  }
  const record = value as Record<string, unknown>
  if (typeof record.field === "string") return { field: record.field }
  if (typeof record.index === "number" && Number.isSafeInteger(record.index) && record.index >= 0) {
    return { index: record.index }
  }
  if (typeof record.key === "string") return { key: record.key }
  throw new TypeError("Slate checkpoint unknown-field path step is invalid")
}

function parsePreservedUnknownField(value: unknown): PreservedUnknownField {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Slate checkpoint unknown field is invalid")
  }
  const record = value as Record<string, unknown>
  if (
    !Array.isArray(record.path) ||
    typeof record.number !== "number" || !Number.isSafeInteger(record.number) || record.number < 1 ||
    typeof record.wireType !== "number" || !Number.isInteger(record.wireType) || record.wireType < 0 || record.wireType > 5 ||
    typeof record.dataHex !== "string" || !/^(?:[0-9a-f]{2})*$/.test(record.dataHex)
  ) {
    throw new TypeError("Slate checkpoint unknown field metadata is invalid")
  }
  return {
    path: record.path.map(parseUnknownFieldPathStep),
    number: record.number,
    wireType: record.wireType,
    dataHex: record.dataHex,
  }
}

function messageAtUnknownFieldPath(root: Message, path: readonly UnknownFieldPathStep[]): Message {
  let value: unknown = root
  for (const step of path) {
    if ("field" in step) {
      if (!isMessage(value)) throw new TypeError("Slate checkpoint unknown-field parent is invalid")
      const field = value.getType().fields.list().find(candidate => candidate.localName === step.field)
      if (field === undefined) throw new TypeError("Slate checkpoint unknown-field target is not in this runtime")
      value = protoFieldValue(value, field)
    } else if ("index" in step) {
      value = Array.isArray(value) ? value[step.index] : undefined
    } else {
      value = value != null && typeof value === "object" ? (value as Record<string, unknown>)[step.key] : undefined
    }
  }
  if (!isMessage(value)) throw new TypeError("Slate checkpoint unknown-field target is missing")
  return value
}

/** Hydrates the legacy persisted tree into the protocol view expected by the existing agent runtime. */
export async function deriveInteropConversationStateFromStructure<Context>(
  ctx: Context,
  structure: ConversationStateStructure,
  blobStore: ConversationBlobReader<Context>,
): Promise<ConversationStateMessage> {
  const state = new ConversationState()
  const turns: InstanceType<typeof ConversationTurn>[] = []
  for (const turnBlobId of structure.turns) {
    const turnBlob = await blobStore.getBlob(ctx, turnBlobId)
    if (!turnBlob) continue
    const turnStructure = turnValueOrUndefined(turnBlob)
    if (turnStructure === undefined) continue
    let turn: InstanceType<typeof ConversationTurn> | undefined
    if (turnStructure.kind === "agent") {
      const userMessageBlob = await blobStore.getBlob(ctx, turnStructure.userMessageBlobId)
      if (!userMessageBlob) continue
      const steps: InstanceType<typeof ConversationStep>[] = []
      for (const stepBlobId of turnStructure.stepBlobIds) {
        const stepBlob = await blobStore.getBlob(ctx, stepBlobId)
        if (stepBlob) steps.push(deserializeSlateConversationStepInterop(stepBlob))
      }
      turn = new ConversationTurn({
        turn: {
          case: "agentConversationTurn",
          value: new AgentConversationTurn({ userMessage: deserializeSlateUserMessageInterop(userMessageBlob), steps }),
        },
      })
    } else {
      const invocationBlob = await blobStore.getBlob(ctx, turnStructure.invocationBlobId)
      if (!invocationBlob) continue
      const resultBlob = await blobStore.getBlob(ctx, turnStructure.resultBlobId)
      if (!resultBlob) continue
      turn = new ConversationTurn({
        turn: {
          case: "shellConversationTurn",
          value: new ShellConversationTurn({
            shellCommand: deserializeSlateShellInvocationInterop(invocationBlob),
            shellOutput: deserializeSlateShellResultInterop(resultBlob),
          }),
        },
      })
    }
    if (turn) turns.push(turn)
  }
  state.turns = turns

  const todos: ConversationStateMessage["todos"] = []
  for (const todoBlobId of structure.todos) {
    const todoBlob = await blobStore.getBlob(ctx, todoBlobId)
    if (todoBlob) todos.push(deserializeSlateTodoItemInterop(todoBlob))
  }
  state.todos = todos
  if (structure.summary) {
    const summaryBlob = await blobStore.getBlob(ctx, structure.summary)
    if (summaryBlob) state.summary = deserializeSlateConversationSummaryInterop(summaryBlob)
  }
  return state
}

/** Projects the runner snapshot into the complete Slate v2 durable conversation schema. */
export function encodeInteropAgentConversationCheckpoint(checkpoint: ConversationStateStructure): Uint8Array {
  const unknownFields = collectUnknownFields(checkpoint)
  const conversation = slateConversationCheckpointFromInterop(checkpoint, unknownFields)
  if (!isSlateConversationCheckpointV2(conversation)) {
    throw new TypeError("Conversation checkpoint cannot be represented by Slate's version 2 schema")
  }
  return serializeSlateAgentCheckpointV2(conversation as unknown as AgentCheckpointJsonObject)
}

/** Reads Slate roots and the legacy root encoding into the runner's current interop view. */
export function decodeInteropAgentConversationCheckpoint(bytes: Uint8Array): ConversationStateStructure {
  const slateCheckpoint = deserializeSlateAgentCheckpoint(bytes)
  if (slateCheckpoint === undefined) return checkpointSerde.deserialize(bytes)

  if (slateCheckpoint.version === 2) {
    if (!isSlateConversationCheckpointV2(slateCheckpoint.conversation)) {
      throw new TypeError("Slate conversation checkpoint state is invalid")
    }
    return interopAgentConversationCheckpointFromSlate(slateCheckpoint.conversation)
  }

  const interopSnapshot = { ...slateCheckpoint.interopSnapshot } as Record<string, unknown>
  const rawUnknownFields = interopSnapshot[PRESERVED_UNKNOWN_FIELDS_KEY]
  delete interopSnapshot[PRESERVED_UNKNOWN_FIELDS_KEY]
  const checkpoint = ConversationStateStructure.fromJson(
    interopSnapshot as Parameters<typeof ConversationStateStructure.fromJson>[0],
  )
  checkpoint.turns = slateCheckpoint.conversation.turnBlobIds.map(fromHex)
  checkpoint.todos = slateCheckpoint.conversation.todoBlobIds.map(fromHex)
  checkpoint.summaryArchives = slateCheckpoint.conversation.summaryArchiveBlobIds.map(fromHex)
  if (slateCheckpoint.conversation.summaryBlobId !== undefined) {
    checkpoint.summary = fromHex(slateCheckpoint.conversation.summaryBlobId)
  }
  if (slateCheckpoint.conversation.summaryArchiveBlobId !== undefined) {
    checkpoint.summaryArchive = fromHex(slateCheckpoint.conversation.summaryArchiveBlobId)
  }
  restoreUnknownFields(checkpoint, rawUnknownFields)
  return checkpoint
}

/** Writes a product-owned V2 checkpoint as the canonical durable root. */
export function encodeSlateAgentConversationCheckpoint(checkpoint: SlateConversationCheckpointV2): Uint8Array {
  if (!isSlateConversationCheckpointV2(checkpoint)) {
    throw new TypeError("Slate conversation checkpoint is invalid")
  }
  return serializeSlateAgentCheckpointV2(checkpoint as unknown as AgentCheckpointJsonObject)
}

/** Reads V2 directly and migrates V1 or protobuf roots into the Slate-owned checkpoint model. */
export function decodeSlateAgentConversationCheckpoint(bytes: Uint8Array): SlateConversationCheckpointV2 {
  const root = deserializeSlateAgentCheckpoint(bytes)
  if (root?.version === 2) {
    if (!isSlateConversationCheckpointV2(root.conversation)) {
      throw new TypeError("Slate conversation checkpoint state is invalid")
    }
    return root.conversation
  }
  const legacy = decodeInteropAgentConversationCheckpoint(bytes)
  const checkpoint = slateConversationCheckpointFromInterop(legacy, collectUnknownFields(legacy))
  if (!isSlateConversationCheckpointV2(checkpoint)) {
    throw new TypeError("Legacy conversation checkpoint cannot be represented by Slate's version 2 schema")
  }
  return checkpoint
}

/** Projects V2 to the old runner message only at a named interoperability boundary. */
export function interopAgentConversationCheckpointFromSlate(
  checkpoint: SlateConversationCheckpointV2,
): ConversationStateStructure {
  if (!isSlateConversationCheckpointV2(checkpoint)) {
    throw new TypeError("Slate conversation checkpoint state is invalid")
  }
  const interop = interopConversationCheckpointFromSlate(checkpoint)
  restoreUnknownFields(interop, checkpoint.compatibility?.legacyUnknownFields)
  return interop
}

function restoreUnknownFields(checkpoint: ConversationStateStructure, raw: unknown): void {
  if (raw === undefined) return
  if (!Array.isArray(raw)) throw new TypeError("Slate checkpoint unknown fields are invalid")
  for (const value of raw) {
    const unknownField = parsePreservedUnknownField(value as SlateCheckpointUnknownField)
    ConversationStateStructure.runtime.bin.onUnknownField(
      messageAtUnknownFieldPath(checkpoint, unknownField.path),
      unknownField.number,
      unknownField.wireType as Parameters<typeof ConversationStateStructure.runtime.bin.onUnknownField>[2],
      fromHex(unknownField.dataHex),
    )
  }
}

/** Owns Slate checkpoint persistence and adapts restored roots to the current runner view. */
export function createSlateAgentConversationCodec<Context>(): AgentConversationCodec<
  Context,
  SlateConversationCheckpointV2,
  ConversationStateMessage
> {
  return {
    createEmptyCheckpoint: createEmptySlateConversationCheckpointV2,
    normalizeCheckpoint(value) {
      if (isSlateConversationCheckpointV2(value)) return value
      if (value instanceof ConversationStateStructure) {
        return slateConversationCheckpointFromInterop(value, collectUnknownFields(value))
      }
      throw new TypeError("Agent conversation checkpoint must be Slate V2 or a legacy runner structure")
    },
    encodeCheckpoint: encodeSlateAgentConversationCheckpoint,
    decodeCheckpoint: decodeSlateAgentConversationCheckpoint,
    async getLastRequestId(ctx, checkpoint, blobStore) {
      for (let index = checkpoint.turnBlobIds.length - 1; index >= 0; index -= 1) {
        const turnBlob = await blobStore.getBlob(ctx, fromHex(checkpoint.turnBlobIds[index]!))
        if (!turnBlob) continue
        const turnStructure = turnValueOrUndefined(turnBlob)
        if (turnStructure === undefined) continue
        if (turnStructure.kind === "agent") {
          return turnStructure.requestId ?? null
        }
      }
      return null
    },
    async hydrateConversation(ctx, checkpoint, blobStore) {
      return deriveInteropConversationStateFromStructure(
        ctx,
        interopAgentConversationCheckpointFromSlate(checkpoint),
        blobStore,
      )
    },
    async resolveSubconversations(ctx, checkpoint, blobStore) {
      const interopCheckpoint = interopAgentConversationCheckpointFromSlate(checkpoint)
      const states = await resolveSubagentPersistedStates(
        ctx,
        interopCheckpoint,
        blobStore,
        deserializeSlateSubagentPersistedStateInterop,
      )
      return Object.fromEntries(Object.entries(states).map(([subagentId, state]) => {
        const subagent = slateCheckpointSubagentFromInterop(state)
        return [subagentId, {
          ...(subagent.conversation === undefined ? {} : { conversationState: subagent.conversation }),
          createdTimestampMs: BigInt(subagent.createdAtMs),
          lastUsedTimestampMs: BigInt(subagent.lastUsedAtMs),
          ...(subagent.type === undefined ? {} : { subagentType: subagent.type }),
        }] as const
      }))
    },
  }
}

/** Compatibility export for callers that have not yet renamed their codec wiring. */
export const createProtobufAgentConversationCodec = createSlateAgentConversationCodec
