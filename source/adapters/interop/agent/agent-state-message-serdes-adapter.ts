import {
  ConversationPlan,
  ConversationStateStructure,
  ConversationStep,
  ConversationSummary,
  ConversationSummaryArchive,
  GoalState,
  PlanRegistryEntry,
  AssistantMessage,
  CommunicateUpdateHistoryEntry,
  CommunicateUpdateTurnState,
  FileStateStructure,
  ShellCommand,
  ShellOutput,
  SubagentPersistedState,
  SubagentExecutionEnvironment,
  SubagentRunState,
  SubagentRunStatus,
  ThinkingMessage,
  ToolCall,
  UserMessage,
} from "../proto/generated/agent/v1/agent_pb.ts"
import { TodoItem } from "../proto/generated/agent/v1/todo_tool_pb.ts"
import { GoalStatus } from "../proto/generated/agent/v1/goal_tool_pb.ts"
import { SelectedContext } from "../proto/generated/agent/v1/selected_context_pb.ts"
import type { GitRepoInfo, RequestContext } from "../proto/generated/agent/v1/request_context_exec_pb.ts"
import {
  createRedactedConversationTokenDetails,
  fromRedactedConversationPlan,
  fromRedactedConversationStep,
  fromRedactedConversationSummary,
  fromRedactedConversationSummaryArchive,
  fromRedactedConversationStateStructure,
  fromRedactedConversationTokenDetails,
  fromRedactedCommunicateUpdateHistoryEntry,
  fromRedactedCommunicateUpdateTurnState,
  fromRedactedGoalState,
  fromRedactedPlanRegistryEntry,
  fromRedactedSubagentRunState,
  fromRedactedShellCommand,
  fromRedactedShellOutput,
  fromRedactedSubagentPersistedState,
  fromRedactedUserMessage,
  toRedactedConversationPlan,
  toRedactedConversationStep,
  toRedactedConversationSummary,
  toRedactedConversationSummaryArchive,
  toRedactedConversationStateStructure,
  toRedactedShellCommand,
  toRedactedShellOutput,
  toRedactedSubagentPersistedState,
  toRedactedUserMessage,
} from "../redacted-protos/generated/agent/v1/agent_redacted.ts"
import { fromRedactedTodoItem, toRedactedTodoItem } from "../redacted-protos/generated/agent/v1/todo_tool_redacted.ts"
import { DataClassification, PrivacyCapability } from "../../../packages/redaction/classification.ts"
import type { PrivacyMode } from "../../../packages/redaction/privacy-mode.ts"
import { createRedactedString } from "../../../packages/redaction/create.ts"
import { createRedactedProtoSerde } from "./redacted-protobuf-serde-adapter.ts"
import { conversationStateStructureSerde } from "./agent-conversation-state-serdes-adapter.ts"
import type { Serde } from "../../../packages/agent-kv/serde-contracts.ts"
import {
  createSlateAssistantMessageStep,
  createSlateThinkingMessageStep,
  createSlateToolCallStep,
  type SlateConversationStep,
} from "../../../packages/agent/conversation-step-state.ts"
import type {
  SlateConversationState,
  SlateRedactedValue,
} from "../../../packages/agent/conversation-state.ts"
import type { SlateConversationPlanState } from "../../../packages/agent/conversation-plan-state.ts"
import { SlateMode } from "../../../packages/agent/mode-processing.ts"
import { fromInteropAgentMode, toInteropAgentMode } from "./mode-processing-adapter.ts"
import {
  SlateGoalState,
  type SlatePlanRegistryEntry,
} from "../../../packages/agent/goal-state.ts"
import { SlateGoalStatus } from "../../../packages/agent-core/goal-continuation.ts"

export type RedactedAgentConversationStateInterop = ReturnType<typeof toRedactedConversationStateStructure>
export type AgentStateSelectedContextInterop = SelectedContext
export type AgentStateRequestContextInterop = RequestContext
export type AgentStateGitRepoInfoInterop = GitRepoInfo
export type AgentStateCommunicateHistoryEntryInterop = CommunicateUpdateHistoryEntry
export type AgentStateCommunicateTurnStateInterop = CommunicateUpdateTurnState
export type AgentGoalStateInterop = GoalState
export type AgentPlanRegistryEntryInterop = PlanRegistryEntry
export type AgentSubagentPersistedStateInterop = SubagentPersistedState
export type AgentSubagentRunStateInterop = SubagentRunState
export type RedactedToolCallInterop = {
  readonly hookAdditionalContexts?: readonly import("../proto/generated/agent/v1/hook_additional_context_pb.ts").HookAdditionalContext[]
  readonly toolCallId?: string
  readonly startedAtMs?: bigint
  readonly completedAtMs?: bigint
  readonly tool: {
    readonly case?: string | undefined
    readonly value?: unknown
  }
}

function entriesOfUnknownStringMap(value: unknown): readonly (readonly [unknown, unknown])[] {
  if (value instanceof Map) return [...value.entries()]
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return Object.entries(value)
  }
  return []
}

function redactedSafeMapKey(key: unknown, fieldName: string, privacyMode: PrivacyMode): unknown {
  return typeof key === "string"
    ? createRedactedString(key, DataClassification.SAFE, fieldName, privacyMode)
    : key
}

/** Repairs generated redaction maps whose decoder expects wrapped identity keys. */
function wrapRedactedConversationMapKeys(
  state: RedactedAgentConversationStateInterop,
  privacyMode: PrivacyMode,
): RedactedAgentConversationStateInterop {
  const snapshot = state as unknown as Record<string, unknown>
  const subagentStates = new Map(
    entriesOfUnknownStringMap(snapshot.subagentStates).map(([key, value]) => {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return [redactedSafeMapKey(key, "subagent_states", privacyMode), value] as const
      }
      const subagent = value as Record<string, unknown>
      const nestedConversation = subagent.conversationState
      return [
        redactedSafeMapKey(key, "subagent_states", privacyMode),
        nestedConversation !== null && typeof nestedConversation === "object" && !Array.isArray(nestedConversation)
          ? {
              ...subagent,
              conversationState: wrapRedactedConversationMapKeys(
                nestedConversation as RedactedAgentConversationStateInterop,
                privacyMode,
              ),
            }
          : subagent,
      ] as const
    }),
  )
  const plans = new Map(
    entriesOfUnknownStringMap(snapshot.plans).map(([key, value]) => [
      redactedSafeMapKey(key, "plans", privacyMode),
      value,
    ] as const),
  )
  const subagentThreads = new Map(
    entriesOfUnknownStringMap(snapshot.subagentThreads).map(([key, value]) => [
      redactedSafeMapKey(key, "subagent_threads", privacyMode),
      value,
    ] as const),
  )
  const communicateUpdateStatesByParentToolCallId = new Map(
    entriesOfUnknownStringMap(snapshot.communicateUpdateStatesByParentToolCallId).map(([key, value]) => [
      redactedSafeMapKey(key, "communicate_update_states_by_parent_tool_call_id", privacyMode),
      value,
    ] as const),
  )
  const subagentRunsByParentToolCallId = new Map(
    entriesOfUnknownStringMap(snapshot.subagentRunsByParentToolCallId).map(([key, value]) => [
      redactedSafeMapKey(key, "subagent_runs_by_parent_tool_call_id", privacyMode),
      value,
    ] as const),
  )
  const subagentStateRefs = new Map(
    entriesOfUnknownStringMap(snapshot.subagentStateRefs).map(([key, value]) => [
      redactedSafeMapKey(key, "subagent_state_refs", privacyMode),
      value,
    ] as const),
  )
  return {
    ...state,
    subagentStates,
    plans,
    subagentThreads,
    communicateUpdateStatesByParentToolCallId,
    subagentRunsByParentToolCallId,
    subagentStateRefs,
  } as RedactedAgentConversationStateInterop
}

function slateStringMapKey(value: unknown, fieldName: string): string {
  if (typeof value === "string") return value
  if (value !== null && typeof value === "object" && "unwrap" in value && typeof value.unwrap === "function") {
    return value.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED)
  }
  throw new TypeError(`conversation state ${fieldName} key must be a string`)
}

export function fromInteropConversationState(
  state: RedactedAgentConversationStateInterop,
): SlateConversationState {
  const {
    _privacyMode,
    mode,
    fileStatesV2,
    readPaths,
    subagentStates,
    plans,
    subagentThreads,
    ...fields
  } = state
  const slateMode = fromInteropAgentMode(mode) ?? SlateMode.UNSPECIFIED
  const fileBytes = (value: Uint8Array | { unwrap(purpose: PrivacyCapability): Uint8Array }): Uint8Array =>
    value instanceof Uint8Array
      ? new Uint8Array(value)
      : value.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED)
  return {
    ...fields,
    fileStatesV2: new Map(
      [...fileStatesV2].map(([path, fileState]) => [
        path.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED),
        {
          ...(fileState.content === undefined
            ? {}
            : {
                contentBlobId: fileBytes(fileState.content),
              }),
          ...(fileState.initialContent === undefined
            ? {}
            : {
                initialContentBlobId: fileBytes(fileState.initialContent),
              }),
        },
      ]),
    ),
    readPaths: readPaths.map(
      (path: SlateRedactedValue<string>) =>
        path.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED),
    ),
    subagentStates: new Map(
      entriesOfUnknownStringMap(subagentStates).map(([key, value]) => [
        slateStringMapKey(key, "subagentStates"),
        value,
      ]),
    ),
    plans: new Map(
      entriesOfUnknownStringMap(plans).map(([key, value]) => [
        slateStringMapKey(key, "plans"),
        value,
      ]),
    ),
    subagentThreads: new Map(
      entriesOfUnknownStringMap(subagentThreads).map(([key, value]) => [
        slateStringMapKey(key, "subagentThreads"),
        value,
      ]),
    ),
    privacyMode: _privacyMode,
    mode: slateMode,
    ...(toInteropAgentMode(slateMode) === mode ? {} : { unknownModeCode: mode }),
  } as SlateConversationState
}

export function toInteropConversationState(
  state: SlateConversationState,
): RedactedAgentConversationStateInterop {
  const {
    privacyMode,
    mode,
    unknownModeCode,
    fileStatesV2,
    readPaths,
    ...fields
  } = state
  const optionalFields = fields as typeof fields & Readonly<Record<string, unknown>>
  return {
    ...fields,
    pendingToolCalls: fields.pendingToolCalls ?? [],
    fileStates: optionalFields.fileStates ?? new Map(),
    turnTimings: optionalFields.turnTimings ?? [],
    fileStatesV2: new Map(
      [...fileStatesV2].map(([path, fileState]) => [
        createRedactedString(path, DataClassification.PATH, "path", privacyMode),
        {
          ...(fileState.contentBlobId === undefined
            ? {}
            : {
                content: new Uint8Array(fileState.contentBlobId),
              }),
          ...(fileState.initialContentBlobId === undefined
            ? {}
            : {
                initialContent: new Uint8Array(fileState.initialContentBlobId),
              }),
        },
      ]),
    ),
    subagentStates: fields.subagentStates ?? new Map(),
    plans: fields.plans ?? new Map(),
    trackedGitRepoBranches: fields.trackedGitRepoBranches ?? [],
    communicateUpdateHistory: fields.communicateUpdateHistory ?? [],
    subagentThreads: fields.subagentThreads ?? new Map(),
    communicateUpdateStatesByParentToolCallId: fields.communicateUpdateStatesByParentToolCallId ?? new Map(),
    subagentRunsByParentToolCallId: fields.subagentRunsByParentToolCallId ?? new Map(),
    subagentStateRefs: fields.subagentStateRefs ?? new Map(),
    completedAskQuestionToolCallIds: fields.completedAskQuestionToolCallIds ?? [],
    readPaths: readPaths.map(path => createRedactedString(
      path,
      DataClassification.PATH,
      "read_paths",
      privacyMode,
    )),
    _privacyMode: privacyMode,
    mode: unknownModeCode === undefined
      ? mode === undefined
        ? undefined
        : toInteropAgentMode(mode)
      : unknownModeCode,
  } as RedactedAgentConversationStateInterop
}

/** Redacts a generated snapshot at the centralized interop boundary. */
export function toRedactedConversationStateStructureInterop(
  state: ConversationStateStructure,
  privacyMode: PrivacyMode,
): RedactedAgentConversationStateInterop {
  return toRedactedConversationStateStructure(state, privacyMode)
}

/** Normalizes identity keys before generated decoding, which expects redacted-string map keys. */
export function fromRedactedConversationStateStructureInterop(
  state: Parameters<typeof fromRedactedConversationStateStructure>[0],
  purpose: Parameters<typeof fromRedactedConversationStateStructure>[1],
  opts: Parameters<typeof fromRedactedConversationStateStructure>[2],
): ConversationStateStructure {
  return fromRedactedConversationStateStructure(
    wrapRedactedConversationMapKeys(state, state._privacyMode),
    purpose,
    opts,
  )
}

export function fromInteropPlanRegistryEntry(entry: PlanRegistryEntry): SlatePlanRegistryEntry {
  return { id: entry.id, path: entry.path }
}

export function toInteropPlanRegistryEntry(entry: SlatePlanRegistryEntry): PlanRegistryEntry {
  return new PlanRegistryEntry({ id: entry.id, path: entry.path })
}

export function createSlateConversationPlanSerde(privacyMode: PrivacyMode): Serde<SlateConversationPlanState> {
  const interopSerde = createRedactedProtoSerde(
    ConversationPlan,
    toRedactedConversationPlan,
    serdeDecoder(fromRedactedConversationPlan),
    privacyMode,
  )
  return {
    serialize(plan) {
      return interopSerde.serialize(
        toRedactedConversationPlan(new ConversationPlan({ plan: plan.content }), privacyMode),
      )
    },
    deserialize(bytes) {
      const redacted = interopSerde.deserialize(bytes)
      const plain = fromRedactedConversationPlan(
        redacted,
        PrivacyCapability.UNSAFE_ALWAYS_ALLOWED,
        undefined,
      )
      return { content: plain.plan }
    },
    getBlobType() {
      return interopSerde.getBlobType?.() ?? { kind: "proto", typeName: "agent.v1.ConversationPlan" }
    },
  }
}

const INTEROP_TO_SLATE_GOAL_STATUS = new Map<number, import("../../../packages/agent-core/goal-continuation.ts").SlateGoalStatus>([
  [GoalStatus.UNSPECIFIED, SlateGoalStatus.UNSPECIFIED],
  [GoalStatus.ACTIVE, SlateGoalStatus.ACTIVE],
  [GoalStatus.PAUSED, SlateGoalStatus.PAUSED],
  [GoalStatus.COMPLETE, SlateGoalStatus.COMPLETE],
  [GoalStatus.CLEARED, SlateGoalStatus.CLEARED],
])

const SLATE_TO_INTEROP_GOAL_STATUS = new Map<import("../../../packages/agent-core/goal-continuation.ts").SlateGoalStatus, GoalStatus>(
  [...INTEROP_TO_SLATE_GOAL_STATUS].map(([code, status]) => [status, code]),
)

export function fromInteropGoalState(goal: GoalState): SlateGoalState {
  const status = INTEROP_TO_SLATE_GOAL_STATUS.get(goal.status) ?? SlateGoalStatus.UNSPECIFIED
  return new SlateGoalState({
    conversationId: goal.conversationId,
    goalId: goal.goalId,
    objective: goal.objective,
    status,
    idleContinuationsWithoutToolCalls: goal.idleContinuationsWithoutToolCalls,
    activeDurationMs: goal.activeDurationMs,
    lastAccruedAtMs: goal.lastAccruedAtMs,
    continuationCount: goal.continuationCount,
    agentSessionId: goal.agentSessionId,
    ...(SLATE_TO_INTEROP_GOAL_STATUS.get(status) === goal.status ? {} : { unknownStatusCode: goal.status }),
  })
}

export function toInteropGoalState(goal: SlateGoalState): GoalState {
  return new GoalState({
    conversationId: goal.conversationId,
    goalId: goal.goalId,
    objective: goal.objective,
    status: goal.unknownStatusCode === undefined
      ? SLATE_TO_INTEROP_GOAL_STATUS.get(goal.status) ?? GoalStatus.UNSPECIFIED
      : goal.unknownStatusCode as GoalStatus,
    idleContinuationsWithoutToolCalls: goal.idleContinuationsWithoutToolCalls,
    ...(goal.activeDurationMs === undefined ? {} : { activeDurationMs: goal.activeDurationMs }),
    ...(goal.lastAccruedAtMs === undefined ? {} : { lastAccruedAtMs: goal.lastAccruedAtMs }),
    continuationCount: goal.continuationCount,
    ...(goal.agentSessionId === undefined ? {} : { agentSessionId: goal.agentSessionId }),
  })
}

export const subagentExecutionEnvironmentUnspecifiedInterop = SubagentExecutionEnvironment.UNSPECIFIED
export const subagentRunStatusUnspecifiedInterop = SubagentRunStatus.UNSPECIFIED

export function createAgentSubagentPersistedStateInterop(
  input: NonNullable<ConstructorParameters<typeof SubagentPersistedState>[0]>,
): AgentSubagentPersistedStateInterop {
  return new SubagentPersistedState(input)
}

export function createAgentSubagentRunStateInterop(
  input: NonNullable<ConstructorParameters<typeof SubagentRunState>[0]>,
): AgentSubagentRunStateInterop {
  return new SubagentRunState(input)
}

export function createAgentStateCommunicateHistoryEntryInterop(input: {
  readonly step: string
  readonly messageIndex: number
}): AgentStateCommunicateHistoryEntryInterop {
  return new CommunicateUpdateHistoryEntry(input)
}

export function createAgentStateCommunicateTurnStateInterop(input: {
  readonly history?: readonly AgentStateCommunicateHistoryEntryInterop[]
  readonly finalSummary?: string
  readonly completedSubtitle?: string
}): AgentStateCommunicateTurnStateInterop {
  return new CommunicateUpdateTurnState({
    ...(input.history === undefined ? {} : { history: [...input.history] }),
    ...(input.finalSummary === undefined ? {} : { finalSummary: input.finalSummary }),
    ...(input.completedSubtitle === undefined ? {} : { completedSubtitle: input.completedSubtitle }),
  })
}

export function emptyAgentSelectedContextInterop(): AgentStateSelectedContextInterop {
  return new SelectedContext()
}

export function attachAgentSelectedContextMediaInterop(input: {
  readonly selectedContext: AgentStateSelectedContextInterop | undefined
  readonly selectedDocuments: readonly unknown[]
  readonly selectedImages: readonly unknown[]
  readonly selectedVideos: readonly unknown[]
}): AgentStateSelectedContextInterop {
  return new SelectedContext({
    ...(input.selectedContext ?? {}),
    selectedDocuments: [...input.selectedDocuments] as never,
    selectedImages: [...input.selectedImages] as never,
    selectedVideos: [...input.selectedVideos] as never,
  })
}

export interface AgentConversationStateSnapshotStatsInterop {
  readonly rootPromptMessageCount: number
  readonly turnCount: number
  readonly todoCount: number
  readonly fileStateCount: number
  readonly hasSummary: boolean
  readonly summaryArchiveCount: number
}

export function encodeSlateConversationStateSnapshotInterop(
  snapshot: Record<string, unknown>,
  privacyMode: PrivacyMode,
): { readonly redactedState: RedactedAgentConversationStateInterop; readonly stats: AgentConversationStateSnapshotStatsInterop } {
  const fileStatesV2 = Object.fromEntries(
    Object.entries((snapshot.fileStatesV2 as Record<string, {
      readonly contentBlobId?: Uint8Array
      readonly initialContentBlobId?: Uint8Array
    }> | undefined) ?? {}).map(([path, fileState]) => [
      path,
      new FileStateStructure({
        ...(fileState.contentBlobId === undefined ? {} : { content: fileState.contentBlobId }),
        ...(fileState.initialContentBlobId === undefined
          ? {}
          : { initialContent: fileState.initialContentBlobId }),
      }),
    ]),
  )
  const state = new ConversationStateStructure({
    ...snapshot,
    fileStatesV2,
  } as never)
  return {
    redactedState: toRedactedConversationStateStructureInterop(state, privacyMode),
    stats: {
      rootPromptMessageCount: state.rootPromptMessagesJson.length,
      turnCount: state.turns.length,
      todoCount: state.todos.length,
      fileStateCount: Object.keys(state.fileStatesV2).length,
      hasSummary: state.summary !== undefined,
      summaryArchiveCount: state.summaryArchives.length,
    },
  }
}

export function serializeRedactedConversationStateInterop(
  state: RedactedAgentConversationStateInterop,
): Uint8Array {
  return conversationStateStructureSerde.serialize(
    fromRedactedConversationStateStructureInterop(
      state,
      PrivacyCapability.UNSAFE_ALWAYS_ALLOWED,
      undefined,
    ),
  )
}

export function fromRedactedSubagentPersistedStateInterop(
  state: Parameters<typeof fromRedactedSubagentPersistedState>[0],
  purpose: Parameters<typeof fromRedactedSubagentPersistedState>[1],
  opts: Parameters<typeof fromRedactedSubagentPersistedState>[2],
): SubagentPersistedState {
  const conversationState = state.conversationState
  return fromRedactedSubagentPersistedState(
    conversationState === undefined
      ? state
      : {
          ...state,
          conversationState: wrapRedactedConversationMapKeys(
            conversationState as RedactedAgentConversationStateInterop,
            conversationState._privacyMode,
          ),
        },
    purpose,
    opts,
  )
}

export function createRedactedThinkingStepInterop(input: {
  readonly text: string
  readonly durationMs: number | undefined
  readonly privacyMode: PrivacyMode
}) {
  return toRedactedConversationStep(
    new ConversationStep({
      message: {
        case: "thinkingMessage",
        value: new ThinkingMessage({ text: input.text, durationMs: input.durationMs! }),
      },
    }),
    input.privacyMode,
  )
}

export function createRedactedAssistantTextStepInterop(input: {
  readonly text: string
  readonly privacyMode: PrivacyMode
}) {
  return toRedactedConversationStep(
    new ConversationStep({
      message: {
        case: "assistantMessage",
        value: new AssistantMessage({ text: input.text }),
      },
    }),
    input.privacyMode,
  )
}

/** Projects the generated step oneof into Slate's discriminated step vocabulary. */
export function fromInteropConversationStep(step: ConversationStep): SlateConversationStep {
  switch (step.message.case) {
    case "assistantMessage":
      return createSlateAssistantMessageStep(step.message.value.text as never)
    case "thinkingMessage":
      return createSlateThinkingMessageStep({
        text: step.message.value.text as never,
        durationMs: step.message.value.durationMs,
      })
    case "toolCall":
      return createSlateToolCallStep({
        ...(step.message.value.toolCallId === undefined
          ? {}
          : { toolCallId: step.message.value.toolCallId }),
        ...(step.message.value.startedAtMs === undefined
          ? {}
          : { startedAtMs: step.message.value.startedAtMs }),
        ...(step.message.value.completedAtMs === undefined
          ? {}
          : { completedAtMs: step.message.value.completedAtMs }),
        hookContexts: step.message.value.hookAdditionalContexts.map(context => ({
          event: context.hookEventName,
          text: context.content as never,
        })),
        tool: {
          ...(step.message.value.tool.case === undefined ? {} : { case: step.message.value.tool.case }),
          ...(step.message.value.tool.value === undefined ? {} : { value: step.message.value.tool.value }),
        },
      })
    default:
      return { kind: "unsupported" }
  }
}

export function fromInteropToolCallStep(
  toolCall: RedactedToolCallInterop,
  toolCallId?: string,
): SlateConversationStep {
  return createSlateToolCallStep({
    ...(toolCallId === undefined
      ? toolCall.toolCallId === undefined ? {} : { toolCallId: toolCall.toolCallId }
      : { toolCallId }),
    ...(toolCall.startedAtMs === undefined ? {} : { startedAtMs: toolCall.startedAtMs }),
    ...(toolCall.completedAtMs === undefined ? {} : { completedAtMs: toolCall.completedAtMs }),
    hookContexts: (toolCall.hookAdditionalContexts ?? []).map(context => ({
      event: context.hookEventName,
      text: context.content as never,
    })),
    tool: {
      ...(toolCall.tool.case === undefined ? {} : { case: toolCall.tool.case }),
      ...(toolCall.tool.value === undefined ? {} : { value: toolCall.tool.value }),
    },
  })
}

/** Reconstructs the generated step only while entering or leaving historical storage. */
export function toInteropConversationStep(step: SlateConversationStep): ConversationStep {
  switch (step.kind) {
    case "assistant-message":
      return new ConversationStep({
        message: {
          case: "assistantMessage",
          value: new AssistantMessage({ text: step.text as never }),
        },
      })
    case "thinking-message":
      return new ConversationStep({
        message: {
          case: "thinkingMessage",
          value: new ThinkingMessage({
            text: step.text as never,
            durationMs: step.durationMs,
          }),
        },
      })
    case "tool-call":
      return new ConversationStep({
        message: {
          case: "toolCall",
          value: new ToolCall({
            ...(step.toolCallId === undefined ? {} : { toolCallId: step.toolCallId }),
            ...(step.startedAtMs === undefined ? {} : { startedAtMs: step.startedAtMs }),
            ...(step.completedAtMs === undefined ? {} : { completedAtMs: step.completedAtMs }),
            hookAdditionalContexts: step.hookContexts.map(context => ({
              hookEventName: context.event,
              content: context.text as never,
            })) as never,
            tool: step.tool.case === undefined
              ? { case: undefined }
              : { case: step.tool.case as never, value: step.tool.value as never },
          }),
        },
      })
    case "unsupported":
      return new ConversationStep()
  }
}

/** Keeps generated step bytes and redaction at the adapter while state handles Slate steps. */
type RedactedConversationStepInterop = ReturnType<typeof toRedactedConversationStep>

function toRedactedSlateConversationStep(
  step: SlateConversationStep,
  privacyMode: PrivacyMode,
): RedactedConversationStepInterop {
  switch (step.kind) {
    case "assistant-message":
      return {
        _privacyMode: privacyMode,
        message: {
          case: "assistantMessage",
          value: { _privacyMode: privacyMode, text: step.text },
        },
      } as RedactedConversationStepInterop
    case "thinking-message":
      return {
        _privacyMode: privacyMode,
        message: {
          case: "thinkingMessage",
          value: { _privacyMode: privacyMode, text: step.text, durationMs: step.durationMs },
        },
      } as RedactedConversationStepInterop
    case "tool-call":
      return {
        _privacyMode: privacyMode,
        message: {
          case: "toolCall",
          value: {
            _privacyMode: privacyMode,
            hookAdditionalContexts: step.hookContexts.map(context => ({
              _privacyMode: privacyMode,
              hookEventName: context.event,
              content: context.text,
            })) as never,
            ...(step.toolCallId === undefined ? {} : { toolCallId: step.toolCallId }),
            ...(step.startedAtMs === undefined ? {} : { startedAtMs: step.startedAtMs }),
            ...(step.completedAtMs === undefined ? {} : { completedAtMs: step.completedAtMs }),
            tool: step.tool.case === undefined
              ? { case: undefined }
              : { case: step.tool.case, value: step.tool.value },
          },
        },
      } as RedactedConversationStepInterop
    case "unsupported":
      return {
        _privacyMode: privacyMode,
        message: { case: undefined, value: undefined },
      } as RedactedConversationStepInterop
  }
}

export function createSlateConversationStepSerde(privacyMode: PrivacyMode): Serde<SlateConversationStep> {
  const interopSerde = createRedactedProtoSerde<ConversationStep, RedactedConversationStepInterop>(
    ConversationStep,
    toRedactedConversationStep,
    serdeDecoder(fromRedactedConversationStep),
    privacyMode,
  )
  return {
    serialize(step) {
      return interopSerde.serialize(toRedactedSlateConversationStep(step, privacyMode))
    },
    deserialize(bytes) {
      return fromInteropConversationStep(interopSerde.deserialize(bytes) as unknown as ConversationStep)
    },
    getBlobType() {
      return interopSerde.getBlobType?.() ?? { kind: "proto", typeName: "agent.v1.ConversationStep" }
    },
  }
}

export function createEmptyRedactedShellOutputInterop(privacyMode: PrivacyMode) {
  return toRedactedShellOutput(new ShellOutput({
    stdout: "",
    stderr: "",
    exitCode: 0,
  }), privacyMode)
}

export function createFileStateStructureInterop(input: {
  readonly contentBlobId: Uint8Array
  readonly initialContentBlobId: Uint8Array
}): InstanceType<typeof FileStateStructure> {
  return new FileStateStructure({
    content: new Uint8Array(input.contentBlobId),
    initialContent: new Uint8Array(input.initialContentBlobId),
  })
}

function serdeDecoder<Redacted, Plain>(
  fromRedacted: (value: Redacted, purpose: PrivacyCapability, options: unknown) => Plain,
): (value: Redacted, purpose: PrivacyCapability) => Plain {
  return (value, purpose) => fromRedacted(value, purpose, undefined)
}

/** Protobuf-backed agent records are persisted in their redacted form at the interop storage boundary. */
export function createAgentStateMessageSerdesInterop(privacyMode: PrivacyMode) {
  return {
    shellCommand: createRedactedProtoSerde(ShellCommand, toRedactedShellCommand, serdeDecoder(fromRedactedShellCommand), privacyMode),
    shellOutput: createRedactedProtoSerde(ShellOutput, toRedactedShellOutput, serdeDecoder(fromRedactedShellOutput), privacyMode),
    userMessage: createRedactedProtoSerde(UserMessage, toRedactedUserMessage, serdeDecoder(fromRedactedUserMessage), privacyMode),
    conversationStep: createRedactedProtoSerde(ConversationStep, toRedactedConversationStep, serdeDecoder(fromRedactedConversationStep), privacyMode),
    conversationSummary: createRedactedProtoSerde(ConversationSummary, toRedactedConversationSummary, serdeDecoder(fromRedactedConversationSummary), privacyMode),
    conversationSummaryArchive: createRedactedProtoSerde(ConversationSummaryArchive, toRedactedConversationSummaryArchive, serdeDecoder(fromRedactedConversationSummaryArchive), privacyMode),
    conversationPlan: createSlateConversationPlanSerde(privacyMode),
    todoItem: createRedactedProtoSerde(TodoItem, toRedactedTodoItem, serdeDecoder(fromRedactedTodoItem), privacyMode),
    subagentPersistedState: createRedactedProtoSerde(SubagentPersistedState, toRedactedSubagentPersistedState, serdeDecoder(fromRedactedSubagentPersistedState), privacyMode),
  }
}

export const fromRedactedConversationPlanInterop = fromRedactedConversationPlan
export const fromRedactedConversationStepInterop = fromRedactedConversationStep
export const fromRedactedConversationSummaryInterop = fromRedactedConversationSummary
export const fromRedactedConversationSummaryArchiveInterop = fromRedactedConversationSummaryArchive
// fromRedactedConversationStateStructureInterop is implemented above to normalize identity map keys.
export const fromRedactedConversationTokenDetailsInterop = fromRedactedConversationTokenDetails
export const fromRedactedCommunicateUpdateHistoryEntryInterop = fromRedactedCommunicateUpdateHistoryEntry
export const fromRedactedCommunicateUpdateTurnStateInterop = fromRedactedCommunicateUpdateTurnState
export const fromRedactedGoalStateInterop = fromRedactedGoalState
export const fromRedactedPlanRegistryEntryInterop = fromRedactedPlanRegistryEntry
export const fromRedactedSubagentRunStateInterop = fromRedactedSubagentRunState
// fromRedactedSubagentPersistedStateInterop is implemented above to normalize nested map keys.
export const fromRedactedUserMessageInterop = fromRedactedUserMessage
export const toRedactedConversationPlanInterop = toRedactedConversationPlan
export const toRedactedConversationStepInterop = toRedactedConversationStep
export const toRedactedConversationSummaryInterop = toRedactedConversationSummary
export const toRedactedConversationSummaryArchiveInterop = toRedactedConversationSummaryArchive
export const toRedactedShellCommandInterop = toRedactedShellCommand
export const toRedactedShellOutputInterop = toRedactedShellOutput
export const toRedactedSubagentPersistedStateInterop = toRedactedSubagentPersistedState
export const toRedactedUserMessageInterop = toRedactedUserMessage
export const fromRedactedTodoItemInterop = fromRedactedTodoItem
export const toRedactedTodoItemInterop = toRedactedTodoItem
export const createRedactedConversationTokenDetailsInterop = createRedactedConversationTokenDetails
