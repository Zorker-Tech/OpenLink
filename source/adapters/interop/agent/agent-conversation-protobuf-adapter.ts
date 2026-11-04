import { isMessage, type FieldInfo, type Message } from "@bufbuild/protobuf"
import {
  AgentConversationTurn,
  ConversationState,
  ConversationStateStructure,
  ConversationStep,
  ConversationSummary,
  ConversationTurn,
  ShellCommand,
  ShellConversationTurn,
  ShellOutput,
  SubagentPersistedState,
  UserMessage,
  type ConversationState as ConversationStateMessage,
} from "../proto/generated/agent/v1/agent_pb.ts"
import { TodoItem } from "../proto/generated/agent/v1/todo_tool_pb.ts"
import { ProtobufBlobSerde } from "./protobuf-blob-serde-adapter.ts"
import { slateConversationTurnSerde } from "./agent-conversation-state-serdes-adapter.ts"
import type {
  AgentConversationCodec,
  ConversationBlobReader,
  PersistedAgentSubconversation,
} from "../../../packages/agent-kv/agent-conversation-store-contracts.ts"
import {
  deserializeSlateAgentCheckpoint,
  serializeSlateAgentCheckpointV2,
  type AgentCheckpointJsonObject,
} from "../../../packages/agent-kv/agent-checkpoint-schema.ts"
import { fromHex, toHex } from "../../../packages/agent-kv/serde.ts"
import { resolveSubagentPersistedStates } from "../../../packages/agent-kv/subagent-states.ts"
import {
  isSlateConversationCheckpointV2,
  type SlateCheckpointUnknownField,
} from "../../../packages/agent/conversation-checkpoint-state.ts"
import {
  interopConversationCheckpointFromSlate,
  slateConversationCheckpointFromInterop,
} from "./slate-agent-checkpoint-interop-adapter.ts"

const todoItemSerde = new ProtobufBlobSerde(TodoItem)
const userMessageSerde = new ProtobufBlobSerde(UserMessage)
const conversationStepSerde = new ProtobufBlobSerde(ConversationStep)
const conversationSummarySerde = new ProtobufBlobSerde(ConversationSummary)
const shellCommandSerde = new ProtobufBlobSerde(ShellCommand)
const shellOutputSerde = new ProtobufBlobSerde(ShellOutput)
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
        if (stepBlob) steps.push(conversationStepSerde.deserialize(stepBlob))
      }
      turn = new ConversationTurn({
        turn: {
          case: "agentConversationTurn",
          value: new AgentConversationTurn({ userMessage: userMessageSerde.deserialize(userMessageBlob), steps }),
        },
      })
    } else {
      const shellCommandBlob = await blobStore.getBlob(ctx, turnStructure.shellCommandBlobId)
      if (!shellCommandBlob) continue
      const shellOutputBlob = await blobStore.getBlob(ctx, turnStructure.shellOutputBlobId)
      if (!shellOutputBlob) continue
      turn = new ConversationTurn({
        turn: {
          case: "shellConversationTurn",
          value: new ShellConversationTurn({
            shellCommand: shellCommandSerde.deserialize(shellCommandBlob),
            shellOutput: shellOutputSerde.deserialize(shellOutputBlob),
          }),
        },
      })
    }
    if (turn) turns.push(turn)
  }
  state.turns = turns

  const todos: InstanceType<typeof TodoItem>[] = []
  for (const todoBlobId of structure.todos) {
    const todoBlob = await blobStore.getBlob(ctx, todoBlobId)
    if (todoBlob) todos.push(todoItemSerde.deserialize(todoBlob))
  }
  state.todos = todos
  if (structure.summary) {
    const summaryBlob = await blobStore.getBlob(ctx, structure.summary)
    if (summaryBlob) state.summary = conversationSummarySerde.deserialize(summaryBlob)
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
    const checkpoint = interopConversationCheckpointFromSlate(slateCheckpoint.conversation)
    restoreUnknownFields(
      checkpoint,
      slateCheckpoint.conversation.compatibility?.legacyUnknownFields,
    )
    return checkpoint
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
  ConversationStateStructure,
  ConversationStateMessage
> {
  return {
    createEmptyCheckpoint: () => new ConversationStateStructure(),
    encodeCheckpoint: encodeInteropAgentConversationCheckpoint,
    decodeCheckpoint: decodeInteropAgentConversationCheckpoint,
    async getLastRequestId(ctx, checkpoint, blobStore) {
      for (let index = checkpoint.turns.length - 1; index >= 0; index -= 1) {
        const turnBlob = await blobStore.getBlob(ctx, checkpoint.turns[index]!)
        if (!turnBlob) continue
        const turnStructure = turnValueOrUndefined(turnBlob)
        if (turnStructure === undefined) continue
        if (turnStructure.kind === "agent") {
          return turnStructure.requestId ?? null
        }
      }
      return null
    },
    hydrateConversation: deriveInteropConversationStateFromStructure,
    async resolveSubconversations(ctx, checkpoint, blobStore) {
      const states = await resolveSubagentPersistedStates(
        ctx,
        checkpoint,
        blobStore,
        bytes => SubagentPersistedState.fromBinary(bytes),
      )
      return states as Record<string, PersistedAgentSubconversation<ConversationStateStructure>>
    },
  }
}

/** Compatibility export for callers that have not yet renamed their codec wiring. */
export const createProtobufAgentConversationCodec = createSlateAgentConversationCodec
