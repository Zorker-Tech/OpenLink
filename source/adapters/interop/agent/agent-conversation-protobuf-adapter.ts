import {
  AgentConversationTurn,
  ConversationState,
  ConversationStateStructure,
  ConversationStep,
  ConversationTurn,
  ShellConversationTurn,
  type ConversationState as ConversationStateMessage,
} from "../proto/generated/agent/v1/agent_pb.ts"
import { slateConversationTurnSerde } from "./agent-conversation-state-serdes-adapter.ts"
import {
  deserializeSlateConversationStepInterop,
  deserializeSlateSubagentPersistedStateInterop,
  deserializeSlateShellInvocationInterop,
  deserializeSlateShellResultInterop,
  deserializeSlateUserMessageInterop,
  deserializeSlateTodoItemInterop,
  createSlateConversationStepSerde,
  createSlateUserMessageSerde,
} from "./agent-state-message-serdes-adapter.ts"
import { createSlateConversationSummarySerde, deserializeSlateConversationSummaryInterop } from "./conversation-summary-storage-adapter.ts"
import { createSlateTodoItemSerde } from "./todo-schema-adapter.ts"
import { createSlateShellInvocationSerde, createSlateShellResultSerde } from "../../storage/agent/shell-state-storage-adapter.ts"
import { PrivacyMode as PrivacyModes } from "../../../packages/redaction/privacy-mode.ts"
import type {
  AgentConversationCodec,
  ConversationBlobReader,
} from "../../../packages/agent-kv/agent-conversation-store-contracts.ts"
import {
  deserializeSlateAgentCheckpoint,
  serializeSlateAgentCheckpointV2,
  type AgentCheckpointJsonObject,
} from "../../../packages/agent-kv/agent-checkpoint-schema.ts"
import { fromHex } from "../../../packages/agent-kv/serde.ts"
import { resolveSubagentPersistedStates } from "../../../packages/agent-kv/subagent-states.ts"
import {
  createEmptySlateConversationCheckpointV2,
  isSlateConversationCheckpointV2,
  type SlateConversationCheckpointV2,
} from "../../../packages/agent/conversation-checkpoint-state.ts"
import {
  slateCheckpointSubagentFromInterop,
  interopConversationCheckpointFromSlate,
  slateConversationCheckpointFromInterop,
} from "./slate-agent-checkpoint-interop-adapter.ts"
import type { SlateHydratedConversation, SlateHydratedConversationTurn } from "../../../packages/agent/conversation-transcript-state.ts"

function turnValueOrUndefined(bytes: Uint8Array) {
  try {
    return slateConversationTurnSerde.deserialize(bytes)
  } catch (error) {
    if (error instanceof Error && error.message === "Slate conversation turn record is unsupported or invalid") {
      return undefined
    }
    throw error
  }
}

/** Hydrates the persisted tree into the protocol view expected by the existing agent runtime. */
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
  const conversation = slateConversationCheckpointFromInterop(checkpoint, [])
  if (!isSlateConversationCheckpointV2(conversation)) {
    throw new TypeError("Conversation checkpoint cannot be represented by Slate's version 2 schema")
  }
  return serializeSlateAgentCheckpointV2(conversation as unknown as AgentCheckpointJsonObject)
}

/** Reads a Slate v2 root into the runner's current interop view. */
export function decodeInteropAgentConversationCheckpoint(bytes: Uint8Array): ConversationStateStructure {
  const slateCheckpoint = deserializeSlateAgentCheckpoint(bytes)
  if (slateCheckpoint?.version !== 2 || !isSlateConversationCheckpointV2(slateCheckpoint.conversation)) {
    throw new TypeError("Slate conversation checkpoint state is invalid")
  }
  return interopAgentConversationCheckpointFromSlate(slateCheckpoint.conversation)
}

/** Writes a product-owned V2 checkpoint as the canonical durable root. */
export function encodeSlateAgentConversationCheckpoint(checkpoint: SlateConversationCheckpointV2): Uint8Array {
  if (!isSlateConversationCheckpointV2(checkpoint)) {
    throw new TypeError("Slate conversation checkpoint is invalid")
  }
  return serializeSlateAgentCheckpointV2(checkpoint as unknown as AgentCheckpointJsonObject)
}

/** Reads a Slate v2 checkpoint root. */
export function decodeSlateAgentConversationCheckpoint(bytes: Uint8Array): SlateConversationCheckpointV2 {
  const root = deserializeSlateAgentCheckpoint(bytes)
  if (root?.version !== 2 || !isSlateConversationCheckpointV2(root.conversation)) {
    throw new TypeError("Slate conversation checkpoint state is invalid")
  }
  return root.conversation
}

/** Projects V2 to the old runner message only at a named interoperability boundary. */
export function interopAgentConversationCheckpointFromSlate(
  checkpoint: SlateConversationCheckpointV2,
): ConversationStateStructure {
  if (!isSlateConversationCheckpointV2(checkpoint)) {
    throw new TypeError("Slate conversation checkpoint state is invalid")
  }
  return interopConversationCheckpointFromSlate(checkpoint)
}

/** Hydrates Slate's versioned references directly into Slate conversation-domain values. */
export async function deriveSlateConversationFromCheckpoint<Context>(
  ctx: Context,
  checkpoint: SlateConversationCheckpointV2,
  blobStore: ConversationBlobReader<Context>,
): Promise<SlateHydratedConversation> {
  if (!isSlateConversationCheckpointV2(checkpoint)) {
    throw new TypeError("Slate conversation checkpoint state is invalid")
  }
  const userMessageSerde = createSlateUserMessageSerde(PrivacyModes.UNSPECIFIED)
  const stepSerde = createSlateConversationStepSerde(PrivacyModes.UNSPECIFIED)
  const shellInvocationSerde = createSlateShellInvocationSerde(PrivacyModes.UNSPECIFIED)
  const shellResultSerde = createSlateShellResultSerde(PrivacyModes.UNSPECIFIED)
  const todoSerde = createSlateTodoItemSerde(PrivacyModes.UNSPECIFIED)
  const summarySerde = createSlateConversationSummarySerde(PrivacyModes.UNSPECIFIED)
  const turns: SlateHydratedConversationTurn[] = []

  for (const turnHex of checkpoint.turnBlobIds) {
    const turnBytes = await blobStore.getBlob(ctx, fromHex(turnHex))
    if (turnBytes === undefined) continue
    const turn = turnValueOrUndefined(turnBytes)
    if (turn === undefined) continue

    if (turn.kind === "agent") {
      const userMessageBytes = await blobStore.getBlob(ctx, turn.userMessageBlobId)
      if (userMessageBytes === undefined) continue
      const steps: ReturnType<typeof stepSerde.deserialize>[] = []
      for (const stepBlobId of turn.stepBlobIds) {
        const stepBytes = await blobStore.getBlob(ctx, stepBlobId)
        if (stepBytes !== undefined) steps.push(stepSerde.deserialize(stepBytes))
      }
      turns.push({
        kind: "agent",
        userMessage: userMessageSerde.deserialize(userMessageBytes),
        steps,
      })
      continue
    }

    const invocationBytes = await blobStore.getBlob(ctx, turn.invocationBlobId)
    if (invocationBytes === undefined) continue
    const resultBytes = await blobStore.getBlob(ctx, turn.resultBlobId)
    if (resultBytes === undefined) continue
    turns.push({
      kind: "shell",
      invocation: shellInvocationSerde.deserialize(invocationBytes),
      result: shellResultSerde.deserialize(resultBytes),
    })
  }

  const todos: ReturnType<typeof todoSerde.deserialize>[] = []
  for (const todoHex of checkpoint.todoBlobIds) {
    const todoBytes = await blobStore.getBlob(ctx, fromHex(todoHex))
    if (todoBytes !== undefined) todos.push(todoSerde.deserialize(todoBytes))
  }

  const summaryBytes = checkpoint.summaryBlobId === undefined
    ? undefined
    : await blobStore.getBlob(ctx, fromHex(checkpoint.summaryBlobId))
  return {
    turns,
    todos,
    ...(summaryBytes === undefined ? {} : { summary: summarySerde.deserialize(summaryBytes) }),
  }
}

/** Owns Slate checkpoint persistence and adapts restored roots to the current runner view. */
export function createSlateAgentConversationCodec<Context>(): AgentConversationCodec<
  Context,
  SlateConversationCheckpointV2,
  SlateHydratedConversation
> {
  return {
    createEmptyCheckpoint: createEmptySlateConversationCheckpointV2,
    normalizeCheckpoint(value) {
      if (isSlateConversationCheckpointV2(value)) return value
      throw new TypeError("Agent conversation checkpoint must be a Slate V2 checkpoint")
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
    hydrateConversation: deriveSlateConversationFromCheckpoint,
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
