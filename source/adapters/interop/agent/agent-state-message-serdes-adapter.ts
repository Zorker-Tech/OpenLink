import { isMessage, type FieldInfo, type Message } from "@bufbuild/protobuf"
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
  SubagentPersistedState,
  SubagentExecutionEnvironment,
  SubagentRunState,
  SubagentRunStatus,
  ThinkingMessage,
  ToolCall,
  UserMessage,
} from "../proto/generated/agent/v1/agent_pb.ts"
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
  fromRedactedSubagentPersistedState,
  fromRedactedUserMessage,
  toRedactedConversationPlan,
  toRedactedConversationStep,
  toRedactedConversationSummary,
  toRedactedConversationSummaryArchive,
  toRedactedConversationStateStructure,
  toRedactedSubagentPersistedState,
  toRedactedGoalState,
  toRedactedPlanRegistryEntry,
  toRedactedUserMessage,
} from "../redacted-protos/generated/agent/v1/agent_redacted.ts"
import { fromRedactedTodoItem, toRedactedTodoItem } from "../redacted-protos/generated/agent/v1/todo_tool_redacted.ts"
import { DataClassification, PrivacyCapability, type DataClassification as DataClassificationValue } from "../../../packages/redaction/classification.ts"
import { PrivacyMode as PrivacyModes, type PrivacyMode } from "../../../packages/redaction/privacy-mode.ts"
import { createRedactedBytes, createRedactedString } from "../../../packages/redaction/create.ts"
import { RedactedBytes, RedactedString } from "../../../packages/redaction/redacted-values.ts"
import { fromHex, toHex, utf8Serde } from "../../../packages/agent-kv/serde.ts"
import { createRedactedProtoSerde } from "./redacted-protobuf-serde-adapter.ts"
import {
  importLegacyShellInvocation,
  importLegacyShellResult,
  shellInvocationToRunner,
  shellResultToRunner,
} from "./legacy-shell-state-adapter.ts"
import {
  createSlateShellInvocationSerde,
  createSlateShellResultSerde,
} from "../../storage/agent/shell-state-storage-adapter.ts"
import { conversationStateStructureSerde } from "./agent-conversation-state-serdes-adapter.ts"
import { createSlateTodoItemSerde, redactSlateTodoItem } from "./todo-schema-adapter.ts"
import {
  createSlateConversationSummarySerde,
  createSlateConversationSummaryArchiveSerde,
} from "./conversation-summary-storage-adapter.ts"
export {
  deserializeSlateConversationSummaryInterop,
  deserializeSlateConversationSummaryArchiveInterop,
  redactSlateConversationSummary,
  redactSlateConversationSummaryArchive,
} from "./conversation-summary-storage-adapter.ts"
export { deserializeSlateTodoItemInterop } from "./todo-schema-adapter.ts"
export { redactSlateTodoItem } from "./todo-schema-adapter.ts"
import type { Serde } from "../../../packages/agent-kv/serde-contracts.ts"
import {
  createSlateAssistantMessageStep,
  createSlateThinkingMessageStep,
  createSlateToolCallStep,
  createSlateUnsupportedConversationStep,
  type SlateConversationStepCompatibility,
  type SlateConversationStep,
} from "../../../packages/agent/conversation-step-state.ts"
import type {
  SlateConversationState,
  SlateRedactedValue,
} from "../../../packages/agent/conversation-state.ts"
import type {
  SlateSubagentPersistedState,
  SlateSubagentConversationSnapshot,
  SlateSubagentStateCompatibility,
} from "../../../packages/agent/subagent-persisted-state.ts"
import { createSlateSubagentPersistedState } from "../../../packages/agent/subagent-persisted-state.ts"
import type { SlateSubagentType } from "../../../packages/agent/subagent-type.ts"
import type { TaskTargetMachine } from "../../../packages/agent/tools/task-runtime-types.ts"
import type { SlateConversationPlanState } from "../../../packages/agent/conversation-plan-state.ts"
import { SlateMode } from "../../../packages/agent/mode-processing.ts"
import { fromInteropAgentMode, toInteropAgentMode } from "./mode-processing-adapter.ts"
import {
  fromInteropUserMessage,
  toPlainInteropUserMessage,
} from "./user-message-action-protocol-adapter.ts"
import {
  customModeIntentFromInterop,
  triggeringActorFromInterop,
  simulationDetailsFromInterop,
} from "./user-message-metadata-adapter.ts"
import {
  fromInteropSubagentPersistedState,
  toInteropSubagentPersistedState,
} from "./subagent-persisted-state-adapter.ts"
import {
  SlateSimulatedMessageReason,
  type SlatePlanExecutionIntent,
  type SlateUserMessage,
  type SlateUserMessageText,
  type SlateUserMessageCompatibility,
} from "../../../packages/agent/user-message-state.ts"
import type {
  SlateCustomModeIntent,
  SlateSimulationDetails,
  SlateTriggeringActor,
  SlateSubscriptionSource,
  SlateCustomModeSource,
  SlateCustomModeNextMode,
  SlateSubmittedCustomMode,
  SlateExitedCustomMode,
} from "../../../packages/agent/user-message-metadata-state.ts"
import {
  SlateGoalState,
  type SlatePlanRegistryEntry,
} from "../../../packages/agent/goal-state.ts"
import { SlateGoalStatus } from "../../../packages/agent-core/goal-continuation.ts"
import type { SlateCheckpointUnknownField, SlateCheckpointUnknownFieldPathStep } from "../../../packages/agent/conversation-checkpoint-state.ts"
import type { SlateImageAttachment } from "../../../packages/agent/context/image-attachment-contracts.ts"
import type { SlateVideoAttachment } from "../../../packages/agent/context/video-attachment-contracts.ts"
import type { SlateDocumentAttachment } from "../../../packages/agent/context/document-attachment-contracts.ts"
import {
  cloneSlateSelectedContextState,
  emptySlateSelectedContextState,
  isSlateSelectedContextState,
  type SlateSelectedContextState,
} from "../../../packages/agent/context/selected-context-state.ts"
import { fromInteropSelectedContextState, toInteropSelectedContextState } from "./selected-context-state-adapter.ts"
import { toInteropSelectedImage } from "./selected-context-entry-adapter.ts"
import { toInteropSelectedVideo } from "./video-attachment-adapter.ts"
import { toInteropSelectedDocument } from "./document-attachment-adapter.ts"

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
    goalState,
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
        fromInteropPlanRegistryEntry(
          fromRedactedPlanRegistryEntry(
            value,
            PrivacyCapability.UNSAFE_ALWAYS_ALLOWED,
            undefined,
          ),
        ),
      ]),
    ),
    ...(goalState === undefined
      ? {}
      : {
          goalState: fromInteropGoalState(
            fromRedactedGoalState(
              goalState,
              PrivacyCapability.UNSAFE_ALWAYS_ALLOWED,
              undefined,
            ),
          ),
        }),
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
    plans,
    goalState,
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
    plans: new Map(
      [...(plans ?? new Map())].map(([planId, entry]) => [
        planId,
        toRedactedPlanRegistryEntry(toInteropPlanRegistryEntry(entry), privacyMode),
      ]),
    ),
    ...(goalState === undefined
      ? {}
      : { goalState: toRedactedGoalState(toInteropGoalState(goalState), privacyMode) }),
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

const CONVERSATION_PLAN_STORAGE_HEADER = utf8Serde.serialize("SLATE-AGENT-PLAN\n")
const CONVERSATION_PLAN_STORAGE_FORMAT = "slate.agent-conversation-plan"

function isStoredSlateConversationPlan(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const envelope = value as Record<string, unknown>
  if (!hasOnlyKeys(envelope, ["format", "version", "plan", "compatibility"]) ||
      envelope.format !== CONVERSATION_PLAN_STORAGE_FORMAT || envelope.version !== 1 ||
      envelope.plan === null || typeof envelope.plan !== "object" || Array.isArray(envelope.plan)) return false
  const plan = envelope.plan as Record<string, unknown>
  if (!hasOnlyKeys(plan, ["content"]) || typeof plan.content !== "string") return false
  if (envelope.compatibility !== undefined) {
    if (envelope.compatibility === null || typeof envelope.compatibility !== "object" || Array.isArray(envelope.compatibility)) return false
    const compatibility = envelope.compatibility as Record<string, unknown>
    if (!hasOnlyKeys(compatibility, ["legacyUnknownFields"]) ||
        (compatibility.legacyUnknownFields !== undefined &&
          (!Array.isArray(compatibility.legacyUnknownFields) ||
            !compatibility.legacyUnknownFields.every(isStepUnknownField)))) return false
  }
  return true
}

export function createSlateConversationPlanSerde(privacyMode: PrivacyMode): Serde<SlateConversationPlanState> {
  void privacyMode
  return {
    serialize(plan) {
      if (typeof plan.content !== "string") throw new TypeError("Slate conversation plan content must be text")
      const compatibility = plan.compatibility
      if (compatibility?.legacyUnknownFields?.some(field => !isStepUnknownField(field))) {
        throw new TypeError("Slate conversation plan compatibility data is invalid")
      }
      const envelope = {
        format: CONVERSATION_PLAN_STORAGE_FORMAT,
        version: 1,
        plan: { content: plan.content },
        ...(compatibility?.legacyUnknownFields === undefined || compatibility.legacyUnknownFields.length === 0
          ? {}
          : { compatibility: { legacyUnknownFields: compatibility.legacyUnknownFields } }),
      }
      return utf8Serde.serialize(`SLATE-AGENT-PLAN\n${JSON.stringify(envelope)}`)
    },
    deserialize(bytes) {
      if (beginsWith(bytes, CONVERSATION_PLAN_STORAGE_HEADER)) {
        let parsed: unknown
        try {
          parsed = JSON.parse(utf8Serde.deserialize(bytes.subarray(CONVERSATION_PLAN_STORAGE_HEADER.length)))
        } catch (error) {
          throw new TypeError("Stored Slate conversation plan is not valid JSON", { cause: error })
        }
        if (!isStoredSlateConversationPlan(parsed)) throw new TypeError("Stored Slate conversation plan envelope is invalid")
        const envelope = parsed as {
          readonly plan: { readonly content: string }
          readonly compatibility?: { readonly legacyUnknownFields?: readonly SlateCheckpointUnknownField[] }
        }
        return {
          content: envelope.plan.content,
          ...(envelope.compatibility === undefined ? {} : { compatibility: envelope.compatibility }),
        }
      }
      const legacy = ConversationPlan.fromBinary(bytes)
      const legacyUnknownFields = collectStepUnknownFields(legacy)
      return {
        content: legacy.plan,
        ...(legacyUnknownFields.length === 0 ? {} : { compatibility: { legacyUnknownFields } }),
      }
    },
    getBlobType() {
      return { kind: "json", typeName: CONVERSATION_PLAN_STORAGE_FORMAT }
    },
  }
}

export function deserializeSlateConversationPlan(bytes: Uint8Array): SlateConversationPlanState {
  return createSlateConversationPlanSerde(PrivacyModes.UNSPECIFIED).deserialize(bytes)
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
  readonly selectedDocuments: readonly SlateDocumentAttachment[]
  readonly selectedImages: readonly SlateImageAttachment[]
  readonly selectedVideos: readonly SlateVideoAttachment[]
}): AgentStateSelectedContextInterop {
  return new SelectedContext({
    ...(input.selectedContext ?? {}),
    selectedDocuments: input.selectedDocuments.map(toInteropSelectedDocument),
    selectedImages: input.selectedImages.map(toInteropSelectedImage),
    selectedVideos: input.selectedVideos.map(toInteropSelectedVideo),
  })
}

export function attachProcessedSelectedMediaToSlateContext(input: {
  readonly selectedContext: SlateSelectedContextState | undefined
  readonly selectedDocuments: readonly SlateDocumentAttachment[]
  readonly selectedImages: readonly SlateImageAttachment[]
  readonly selectedVideos: readonly SlateVideoAttachment[]
}): SlateSelectedContextState {
  const current = input.selectedContext === undefined
    ? emptySlateSelectedContextState()
    : cloneSlateSelectedContextState(input.selectedContext)
  const processedMedia = fromInteropSelectedContextState(new SelectedContext({
    selectedDocuments: input.selectedDocuments.map(toInteropSelectedDocument),
    selectedImages: input.selectedImages.map(toInteropSelectedImage),
    selectedVideos: input.selectedVideos.map(toInteropSelectedVideo),
  }))
  return { ...current, media: processedMedia.media }
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
  const {
    plans: slatePlanRegistry,
    goalState: slateGoal,
    ...stateFields
  } = snapshot
  const plans = Object.fromEntries(
    entriesOfUnknownStringMap(slatePlanRegistry).map(([id, entry]) => [
      id,
      toInteropPlanRegistryEntry(entry as SlatePlanRegistryEntry),
    ]),
  )
  const goalState = slateGoal === undefined
    ? undefined
    : toInteropGoalState(slateGoal as SlateGoalState)
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
    ...stateFields,
    plans,
    ...(goalState === undefined ? {} : { goalState }),
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

function protoFieldValue(message: Message, field: FieldInfo): unknown {
  const record = message as unknown as Record<string, unknown>
  if (field.oneof == null) return record[field.localName]
  const selection = record[field.oneof.localName]
  if (selection == null || typeof selection !== "object") return undefined
  const selected = selection as { readonly case?: unknown; readonly value?: unknown }
  return selected.case === field.localName ? selected.value : undefined
}

function collectStepUnknownFields(root: Message): SlateCheckpointUnknownField[] {
  const fields: SlateCheckpointUnknownField[] = []
  function visit(message: Message, path: readonly SlateCheckpointUnknownFieldPathStep[]): void {
    for (const field of message.getType().runtime.bin.listUnknownFields(message)) {
      fields.push({ path, number: field.no, wireType: field.wireType, dataHex: toHex(field.data) })
    }
    for (const field of message.getType().fields.list()) {
      const value = protoFieldValue(message, field)
      if (value == null) continue
      if (field.kind === "message") {
        if (field.repeated && Array.isArray(value)) {
          value.forEach((child, index) => {
            if (isMessage(child)) visit(child, [...path, { field: field.localName }, { index }])
          })
        } else if (!field.repeated && isMessage(value)) {
          visit(value, [...path, { field: field.localName }])
        }
      } else if (field.kind === "map" && field.V.kind === "message" && typeof value === "object") {
        const entries = value instanceof Map ? [...value.entries()] : Object.entries(value)
        for (const [key, child] of entries) {
          if (typeof key === "string" && isMessage(child)) {
            visit(child, [...path, { field: field.localName }, { key }])
          }
        }
      }
    }
  }
  visit(root, [])
  return fields
}

function messageAtStepUnknownFieldPath(
  root: Message,
  path: readonly SlateCheckpointUnknownFieldPathStep[],
): Message {
  let current: unknown = root
  for (const step of path) {
    if ("field" in step) {
      if (!isMessage(current)) throw new TypeError("stored step unknown-field parent is invalid")
      const field = current.getType().fields.list().find(candidate => candidate.localName === step.field)
      if (field === undefined) throw new TypeError("stored step unknown-field field is not in this runtime")
      current = protoFieldValue(current, field)
    } else if ("index" in step) {
      current = Array.isArray(current) ? current[step.index] : undefined
    } else {
      current = current !== null && typeof current === "object"
        ? (current as Record<string, unknown>)[step.key]
        : undefined
    }
  }
  if (!isMessage(current)) throw new TypeError("stored step unknown-field target is missing")
  return current
}

function restoreStepUnknownFields(
  step: Message,
  fields: readonly SlateCheckpointUnknownField[] | undefined,
): void {
  for (const field of fields ?? []) {
    ConversationStep.runtime.bin.onUnknownField(
      messageAtStepUnknownFieldPath(step, field.path),
      field.number,
      field.wireType as Parameters<typeof ConversationStep.runtime.bin.onUnknownField>[2],
      fromHex(field.dataHex),
    )
  }
}

/** Projects the generated step oneof into Slate's discriminated step vocabulary. */
export function fromInteropConversationStep(
  step: ConversationStep,
  preservedUnknownFields?: readonly SlateCheckpointUnknownField[],
): SlateConversationStep {
  const unknownFields = preservedUnknownFields ?? (isMessage(step) ? collectStepUnknownFields(step) : [])
  const compatibility: SlateConversationStepCompatibility | undefined = unknownFields.length === 0
    ? undefined
    : { legacyUnknownFields: unknownFields }
  switch (step.message.case) {
    case "assistantMessage":
      return createSlateAssistantMessageStep(step.message.value.text as never, compatibility)
    case "thinkingMessage":
      return createSlateThinkingMessageStep({
        text: step.message.value.text as never,
        durationMs: step.message.value.durationMs,
        ...(compatibility === undefined ? {} : { compatibility }),
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
        ...(compatibility === undefined ? {} : { compatibility }),
      })
    default: {
      const unsupported = step.message as unknown as { readonly case?: string; readonly value?: unknown }
      return createSlateUnsupportedConversationStep({
        ...(unsupported.case === undefined ? {} : { sourceCase: unsupported.case }),
        ...(unsupported.value === undefined ? {} : { value: unsupported.value }),
        ...(compatibility === undefined ? {} : { compatibility }),
      })
    }
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

/** Reconstructs the generated step only for an interop caller. */
export function toInteropConversationStep(step: SlateConversationStep): ConversationStep {
  let interop: ConversationStep
  switch (step.kind) {
    case "assistant-message":
      interop = new ConversationStep({
        message: { case: "assistantMessage", value: new AssistantMessage({ text: step.text as never }) },
      })
      break
    case "thinking-message":
      interop = new ConversationStep({
        message: {
          case: "thinkingMessage",
          value: new ThinkingMessage({ text: step.text as never, durationMs: step.durationMs }),
        },
      })
      break
    case "tool-call":
      interop = new ConversationStep({
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
      break
    case "unsupported":
      interop = new ConversationStep()
      break
  }
  restoreStepUnknownFields(interop, step.compatibility?.legacyUnknownFields)
  return interop
}

function unredactStepValue(value: unknown, ancestors = new Set<object>()): unknown {
  if (value instanceof RedactedString) return value.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED)
  if (value instanceof RedactedBytes) return new Uint8Array(value.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED))
  if (value instanceof Uint8Array) return new Uint8Array(value)
  if (typeof value === "bigint" || value === null || typeof value !== "object") return value
  if (value instanceof Date) return new Date(value.getTime())
  if (ancestors.has(value)) throw new TypeError("Step payload contains a cycle")
  ancestors.add(value)
  try {
    if (Array.isArray(value)) return value.map(entry => unredactStepValue(entry, ancestors))
    if (value instanceof Map) {
      return new Map([...value.entries()].map(([key, entry]) => [
        unredactStepValue(key, ancestors),
        unredactStepValue(entry, ancestors),
      ]))
    }
    if (value instanceof Set) return new Set([...value].map(entry => unredactStepValue(entry, ancestors)))
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null && !isMessage(value)) {
      throw new TypeError(`Step payload contains an unsupported object: ${prototype?.constructor?.name ?? "unknown"}`)
    }
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      unredactStepValue(entry, ancestors),
    ]))
  } finally {
    ancestors.delete(value)
  }
}

/** Reconstructs an unredacted runner message for hydration and blob reachability. */
export function toPlainInteropConversationStep(step: SlateConversationStep): ConversationStep {
  let interop: ConversationStep
  const plainText = (value: RedactedString): string => value instanceof RedactedString
    ? value.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED)
    : typeof value === "string"
      ? value
      : (() => { throw new TypeError("Conversation step text is not a string") })()
  switch (step.kind) {
    case "assistant-message":
      interop = new ConversationStep({
        message: {
          case: "assistantMessage",
          value: new AssistantMessage({ text: plainText(step.text) }),
        },
      })
      break
    case "thinking-message":
      interop = new ConversationStep({
        message: {
          case: "thinkingMessage",
          value: new ThinkingMessage({
            text: plainText(step.text),
            durationMs: step.durationMs,
          }),
        },
      })
      break
    case "tool-call":
      interop = new ConversationStep({
        message: {
          case: "toolCall",
          value: new ToolCall({
            ...(step.toolCallId === undefined ? {} : { toolCallId: step.toolCallId }),
            ...(step.startedAtMs === undefined ? {} : { startedAtMs: step.startedAtMs }),
            ...(step.completedAtMs === undefined ? {} : { completedAtMs: step.completedAtMs }),
            hookAdditionalContexts: step.hookContexts.map(context => ({
              hookEventName: context.event,
              content: plainText(context.text),
            })) as never,
            tool: step.tool.case === undefined
              ? { case: undefined }
              : { case: step.tool.case as never, value: unredactStepValue(step.tool.value) as never },
          }),
        },
      })
      break
    case "unsupported":
      interop = new ConversationStep()
      break
  }
  restoreStepUnknownFields(interop, step.compatibility?.legacyUnknownFields)
  return interop
}

type StoredSlateValue =
  | { readonly kind: "undefined" }
  | { readonly kind: "null" }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "special-number"; readonly value: "negative-zero" | "nan" | "positive-infinity" | "negative-infinity" }
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "bigint"; readonly decimal: string }
  | { readonly kind: "bytes"; readonly hex: string }
  | { readonly kind: "redacted-string"; readonly rawText: string; readonly classification: DataClassificationValue; readonly fieldName: string }
  | { readonly kind: "redacted-bytes"; readonly hex: string; readonly classification: DataClassificationValue; readonly fieldName: string }
  | { readonly kind: "date"; readonly iso: string }
  | { readonly kind: "array"; readonly entries: readonly StoredSlateValue[] }
  | { readonly kind: "set"; readonly entries: readonly StoredSlateValue[] }
  | { readonly kind: "map"; readonly entries: readonly (readonly [StoredSlateValue, StoredSlateValue])[] }
  | { readonly kind: "object"; readonly entries: readonly (readonly [string, StoredSlateValue])[] }

interface StoredRedactedStepText {
  readonly text: string
  readonly classification: DataClassificationValue
  readonly fieldName: string
}

interface StoredSlateUserMessageV1 {
  readonly id: string
  readonly content: StoredSlateValue
  readonly context?: StoredSlateValue
  readonly mode: string
  readonly simulated?: boolean
  readonly promotionGroupId?: string
  readonly promotionEligible?: boolean
  readonly richContent?: StoredSlateValue
  readonly origin?: string
  readonly conversationSnapshotId: string
  readonly workerReminder?: StoredSlateValue
  readonly actor?: StoredSlateValue
  readonly planExecution?: StoredSlateValue
  readonly simulation?: StoredSlateValue
  readonly promptReference?: string
  readonly thread?: string
  readonly contentBlobId?: string
  readonly richContentBlobId?: string
  readonly hooks: readonly { readonly event: string; readonly text: StoredSlateValue }[]
  readonly modeIntent?: StoredSlateValue
  readonly project?: {
    readonly name?: StoredSlateValue
    readonly subagent?: { readonly storeDir?: StoredSlateValue }
    readonly sideChat?: { readonly storeDir?: StoredSlateValue }
  }
}

interface StoredSlatePlanExecution {
  readonly id: StoredSlateValue
  readonly title: StoredSlateValue
}

interface StoredSlateUserMessageV2 extends Omit<StoredSlateUserMessageV1, "planExecution"> {
  readonly planExecution?: StoredSlatePlanExecution
}

interface StoredSlateTriggeringActor {
  readonly authId?: string
  readonly userId?: number
}

interface StoredSlateSubscriptionEventDisplay {
  readonly label?: StoredSlateValue
  readonly resourceUrl?: StoredSlateValue
  readonly subscriptionId?: string
}

interface StoredSlateSimulationDetails {
  readonly title?: StoredSlateValue
  readonly taskId?: string
  readonly findingAction?: string
  readonly url?: StoredSlateValue
  readonly subscriptionSource?: SlateSubscriptionSource
  readonly subscriptionEvent?: StoredSlateSubscriptionEventDisplay
}

interface StoredSlateSubmittedCustomMode {
  readonly id: StoredSlateValue
  readonly label: string
  readonly source: SlateCustomModeSource
  readonly sourcePath?: StoredSlateValue
  readonly sourceHash?: string
  readonly managedSkillId?: string
  readonly pluginId?: string
  readonly pluginSnapshotToken?: StoredSlateValue
}

interface StoredSlateExitedCustomMode {
  readonly id: StoredSlateValue
  readonly label: string
}

type StoredSlateCustomModeIntent =
  | { readonly kind: "unspecified" }
  | { readonly kind: "enter"; readonly mode: StoredSlateSubmittedCustomMode }
  | {
      readonly kind: "exit"
      readonly nextMode: SlateCustomModeNextMode
      readonly exitedMode?: StoredSlateExitedCustomMode
    }

interface StoredSlateUserMessageV3 extends Omit<StoredSlateUserMessageV2, "actor" | "simulation" | "modeIntent"> {
  readonly actor?: StoredSlateTriggeringActor
  readonly simulation?: StoredSlateSimulationDetails
  readonly modeIntent?: StoredSlateCustomModeIntent
}

interface StoredSlateSelectedContextV1 {
  readonly schema: "slate.selected-context"
  readonly version: 1
  readonly payload: StoredSlateValue
}

interface StoredSlateUserMessageV4 extends Omit<StoredSlateUserMessageV3, "context"> {
  readonly context?: StoredSlateSelectedContextV1
}

interface StoredSlateUserMessageEnvelopeV1 {
  readonly format: typeof USER_MESSAGE_STORAGE_FORMAT
  readonly version: 1
  readonly message: StoredSlateUserMessageV1
  readonly compatibility?: SlateUserMessageCompatibility
}

interface StoredSlateUserMessageEnvelopeV2 {
  readonly format: typeof USER_MESSAGE_STORAGE_FORMAT
  readonly version: 2
  readonly message: StoredSlateUserMessageV2
  readonly compatibility?: SlateUserMessageCompatibility
}

interface StoredSlateUserMessageEnvelopeV3 {
  readonly format: typeof USER_MESSAGE_STORAGE_FORMAT
  readonly version: 3
  readonly message: StoredSlateUserMessageV3
  readonly compatibility?: SlateUserMessageCompatibility
}

interface StoredSlateUserMessageEnvelopeV4 {
  readonly format: typeof USER_MESSAGE_STORAGE_FORMAT
  readonly version: 4
  readonly message: StoredSlateUserMessageV4
  readonly compatibility?: SlateUserMessageCompatibility
}

type StoredSlateUserMessageEnvelope =
  | StoredSlateUserMessageEnvelopeV1
  | StoredSlateUserMessageEnvelopeV2
  | StoredSlateUserMessageEnvelopeV3
  | StoredSlateUserMessageEnvelopeV4

const STEP_STORAGE_HEADER = utf8Serde.serialize("SLATE-AGENT-STEP\n")
const STEP_STORAGE_FORMAT = "slate.agent-conversation-step"
const USER_MESSAGE_STORAGE_HEADER = utf8Serde.serialize("SLATE-AGENT-USER\n")
const USER_MESSAGE_STORAGE_FORMAT = "slate.agent-user-message"
const SUBAGENT_STATE_STORAGE_HEADER = utf8Serde.serialize("SLATE-AGENT-SUBAGENT-STATE\n")
const SUBAGENT_STATE_STORAGE_FORMAT = "slate.agent-subagent-state"
const MAX_SUBAGENT_TIMESTAMP_MS = (1n << 64n) - 1n
const CLASSIFICATION_VALUES = new Set<string>(Object.values(DataClassification))
const SLATE_MODE_VALUES = new Set<string>(Object.values(SlateMode))
const SLATE_SIMULATED_REASON_VALUES = new Set<string>(Object.values(SlateSimulatedMessageReason))
const SLATE_SUBSCRIPTION_SOURCE_VALUES = new Set<string>(["unspecified", "slack", "github", "linear", "origin"])
const SLATE_CUSTOM_MODE_SOURCE_VALUES = new Set<string>(["unspecified", "agent-skill", "plugin-skill", "repository-skill", "managed-skill"])
const SUBAGENT_ENVIRONMENT_VALUES = new Set<string>(["unspecified", "local", "cloud"])

function encodeSlateValue(
  value: unknown,
  path = new Set<object>(),
  valueLabel = "Step payload",
): StoredSlateValue {
  if (value === undefined) return { kind: "undefined" }
  if (value === null) return { kind: "null" }
  if (typeof value === "string") return { kind: "string", value }
  if (typeof value === "boolean") return { kind: "boolean", value }
  if (typeof value === "number") {
    if (Object.is(value, -0)) return { kind: "special-number", value: "negative-zero" }
    if (Number.isNaN(value)) return { kind: "special-number", value: "nan" }
    if (value === Number.POSITIVE_INFINITY) return { kind: "special-number", value: "positive-infinity" }
    if (value === Number.NEGATIVE_INFINITY) return { kind: "special-number", value: "negative-infinity" }
    return { kind: "number", value }
  }
  if (typeof value === "bigint") return { kind: "bigint", decimal: value.toString() }
  if (value instanceof RedactedString) {
    return {
      kind: "redacted-string",
      rawText: value.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED),
      classification: value.__classification,
      fieldName: value.__fieldName,
    }
  }
  if (value instanceof RedactedBytes) {
    return {
      kind: "redacted-bytes",
      hex: toHex(value.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED)),
      classification: value.__classification,
      fieldName: value.__fieldName,
    }
  }
  if (value instanceof Uint8Array) return { kind: "bytes", hex: toHex(value) }
  if (value instanceof ArrayBuffer) return { kind: "bytes", hex: toHex(new Uint8Array(value)) }
  if (value instanceof Date) return { kind: "date", iso: value.toISOString() }
  if (typeof value !== "object") {
    throw new TypeError(`${valueLabel} contains an unsupported ${typeof value} value`)
  }
  if (path.has(value)) throw new TypeError(`${valueLabel} contains a cycle`)
  path.add(value)
  try {
    if (Array.isArray(value)) return { kind: "array", entries: value.map(entry => encodeSlateValue(entry, path, valueLabel)) }
    if (value instanceof Map) {
      return {
        kind: "map",
        entries: [...value.entries()].map(([key, entry]) => [
          encodeSlateValue(key, path, valueLabel),
          encodeSlateValue(entry, path, valueLabel),
        ] as const),
      }
    }
    if (value instanceof Set) {
      return { kind: "set", entries: [...value].map(entry => encodeSlateValue(entry, path, valueLabel)) }
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null && !isMessage(value)) {
      throw new TypeError(`${valueLabel} contains an unsupported object: ${prototype?.constructor?.name ?? "unknown"}`)
    }
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, entry]) => [key, encodeSlateValue(entry, path, valueLabel)] as const)
    return { kind: "object", entries }
  } finally {
    path.delete(value)
  }
}

function encodeSlateUserMessageValue(value: unknown): StoredSlateValue {
  return encodeSlateValue(value, new Set(), "User-message value")
}

function isStoredSlateValue(value: unknown, pending: unknown[] = [value]): value is StoredSlateValue {
  while (pending.length > 0) {
    const current = pending.pop()
    if (current === null || typeof current !== "object" || Array.isArray(current)) return false
    const entry = current as Record<string, unknown>
    if (typeof entry.kind !== "string") return false
    switch (entry.kind) {
      case "undefined":
      case "null":
        if (!hasOnlyKeys(entry, ["kind"])) return false
        break
      case "boolean":
        if (!hasOnlyKeys(entry, ["kind", "value"]) || typeof entry.value !== "boolean") return false
        break
      case "number":
        if (!hasOnlyKeys(entry, ["kind", "value"]) || typeof entry.value !== "number" || !Number.isFinite(entry.value)) return false
        break
      case "special-number":
        if (!hasOnlyKeys(entry, ["kind", "value"]) || ![
          "negative-zero", "nan", "positive-infinity", "negative-infinity",
        ].includes(String(entry.value))) return false
        break
      case "string":
        if (!hasOnlyKeys(entry, ["kind", "value"]) || typeof entry.value !== "string") return false
        break
      case "bigint":
        if (!hasOnlyKeys(entry, ["kind", "decimal"]) || typeof entry.decimal !== "string" || !/^-?(?:0|[1-9][0-9]*)$/.test(entry.decimal)) return false
        break
      case "bytes":
        if (!hasOnlyKeys(entry, ["kind", "hex"]) || typeof entry.hex !== "string" || !/^(?:[0-9a-f]{2})*$/.test(entry.hex)) return false
        break
      case "redacted-string":
        if (!hasOnlyKeys(entry, ["kind", "rawText", "classification", "fieldName"]) ||
            typeof entry.rawText !== "string" || typeof entry.fieldName !== "string" ||
            typeof entry.classification !== "string" || !CLASSIFICATION_VALUES.has(entry.classification)) return false
        break
      case "redacted-bytes":
        if (!hasOnlyKeys(entry, ["kind", "hex", "classification", "fieldName"]) ||
            typeof entry.hex !== "string" || !/^(?:[0-9a-f]{2})*$/.test(entry.hex) ||
            typeof entry.fieldName !== "string" || typeof entry.classification !== "string" ||
            !CLASSIFICATION_VALUES.has(entry.classification)) return false
        break
      case "date":
        if (!hasOnlyKeys(entry, ["kind", "iso"]) || typeof entry.iso !== "string" || !Number.isFinite(Date.parse(entry.iso))) return false
        break
      case "array":
      case "set":
        if (!hasOnlyKeys(entry, ["kind", "entries"]) || !Array.isArray(entry.entries)) return false
        for (const child of entry.entries) pending.push(child)
        break
      case "map":
        if (!hasOnlyKeys(entry, ["kind", "entries"]) || !Array.isArray(entry.entries) ||
            !entry.entries.every(pair => Array.isArray(pair) && pair.length === 2)) return false
        for (const pair of entry.entries as unknown[][]) pending.push(pair[0], pair[1])
        break
      case "object":
        if (!hasOnlyKeys(entry, ["kind", "entries"]) || !Array.isArray(entry.entries) ||
            !entry.entries.every(pair => Array.isArray(pair) && pair.length === 2 && typeof pair[0] === "string")) return false
        for (const pair of entry.entries as unknown[][]) pending.push(pair[1])
        break
      default:
        return false
    }
  }
  return true
}

function decodeSlateValue(value: StoredSlateValue, privacyMode: PrivacyMode): unknown {
  switch (value.kind) {
    case "undefined": return undefined
    case "null": return null
    case "boolean":
    case "number":
    case "string": return value.value
    case "special-number":
      switch (value.value) {
        case "negative-zero": return -0
        case "nan": return Number.NaN
        case "positive-infinity": return Number.POSITIVE_INFINITY
        case "negative-infinity": return Number.NEGATIVE_INFINITY
      }
      break
    case "bigint": return BigInt(value.decimal)
    case "bytes": return fromHex(value.hex)
    case "redacted-string":
      return createRedactedString(value.rawText, value.classification, value.fieldName, privacyMode)
    case "redacted-bytes":
      return createRedactedBytes(fromHex(value.hex), value.classification, value.fieldName, privacyMode)
    case "date": return new Date(value.iso)
    case "array": return value.entries.map(entry => decodeSlateValue(entry, privacyMode))
    case "set": return new Set(value.entries.map(entry => decodeSlateValue(entry, privacyMode)))
    case "map": return new Map(value.entries.map(([key, entry]) => [
      decodeSlateValue(key, privacyMode),
      decodeSlateValue(entry, privacyMode),
    ]))
    case "object":
      return Object.fromEntries(value.entries.map(([key, entry]) => [
        key,
        key === "_privacyMode" ? privacyMode : decodeSlateValue(entry, privacyMode),
      ]))
  }
  throw new TypeError("Stored Slate value is invalid")
}

function isStepUnknownField(value: unknown): value is SlateCheckpointUnknownField {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const field = value as Record<string, unknown>
  if (!hasOnlyKeys(field, ["path", "number", "wireType", "dataHex"]) ||
      !Array.isArray(field.path) || !Number.isInteger(field.number) || (field.number as number) < 1 ||
      (field.number as number) > 536_870_911 || !Number.isInteger(field.wireType) ||
      (field.wireType as number) < 0 || (field.wireType as number) > 5 ||
      typeof field.dataHex !== "string" || !/^(?:[0-9a-f]{2})*$/.test(field.dataHex)) return false
  return field.path.every(step => {
    if (step === null || typeof step !== "object" || Array.isArray(step)) return false
    const pathStep = step as Record<string, unknown>
    if (hasOnlyKeys(pathStep, ["field"]) && Object.keys(pathStep).length === 1) return typeof pathStep.field === "string"
    if (hasOnlyKeys(pathStep, ["index"]) && Object.keys(pathStep).length === 1) return Number.isSafeInteger(pathStep.index) && (pathStep.index as number) >= 0
    if (hasOnlyKeys(pathStep, ["key"]) && Object.keys(pathStep).length === 1) return typeof pathStep.key === "string"
    return false
  })
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key))
}

function isStoredRedactedStepText(value: unknown): value is StoredRedactedStepText {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const text = value as Record<string, unknown>
  return hasOnlyKeys(text, ["text", "classification", "fieldName"]) &&
    typeof text.text === "string" && typeof text.classification === "string" &&
    CLASSIFICATION_VALUES.has(text.classification) && typeof text.fieldName === "string"
}

function encodeRedactedStepText(value: RedactedString, fallbackFieldName: string): StoredRedactedStepText {
  if (value instanceof RedactedString) {
    return {
      text: value.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED),
      classification: value.__classification,
      fieldName: value.__fieldName,
    }
  }
  if (typeof value === "string") {
    return { text: value, classification: DataClassification.CODE, fieldName: fallbackFieldName }
  }
  throw new TypeError("Conversation step text must be a Slate redacted string")
}

function decodeRedactedStepText(value: StoredRedactedStepText, privacyMode: PrivacyMode): RedactedString {
  return createRedactedString(value.text, value.classification, value.fieldName, privacyMode)
}

function isStoredStepEnvelope(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const envelope = value as Record<string, unknown>
  if (!hasOnlyKeys(envelope, ["format", "version", "step", "compatibility"]) ||
      envelope.format !== STEP_STORAGE_FORMAT || envelope.version !== 1 ||
      envelope.step === null || typeof envelope.step !== "object" || Array.isArray(envelope.step)) return false
  if (envelope.compatibility !== undefined) {
    if (envelope.compatibility === null || typeof envelope.compatibility !== "object" || Array.isArray(envelope.compatibility)) return false
    const compatibility = envelope.compatibility as Record<string, unknown>
    if (!hasOnlyKeys(compatibility, ["legacyUnknownFields"]) ||
        (compatibility.legacyUnknownFields !== undefined &&
          (!Array.isArray(compatibility.legacyUnknownFields) || !compatibility.legacyUnknownFields.every(isStepUnknownField)))) return false
  }
  const step = envelope.step as Record<string, unknown>
  if (typeof step.kind !== "string") return false
  switch (step.kind) {
    case "assistant-message":
      return hasOnlyKeys(step, ["kind", "text"]) && isStoredRedactedStepText(step.text)
    case "thinking-message":
      return hasOnlyKeys(step, ["kind", "text", "durationMs"]) && isStoredRedactedStepText(step.text) &&
        typeof step.durationMs === "number" && Number.isFinite(step.durationMs)
    case "tool-call": {
      if (!hasOnlyKeys(step, ["kind", "toolCallId", "startedAtMs", "completedAtMs", "hookContexts", "tool"]) ||
          (step.toolCallId !== undefined && typeof step.toolCallId !== "string") ||
          (step.startedAtMs !== undefined && (typeof step.startedAtMs !== "string" || !/^-?(?:0|[1-9][0-9]*)$/.test(step.startedAtMs))) ||
          (step.completedAtMs !== undefined && (typeof step.completedAtMs !== "string" || !/^-?(?:0|[1-9][0-9]*)$/.test(step.completedAtMs))) ||
          !Array.isArray(step.hookContexts) || step.tool === null || typeof step.tool !== "object" || Array.isArray(step.tool)) return false
      const tool = step.tool as Record<string, unknown>
      if (!hasOnlyKeys(tool, ["operation", "payload"]) ||
          (tool.operation !== undefined && typeof tool.operation !== "string") ||
          (tool.payload !== undefined && !isStoredSlateValue(tool.payload))) return false
      return step.hookContexts.every(context => {
        if (context === null || typeof context !== "object" || Array.isArray(context)) return false
        const hook = context as Record<string, unknown>
        return hasOnlyKeys(hook, ["event", "text"]) && typeof hook.event === "string" &&
          isStoredRedactedStepText(hook.text)
      })
    }
    case "unsupported":
      return hasOnlyKeys(step, ["kind", "sourceCase", "value"]) &&
        (step.sourceCase === undefined || typeof step.sourceCase === "string") &&
        (step.value === undefined || isStoredSlateValue(step.value))
    default:
      return false
  }
}

function beginsWith(bytes: Uint8Array, prefix: Uint8Array): boolean {
  if (bytes.length < prefix.length) return false
  for (let index = 0; index < prefix.length; index += 1) {
    if (bytes[index] !== prefix[index]) return false
  }
  return true
}

function stepCompatibility(value: unknown): SlateConversationStepCompatibility | undefined {
  if (value === undefined) return undefined
  const compatibility = value as { readonly legacyUnknownFields?: readonly SlateCheckpointUnknownField[] }
  return compatibility.legacyUnknownFields === undefined
    ? {}
    : { legacyUnknownFields: compatibility.legacyUnknownFields.map(field => ({ ...field, path: field.path.map(pathStep => ({ ...pathStep })) })) }
}

function serializeStoredStepEnvelope(
  storedStep: Record<string, unknown>,
  legacyUnknownFields: readonly SlateCheckpointUnknownField[] | undefined,
): Uint8Array {
  const envelope = {
    format: STEP_STORAGE_FORMAT,
    version: 1,
    step: storedStep,
    ...(legacyUnknownFields === undefined || legacyUnknownFields.length === 0
      ? {}
      : { compatibility: { legacyUnknownFields: stepCompatibility({ legacyUnknownFields })?.legacyUnknownFields } }),
  }
  return utf8Serde.serialize(`SLATE-AGENT-STEP\n${JSON.stringify(envelope)}`)
}

function encodeStoredConversationStep(step: SlateConversationStep): Uint8Array {
  let storedStep: Record<string, unknown>
  switch (step.kind) {
    case "assistant-message":
      storedStep = { kind: step.kind, text: encodeRedactedStepText(step.text, "text") }
      break
    case "thinking-message":
      storedStep = {
        kind: step.kind,
        text: encodeRedactedStepText(step.text, "text"),
        durationMs: step.durationMs,
      }
      break
    case "tool-call":
      storedStep = {
        kind: step.kind,
        ...(step.toolCallId === undefined ? {} : { toolCallId: step.toolCallId }),
        ...(step.startedAtMs === undefined
          ? {}
          : { startedAtMs: step.startedAtMs.toString() }),
        ...(step.completedAtMs === undefined
          ? {}
          : { completedAtMs: step.completedAtMs.toString() }),
        hookContexts: step.hookContexts.map(context => ({
          event: context.event,
          text: encodeRedactedStepText(context.text, "hook_additional_context"),
        })),
        tool: {
          ...(step.tool.case === undefined ? {} : { operation: step.tool.case }),
          ...(Object.prototype.hasOwnProperty.call(step.tool, "value")
            ? { payload: encodeSlateValue(step.tool.value) }
            : {}),
        },
      }
      break
    case "unsupported":
      storedStep = {
        kind: step.kind,
        ...(step.sourceCase === undefined ? {} : { sourceCase: step.sourceCase }),
        ...(Object.prototype.hasOwnProperty.call(step, "value") ? { value: encodeSlateValue(step.value) } : {}),
      }
      break
  }
  return serializeStoredStepEnvelope(storedStep, step.compatibility?.legacyUnknownFields)
}

function decodeStoredConversationStep(bytes: Uint8Array, privacyMode: PrivacyMode): SlateConversationStep | undefined {
  if (!beginsWith(bytes, STEP_STORAGE_HEADER)) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(utf8Serde.deserialize(bytes.subarray(STEP_STORAGE_HEADER.length)))
  } catch (error) {
    throw new TypeError("Slate conversation step JSON is invalid", { cause: error })
  }
  if (!isStoredStepEnvelope(parsed)) throw new TypeError("Slate conversation step record is unsupported or invalid")
  const envelope = parsed as {
    readonly step: Record<string, unknown>
    readonly compatibility?: { readonly legacyUnknownFields?: readonly SlateCheckpointUnknownField[] }
  }
  const step = envelope.step
  const compatibility = stepCompatibility(envelope.compatibility)
  switch (step.kind) {
    case "assistant-message":
      return createSlateAssistantMessageStep(
        decodeRedactedStepText(step.text as StoredRedactedStepText, privacyMode),
        compatibility,
      )
    case "thinking-message":
      return createSlateThinkingMessageStep({
        text: decodeRedactedStepText(step.text as StoredRedactedStepText, privacyMode),
        durationMs: step.durationMs as number,
        ...(compatibility === undefined ? {} : { compatibility }),
      })
    case "tool-call": {
      const tool = step.tool as Record<string, unknown>
      return createSlateToolCallStep({
        ...(step.toolCallId === undefined ? {} : { toolCallId: step.toolCallId as string }),
        ...(step.startedAtMs === undefined ? {} : { startedAtMs: BigInt(step.startedAtMs as string) }),
        ...(step.completedAtMs === undefined ? {} : { completedAtMs: BigInt(step.completedAtMs as string) }),
        hookContexts: (step.hookContexts as readonly Record<string, unknown>[]).map(context => ({
          event: context.event as string,
          text: decodeRedactedStepText(context.text as StoredRedactedStepText, privacyMode),
        })),
        tool: {
          ...(tool.operation === undefined ? {} : { case: tool.operation as string }),
          ...(Object.prototype.hasOwnProperty.call(tool, "payload")
            ? { value: decodeSlateValue(tool.payload as StoredSlateValue, privacyMode) }
            : {}),
        },
        ...(compatibility === undefined ? {} : { compatibility }),
      })
    }
    case "unsupported":
      return createSlateUnsupportedConversationStep({
        ...(step.sourceCase === undefined ? {} : { sourceCase: step.sourceCase as string }),
        ...(Object.prototype.hasOwnProperty.call(step, "value")
          ? { value: decodeSlateValue(step.value as StoredSlateValue, privacyMode) }
          : {}),
        ...(compatibility === undefined ? {} : { compatibility }),
      })
    default:
      return undefined
  }
}

export function deserializeSlateConversationStepInterop(bytes: Uint8Array): ConversationStep {
  const slate = decodeStoredConversationStep(bytes, PrivacyModes.UNSPECIFIED)
  return slate === undefined ? ConversationStep.fromBinary(bytes) : toPlainInteropConversationStep(slate)
}

export function createSlateConversationStepSerde(privacyMode: PrivacyMode): Serde<SlateConversationStep> {
  return {
    serialize(step) {
      return encodeStoredConversationStep(step)
    },
    deserialize(bytes) {
      const slate = decodeStoredConversationStep(bytes, privacyMode)
      if (slate !== undefined) return slate
      const plain = ConversationStep.fromBinary(bytes)
      const unknownFields = collectStepUnknownFields(plain)
      const redacted = toRedactedConversationStep(plain, privacyMode)
      return fromInteropConversationStep(
        redacted as unknown as ConversationStep,
        unknownFields,
      )
    },
    getBlobType() {
      return { kind: "json", typeName: "slate.agent-conversation-step" }
    },
  }
}

function isStoredTextValue(value: unknown): value is StoredSlateValue {
  return isStoredSlateValue(value) && (value.kind === "string" || value.kind === "redacted-string")
}

function isStoredProjectDetails(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const project = value as Record<string, unknown>
  if (!hasOnlyKeys(project, ["name", "subagent", "sideChat"]) ||
      (project.name !== undefined && !isStoredTextValue(project.name))) return false
  for (const key of ["subagent", "sideChat"] as const) {
    const child = project[key]
    if (child === undefined) continue
    if (child === null || typeof child !== "object" || Array.isArray(child)) return false
    const record = child as Record<string, unknown>
    if (!hasOnlyKeys(record, ["storeDir"]) ||
        (record.storeDir !== undefined && !isStoredTextValue(record.storeDir))) return false
  }
  return true
}

function isStoredSlatePlanExecution(value: unknown): value is StoredSlatePlanExecution {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    hasOnlyKeys(value as Record<string, unknown>, ["id", "title"]) &&
    isStoredTextValue((value as Record<string, unknown>).id) &&
    isStoredTextValue((value as Record<string, unknown>).title)
}

function isUnknownInt32Enum(value: string): boolean {
  const match = /^unknown-(-?\d+)$/.exec(value)
  if (match === null) return false
  const code = Number(match[1])
  return Number.isSafeInteger(code) && code >= -2_147_483_648 && code <= 2_147_483_647
}

function isStoredSlateSubscriptionSource(value: unknown): value is SlateSubscriptionSource {
  return typeof value === "string" && (
    SLATE_SUBSCRIPTION_SOURCE_VALUES.has(value) || isUnknownInt32Enum(value)
  )
}

function isStoredSlateCustomModeSource(value: unknown): value is SlateCustomModeSource {
  return typeof value === "string" && (
    SLATE_CUSTOM_MODE_SOURCE_VALUES.has(value) || isUnknownInt32Enum(value)
  )
}

function isStoredSlateCustomModeNextMode(value: unknown): value is SlateCustomModeNextMode {
  if (typeof value === "string") return SLATE_MODE_VALUES.has(value)
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  const code = record.code
  return hasOnlyKeys(record, ["kind", "code"]) && record.kind === "unrecognized" &&
    typeof code === "number" && Number.isSafeInteger(code) &&
    code >= -2_147_483_648 && code <= 2_147_483_647
}

function isStoredSlateTriggeringActor(value: unknown): value is StoredSlateTriggeringActor {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const actor = value as Record<string, unknown>
  return hasOnlyKeys(actor, ["authId", "userId"]) &&
    (actor.authId === undefined || typeof actor.authId === "string") &&
    (actor.userId === undefined || (Number.isInteger(actor.userId) &&
      (actor.userId as number) >= -2_147_483_648 && (actor.userId as number) <= 2_147_483_647))
}

function isStoredSlateSubscriptionEventDisplay(value: unknown): value is StoredSlateSubscriptionEventDisplay {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const display = value as Record<string, unknown>
  return hasOnlyKeys(display, ["label", "resourceUrl", "subscriptionId"]) &&
    (display.label === undefined || isStoredTextValue(display.label)) &&
    (display.resourceUrl === undefined || isStoredTextValue(display.resourceUrl)) &&
    (display.subscriptionId === undefined || typeof display.subscriptionId === "string")
}

function isStoredSlateSimulationDetails(value: unknown): value is StoredSlateSimulationDetails {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const simulation = value as Record<string, unknown>
  return hasOnlyKeys(simulation, ["title", "taskId", "findingAction", "url", "subscriptionSource", "subscriptionEvent"]) &&
    (simulation.title === undefined || isStoredTextValue(simulation.title)) &&
    (simulation.taskId === undefined || typeof simulation.taskId === "string") &&
    (simulation.findingAction === undefined || typeof simulation.findingAction === "string") &&
    (simulation.url === undefined || isStoredTextValue(simulation.url)) &&
    (simulation.subscriptionSource === undefined || isStoredSlateSubscriptionSource(simulation.subscriptionSource)) &&
    (simulation.subscriptionEvent === undefined || isStoredSlateSubscriptionEventDisplay(simulation.subscriptionEvent))
}

function isStoredSlateSubmittedCustomMode(value: unknown): value is StoredSlateSubmittedCustomMode {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const mode = value as Record<string, unknown>
  return hasOnlyKeys(mode, ["id", "label", "source", "sourcePath", "sourceHash", "managedSkillId", "pluginId", "pluginSnapshotToken"]) &&
    isStoredTextValue(mode.id) && typeof mode.label === "string" && isStoredSlateCustomModeSource(mode.source) &&
    (mode.sourcePath === undefined || isStoredTextValue(mode.sourcePath)) &&
    (mode.sourceHash === undefined || typeof mode.sourceHash === "string") &&
    (mode.managedSkillId === undefined || typeof mode.managedSkillId === "string") &&
    (mode.pluginId === undefined || typeof mode.pluginId === "string") &&
    (mode.pluginSnapshotToken === undefined || isStoredTextValue(mode.pluginSnapshotToken))
}

function isStoredSlateExitedCustomMode(value: unknown): value is StoredSlateExitedCustomMode {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const mode = value as Record<string, unknown>
  return hasOnlyKeys(mode, ["id", "label"]) && isStoredTextValue(mode.id) && typeof mode.label === "string"
}

function isStoredSlateCustomModeIntent(value: unknown): value is StoredSlateCustomModeIntent {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const intent = value as Record<string, unknown>
  if (intent.kind === "unspecified") return hasOnlyKeys(intent, ["kind"])
  if (intent.kind === "enter") return hasOnlyKeys(intent, ["kind", "mode"]) && isStoredSlateSubmittedCustomMode(intent.mode)
  return intent.kind === "exit" && hasOnlyKeys(intent, ["kind", "nextMode", "exitedMode"]) &&
    isStoredSlateCustomModeNextMode(intent.nextMode) &&
    (intent.exitedMode === undefined || isStoredSlateExitedCustomMode(intent.exitedMode))
}

function isStoredSlateSelectedContextV1(value: unknown): value is StoredSlateSelectedContextV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const context = value as Record<string, unknown>
  return hasOnlyKeys(context, ["schema", "version", "payload"]) &&
    context.schema === "slate.selected-context" && context.version === 1 &&
    isStoredSlateValue(context.payload)
}

function isStoredSlateUserMessageEnvelope(value: unknown): value is StoredSlateUserMessageEnvelope {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const envelope = value as Record<string, unknown>
  if (!hasOnlyKeys(envelope, ["format", "version", "message", "compatibility"]) ||
      envelope.format !== USER_MESSAGE_STORAGE_FORMAT ||
      (envelope.version !== 1 && envelope.version !== 2 && envelope.version !== 3 && envelope.version !== 4) ||
      envelope.message === null || typeof envelope.message !== "object" || Array.isArray(envelope.message)) return false
  if (envelope.compatibility !== undefined) {
    if (envelope.compatibility === null || typeof envelope.compatibility !== "object" || Array.isArray(envelope.compatibility)) return false
    const compatibility = envelope.compatibility as Record<string, unknown>
    if (!hasOnlyKeys(compatibility, ["legacyModeCode", "legacyUnknownFields"]) ||
        (compatibility.legacyModeCode !== undefined &&
          (!Number.isSafeInteger(compatibility.legacyModeCode) ||
            (compatibility.legacyModeCode as number) < -2_147_483_648 ||
            (compatibility.legacyModeCode as number) > 2_147_483_647)) ||
        (compatibility.legacyUnknownFields !== undefined &&
          (!Array.isArray(compatibility.legacyUnknownFields) ||
            !compatibility.legacyUnknownFields.every(isStepUnknownField)))) return false
  }
  const message = envelope.message as Record<string, unknown>
  const planExecutionIsValid = message.planExecution === undefined || (envelope.version === 1
    ? isStoredSlateValue(message.planExecution)
    : isStoredSlatePlanExecution(message.planExecution))
  const actorIsValid = message.actor === undefined || (envelope.version >= 3
    ? isStoredSlateTriggeringActor(message.actor)
    : isStoredSlateValue(message.actor))
  const simulationIsValid = message.simulation === undefined || (envelope.version >= 3
    ? isStoredSlateSimulationDetails(message.simulation)
    : isStoredSlateValue(message.simulation))
  const modeIntentIsValid = message.modeIntent === undefined || (envelope.version >= 3
    ? isStoredSlateCustomModeIntent(message.modeIntent)
    : isStoredSlateValue(message.modeIntent))
  const contextIsValid = message.context === undefined || (envelope.version === 4
    ? isStoredSlateSelectedContextV1(message.context)
    : isStoredSlateValue(message.context))
  if (!hasOnlyKeys(message, [
    "id", "content", "context", "mode", "simulated", "promotionGroupId", "promotionEligible",
    "richContent", "origin", "conversationSnapshotId", "workerReminder", "actor", "planExecution",
    "simulation", "promptReference", "thread", "contentBlobId", "richContentBlobId", "hooks",
    "modeIntent", "project",
  ]) ||
      typeof message.id !== "string" || !isStoredTextValue(message.content) ||
      !contextIsValid ||
      typeof message.mode !== "string" || !SLATE_MODE_VALUES.has(message.mode) ||
      (message.simulated !== undefined && typeof message.simulated !== "boolean") ||
      (message.promotionGroupId !== undefined && typeof message.promotionGroupId !== "string") ||
      (message.promotionEligible !== undefined && typeof message.promotionEligible !== "boolean") ||
      (message.richContent !== undefined && !isStoredTextValue(message.richContent)) ||
      (message.origin !== undefined && typeof message.origin !== "string") ||
      typeof message.conversationSnapshotId !== "string" || !/^(?:[0-9a-f]{2})*$/.test(message.conversationSnapshotId) ||
      (message.workerReminder !== undefined && !isStoredTextValue(message.workerReminder)) ||
      !actorIsValid ||
      !planExecutionIsValid ||
      !simulationIsValid ||
      (message.promptReference !== undefined && typeof message.promptReference !== "string") ||
      (message.thread !== undefined && typeof message.thread !== "string") ||
      (message.contentBlobId !== undefined &&
        (typeof message.contentBlobId !== "string" || !/^(?:[0-9a-f]{2})*$/.test(message.contentBlobId))) ||
      (message.richContentBlobId !== undefined &&
        (typeof message.richContentBlobId !== "string" || !/^(?:[0-9a-f]{2})*$/.test(message.richContentBlobId))) ||
      !Array.isArray(message.hooks) ||
      !message.hooks.every(hook => hook !== null && typeof hook === "object" && !Array.isArray(hook) &&
        hasOnlyKeys(hook as Record<string, unknown>, ["event", "text"]) &&
        typeof (hook as Record<string, unknown>).event === "string" &&
        isStoredTextValue((hook as Record<string, unknown>).text)) ||
      !modeIntentIsValid ||
      (message.project !== undefined && !isStoredProjectDetails(message.project))) return false
  if (message.origin !== undefined && !SLATE_SIMULATED_REASON_VALUES.has(message.origin) &&
      !/^unknown-(-?\d+)$/.test(message.origin)) return false
  return true
}

function storedSlateSimulationDetails(value: SlateSimulationDetails): StoredSlateSimulationDetails {
  return {
    ...(value.title === undefined ? {} : { title: encodeSlateUserMessageValue(value.title) }),
    ...(value.taskId === undefined ? {} : { taskId: value.taskId }),
    ...(value.findingAction === undefined ? {} : { findingAction: value.findingAction }),
    ...(value.url === undefined ? {} : { url: encodeSlateUserMessageValue(value.url) }),
    ...(value.subscriptionSource === undefined ? {} : { subscriptionSource: value.subscriptionSource }),
    ...(value.subscriptionEvent === undefined ? {} : {
      subscriptionEvent: {
        ...(value.subscriptionEvent.label === undefined ? {} : { label: encodeSlateUserMessageValue(value.subscriptionEvent.label) }),
        ...(value.subscriptionEvent.resourceUrl === undefined ? {} : { resourceUrl: encodeSlateUserMessageValue(value.subscriptionEvent.resourceUrl) }),
        ...(value.subscriptionEvent.subscriptionId === undefined ? {} : { subscriptionId: value.subscriptionEvent.subscriptionId }),
      },
    }),
  }
}

function storedSlateSubmittedCustomMode(value: SlateSubmittedCustomMode): StoredSlateSubmittedCustomMode {
  return {
    id: encodeSlateUserMessageValue(value.id),
    label: value.label,
    source: value.source,
    ...(value.sourcePath === undefined ? {} : { sourcePath: encodeSlateUserMessageValue(value.sourcePath) }),
    ...(value.sourceHash === undefined ? {} : { sourceHash: value.sourceHash }),
    ...(value.managedSkillId === undefined ? {} : { managedSkillId: value.managedSkillId }),
    ...(value.pluginId === undefined ? {} : { pluginId: value.pluginId }),
    ...(value.pluginSnapshotToken === undefined ? {} : { pluginSnapshotToken: encodeSlateUserMessageValue(value.pluginSnapshotToken) }),
  }
}

function storedSlateExitedCustomMode(value: SlateExitedCustomMode): StoredSlateExitedCustomMode {
  return { id: encodeSlateUserMessageValue(value.id), label: value.label }
}

function storedSlateCustomModeIntent(value: SlateCustomModeIntent): StoredSlateCustomModeIntent {
  switch (value.kind) {
    case "unspecified":
      return { kind: "unspecified" }
    case "enter":
      return { kind: "enter", mode: storedSlateSubmittedCustomMode(value.mode) }
    case "exit":
      return {
        kind: "exit",
        nextMode: value.nextMode,
        ...(value.exitedMode === undefined ? {} : { exitedMode: storedSlateExitedCustomMode(value.exitedMode) }),
      }
  }
}

function encodeStoredSlateUserMessage(message: SlateUserMessage): Uint8Array {
  const stored: StoredSlateUserMessageV4 = {
    id: message.messageId,
    content: encodeSlateUserMessageValue(message.text),
    ...(message.selectedContext === undefined ? {} : { context: {
      schema: "slate.selected-context",
      version: 1,
      payload: encodeSlateUserMessageValue(message.selectedContext),
    } }),
    mode: message.mode,
    ...(message.isSimulatedMsg === undefined ? {} : { simulated: message.isSimulatedMsg }),
    ...(message.bestOfNGroupId === undefined ? {} : { promotionGroupId: message.bestOfNGroupId }),
    ...(message.tryUseBestOfNPromotion === undefined ? {} : { promotionEligible: message.tryUseBestOfNPromotion }),
    ...(message.richText === undefined ? {} : { richContent: encodeSlateUserMessageValue(message.richText) }),
    ...(message.simulatedMsgReason === undefined ? {} : { origin: message.simulatedMsgReason }),
    conversationSnapshotId: toHex(message.conversationStateBlobId),
    ...(message.subagentSystemReminder === undefined ? {} : { workerReminder: encodeSlateUserMessageValue(message.subagentSystemReminder) }),
    ...(message.triggeringActor === undefined ? {} : { actor: { ...message.triggeringActor } }),
    ...(message.planExecution === undefined ? {} : {
      planExecution: {
        id: encodeSlateUserMessageValue(message.planExecution.id),
        title: encodeSlateUserMessageValue(message.planExecution.title),
      },
    }),
    ...(message.simulation === undefined ? {} : { simulation: storedSlateSimulationDetails(message.simulation) }),
    ...(message.promptReferenceId === undefined ? {} : { promptReference: message.promptReferenceId }),
    ...(message.threadId === undefined ? {} : { thread: message.threadId }),
    ...(message.textBlobId === undefined ? {} : { contentBlobId: toHex(message.textBlobId) }),
    ...(message.richTextBlobId === undefined ? {} : { richContentBlobId: toHex(message.richTextBlobId) }),
    hooks: message.hookContexts.map(context => ({ event: context.event, text: encodeSlateUserMessageValue(context.text) })),
    ...(message.modeIntent === undefined ? {} : { modeIntent: storedSlateCustomModeIntent(message.modeIntent) }),
    ...(message.projectDetails === undefined
      ? {}
      : {
          project: {
            ...(message.projectDetails.name === undefined ? {} : { name: encodeSlateUserMessageValue(message.projectDetails.name) }),
            ...(message.projectDetails.subagent === undefined
              ? {}
              : {
                  subagent: message.projectDetails.subagent.storeDir === undefined
                    ? {}
                    : { storeDir: encodeSlateUserMessageValue(message.projectDetails.subagent.storeDir) },
                }),
            ...(message.projectDetails.sideChat === undefined
              ? {}
              : {
                  sideChat: message.projectDetails.sideChat.storeDir === undefined
                    ? {}
                    : { storeDir: encodeSlateUserMessageValue(message.projectDetails.sideChat.storeDir) },
                }),
          },
        }),
  }
  const compatibility = message.compatibility
  const envelope = {
    format: USER_MESSAGE_STORAGE_FORMAT,
    version: 4,
    message: stored,
    ...(compatibility === undefined ||
      (compatibility.legacyModeCode === undefined &&
        (compatibility.legacyUnknownFields === undefined || compatibility.legacyUnknownFields.length === 0))
      ? {}
      : { compatibility }),
  }
  return utf8Serde.serialize(`SLATE-AGENT-USER\n${JSON.stringify(envelope)}`)
}

function planExecutionFromSlateV1(value: StoredSlateValue | undefined, privacyMode: PrivacyMode): SlatePlanExecutionIntent | undefined {
  if (value === undefined) return undefined
  const decoded = decodeSlateValue(value, privacyMode)
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new TypeError("Stored legacy Slate plan execution metadata is invalid")
  }
  const record = decoded as Record<string, unknown>
  const id = typeof record.planId === "string" ? record.planId : record.id
  const title = typeof record.planTitle === "string" ? record.planTitle : record.title
  if (!(typeof id === "string" || id instanceof RedactedString) ||
      !(typeof title === "string" || title instanceof RedactedString)) {
    throw new TypeError("Stored legacy Slate plan execution metadata is missing its id or title")
  }
  return { id, title }
}

function planExecutionFromSlateV2(value: StoredSlatePlanExecution | undefined, privacyMode: PrivacyMode): SlatePlanExecutionIntent | undefined {
  return value === undefined ? undefined : {
    id: decodeSlateValue(value.id, privacyMode) as SlateUserMessageText,
    title: decodeSlateValue(value.title, privacyMode) as SlateUserMessageText,
  }
}

function simulationDetailsFromSlateV3(value: StoredSlateSimulationDetails | undefined, privacyMode: PrivacyMode): SlateSimulationDetails | undefined {
  if (value === undefined) return undefined
  const display = value.subscriptionEvent
  return {
    ...(value.title === undefined ? {} : { title: decodeSlateValue(value.title, privacyMode) as SlateUserMessageText }),
    ...(value.taskId === undefined ? {} : { taskId: value.taskId }),
    ...(value.findingAction === undefined ? {} : { findingAction: value.findingAction }),
    ...(value.url === undefined ? {} : { url: decodeSlateValue(value.url, privacyMode) as SlateUserMessageText }),
    ...(value.subscriptionSource === undefined ? {} : { subscriptionSource: value.subscriptionSource }),
    ...(display === undefined ? {} : {
      subscriptionEvent: {
        ...(display.label === undefined ? {} : { label: decodeSlateValue(display.label, privacyMode) as SlateUserMessageText }),
        ...(display.resourceUrl === undefined ? {} : { resourceUrl: decodeSlateValue(display.resourceUrl, privacyMode) as SlateUserMessageText }),
        ...(display.subscriptionId === undefined ? {} : { subscriptionId: display.subscriptionId }),
      },
    }),
  }
}

function submittedCustomModeFromSlateV3(value: StoredSlateSubmittedCustomMode, privacyMode: PrivacyMode): SlateSubmittedCustomMode {
  return {
    id: decodeSlateValue(value.id, privacyMode) as SlateUserMessageText,
    label: value.label,
    source: value.source,
    ...(value.sourcePath === undefined ? {} : { sourcePath: decodeSlateValue(value.sourcePath, privacyMode) as SlateUserMessageText }),
    ...(value.sourceHash === undefined ? {} : { sourceHash: value.sourceHash }),
    ...(value.managedSkillId === undefined ? {} : { managedSkillId: value.managedSkillId }),
    ...(value.pluginId === undefined ? {} : { pluginId: value.pluginId }),
    ...(value.pluginSnapshotToken === undefined ? {} : { pluginSnapshotToken: decodeSlateValue(value.pluginSnapshotToken, privacyMode) as SlateUserMessageText }),
  }
}

function exitedCustomModeFromSlateV3(value: StoredSlateExitedCustomMode, privacyMode: PrivacyMode): SlateExitedCustomMode {
  return { id: decodeSlateValue(value.id, privacyMode) as SlateUserMessageText, label: value.label }
}

function customModeIntentFromSlateV3(value: StoredSlateCustomModeIntent | undefined, privacyMode: PrivacyMode): SlateCustomModeIntent | undefined {
  if (value === undefined) return undefined
  switch (value.kind) {
    case "unspecified":
      return { kind: "unspecified" }
    case "enter":
      return { kind: "enter", mode: submittedCustomModeFromSlateV3(value.mode, privacyMode) }
    case "exit":
      return {
        kind: "exit",
        nextMode: typeof value.nextMode === "string" ? value.nextMode : { ...value.nextMode },
        ...(value.exitedMode === undefined ? {} : { exitedMode: exitedCustomModeFromSlateV3(value.exitedMode, privacyMode) }),
      }
  }
}

function selectedContextFromStoredSlateValue(
  value: StoredSlateValue,
  version: number,
  privacyMode: PrivacyMode,
): SlateSelectedContextState | undefined {
  const decoded = decodeSlateValue(value, privacyMode)
  if (decoded === undefined || decoded === null) return undefined
  if (isSlateSelectedContextState(decoded)) return decoded
  if (version >= 4) throw new TypeError("Stored Slate selected-context schema is invalid")
  if (typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new TypeError("Stored legacy selected-context data is invalid")
  }
  // Versions 1–3 stored generated-message field trees. The adapter reads them once and projects them
  // into Slate's versioned source model; business logic never consumes the legacy field tree.
  return fromInteropSelectedContextState(decoded as SelectedContext)
}

function decodeStoredSlateUserMessage(bytes: Uint8Array, privacyMode: PrivacyMode): SlateUserMessage | undefined {
  if (!beginsWith(bytes, USER_MESSAGE_STORAGE_HEADER)) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(utf8Serde.deserialize(bytes.subarray(USER_MESSAGE_STORAGE_HEADER.length)))
  } catch (error) {
    throw new TypeError("Stored Slate user message is not valid JSON", { cause: error })
  }
  if (!isStoredSlateUserMessageEnvelope(parsed)) throw new TypeError("Stored Slate user message envelope is invalid")
  const envelope = parsed
  const message = envelope.message
  const project = message.project
  const storedContext = message.context
  const selectedContext = storedContext === undefined
    ? undefined
    : envelope.version === 4
      ? selectedContextFromStoredSlateValue(
          (storedContext as StoredSlateSelectedContextV1).payload,
          4,
          privacyMode,
        )
      : selectedContextFromStoredSlateValue(storedContext as StoredSlateValue, envelope.version, privacyMode)
  const planExecution = envelope.version === 1
    ? planExecutionFromSlateV1(envelope.message.planExecution, privacyMode)
    : planExecutionFromSlateV2(envelope.message.planExecution, privacyMode)
  const triggeringActor = envelope.version >= 3
    ? (message as StoredSlateUserMessageV3).actor
    : envelope.message.actor === undefined
      ? undefined
      : triggeringActorFromInterop(decodeSlateValue(envelope.message.actor as StoredSlateValue, privacyMode))
  const simulation = envelope.version >= 3
    ? simulationDetailsFromSlateV3((message as StoredSlateUserMessageV3).simulation, privacyMode)
    : envelope.message.simulation === undefined
      ? undefined
      : simulationDetailsFromInterop(decodeSlateValue(envelope.message.simulation as StoredSlateValue, privacyMode))
  const modeIntent = envelope.version >= 3
    ? customModeIntentFromSlateV3((message as StoredSlateUserMessageV3).modeIntent, privacyMode)
    : envelope.message.modeIntent === undefined
      ? undefined
      : customModeIntentFromInterop(decodeSlateValue(envelope.message.modeIntent as StoredSlateValue, privacyMode))
  const decodeOptionalText = (value: StoredSlateValue | undefined) =>
    value === undefined ? undefined : decodeSlateValue(value, privacyMode) as SlateUserMessage["text"]
  const decoded: SlateUserMessage = {
    messageId: message.id,
    text: decodeSlateValue(message.content, privacyMode) as SlateUserMessage["text"],
    ...(selectedContext === undefined ? {} : { selectedContext }),
    mode: message.mode as SlateMode,
    ...(message.simulated === undefined ? {} : { isSimulatedMsg: message.simulated }),
    ...(message.promotionGroupId === undefined ? {} : { bestOfNGroupId: message.promotionGroupId }),
    ...(message.promotionEligible === undefined ? {} : { tryUseBestOfNPromotion: message.promotionEligible }),
    ...(message.richContent === undefined ? {} : { richText: decodeOptionalText(message.richContent) as SlateUserMessageText }),
    ...(message.origin === undefined
      ? {}
      : { simulatedMsgReason: message.origin as Exclude<SlateUserMessage["simulatedMsgReason"], undefined> }),
    conversationStateBlobId: fromHex(message.conversationSnapshotId),
    ...(message.workerReminder === undefined ? {} : { subagentSystemReminder: decodeOptionalText(message.workerReminder) as SlateUserMessageText }),
    ...(triggeringActor === undefined ? {} : { triggeringActor }),
    ...(planExecution === undefined ? {} : { planExecution }),
    ...(simulation === undefined ? {} : { simulation }),
    ...(message.promptReference === undefined ? {} : { promptReferenceId: message.promptReference }),
    ...(message.thread === undefined ? {} : { threadId: message.thread }),
    ...(message.contentBlobId === undefined ? {} : { textBlobId: fromHex(message.contentBlobId) }),
    ...(message.richContentBlobId === undefined ? {} : { richTextBlobId: fromHex(message.richContentBlobId) }),
    hookContexts: message.hooks.map(context => ({
      event: context.event,
      text: decodeSlateValue(context.text, privacyMode) as SlateUserMessageText,
    })),
    ...(modeIntent === undefined ? {} : { modeIntent }),
    ...(project === undefined
      ? {}
      : {
          projectDetails: {
            ...(project.name === undefined ? {} : { name: decodeOptionalText(project.name) as SlateUserMessageText }),
            ...(project.subagent === undefined
              ? {}
              : {
                  subagent: project.subagent.storeDir === undefined
                    ? {}
                    : { storeDir: decodeOptionalText(project.subagent.storeDir) as SlateUserMessageText },
                }),
            ...(project.sideChat === undefined
              ? {}
              : {
                  sideChat: project.sideChat.storeDir === undefined
                    ? {}
                    : { storeDir: decodeOptionalText(project.sideChat.storeDir) as SlateUserMessageText },
                }),
          },
        }),
    ...(envelope.compatibility === undefined ? {} : { compatibility: envelope.compatibility }),
  }
  return decoded
}

export function createSlateUserMessageSerde(privacyMode: PrivacyMode): Serde<SlateUserMessage> {
  return {
    serialize: encodeStoredSlateUserMessage,
    deserialize(bytes) {
      const stored = decodeStoredSlateUserMessage(bytes, privacyMode)
      if (stored !== undefined) return stored
      const legacy = UserMessage.fromBinary(bytes)
      const legacyUnknownFields = collectStepUnknownFields(legacy)
      const redacted = toRedactedUserMessage(legacy, privacyMode)
      const slate = fromInteropUserMessage(redacted as unknown as UserMessage)
      if (legacyUnknownFields.length === 0) return slate
      return {
        ...slate,
        compatibility: {
          ...(slate.compatibility ?? {}),
          legacyUnknownFields,
        },
      }
    },
    getBlobType() {
      return { kind: "json", typeName: USER_MESSAGE_STORAGE_FORMAT }
    },
  }
}

export function deserializeSlateUserMessageInterop(bytes: Uint8Array): UserMessage {
  const slate = createSlateUserMessageSerde(PrivacyModes.UNSPECIFIED).deserialize(bytes)
  return toPlainInteropUserMessage(slate)
}

interface StoredSlateSubagentType {
  readonly kind: string
  readonly customName?: string
  readonly compatibility?: { readonly legacyDiscriminator?: string }
}

interface StoredSlateSubagentState {
  readonly createdAtMs: string
  readonly lastUsedAtMs: string
  readonly executionEnvironment: string
  readonly conversationSnapshot?: StoredSlateValue
  readonly subagentType?: StoredSlateSubagentType
  readonly modelId?: string
  readonly cloudAgent?: { readonly agentId: string; readonly transcriptUri?: string | undefined }
  readonly firstClassAgentId?: string
  readonly requestedRuntimeBuildId?: string
  readonly targetMachine?: Record<string, unknown>
  readonly compatibility?: SlateSubagentStateCompatibility
}

interface StoredSlateSubagentStateEnvelope {
  readonly format: typeof SUBAGENT_STATE_STORAGE_FORMAT
  readonly version: 1 | 2
  readonly state: StoredSlateSubagentState
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isStoredSlateSubagentType(value: unknown): value is StoredSlateSubagentType {
  if (!isRecordValue(value) || !hasOnlyKeys(value, ["kind", "customName", "compatibility"]) ||
      typeof value.kind !== "string" || value.kind.length === 0 ||
      (value.customName !== undefined && typeof value.customName !== "string")) return false
  if (value.compatibility === undefined) return true
  return isRecordValue(value.compatibility) &&
    hasOnlyKeys(value.compatibility, ["legacyDiscriminator"]) &&
    (value.compatibility.legacyDiscriminator === undefined || typeof value.compatibility.legacyDiscriminator === "string")
}

function isStoredLegacyTaskTargetMachine(value: unknown): boolean {
  if (!isRecordValue(value) || typeof value.type !== "string") return false
  switch (value.type) {
    case "same_machine":
      return hasOnlyKeys(value, ["type"])
    case "new_cloud_vm":
      return hasOnlyKeys(value, ["type", "base_branch", "environment_build_id"]) &&
        (value.base_branch === undefined || typeof value.base_branch === "string") &&
        (value.environment_build_id === undefined || typeof value.environment_build_id === "string")
    case "self_hosted_worker":
      return hasOnlyKeys(value, ["type", "worker_id"]) && typeof value.worker_id === "string"
    case "self_hosted_pool":
      return hasOnlyKeys(value, ["type", "pool", "labels"]) &&
        (value.pool === undefined || typeof value.pool === "string") &&
        (value.labels === undefined || (isRecordValue(value.labels) && Object.values(value.labels).every(label => typeof label === "string")))
    default:
      return false
  }
}

function isStoredSlateTargetMachine(value: unknown): value is TaskTargetMachine {
  if (!isRecordValue(value) || typeof value.kind !== "string") return false
  switch (value.kind) {
    case "same-device":
      return hasOnlyKeys(value, ["kind"])
    case "cloud-machine":
      return hasOnlyKeys(value, ["kind", "baseBranch", "environmentBuildId"]) &&
        (value.baseBranch === undefined || typeof value.baseBranch === "string") &&
        (value.environmentBuildId === undefined || typeof value.environmentBuildId === "string")
    case "hosted-worker":
      return hasOnlyKeys(value, ["kind", "workerId"]) && typeof value.workerId === "string"
    case "worker-pool":
      return hasOnlyKeys(value, ["kind", "pool", "labels"]) &&
        (value.pool === undefined || typeof value.pool === "string") &&
        (value.labels === undefined || (isRecordValue(value.labels) && Object.values(value.labels).every(label => typeof label === "string")))
    default:
      return false
  }
}

function taskTargetMachineFromV1(value: unknown): TaskTargetMachine {
  const machine = value as Record<string, unknown>
  switch (machine.type) {
    case "same_machine":
      return { kind: "same-device" }
    case "new_cloud_vm":
      return {
        kind: "cloud-machine",
        ...(typeof machine.base_branch === "string" ? { baseBranch: machine.base_branch } : {}),
        ...(typeof machine.environment_build_id === "string" ? { environmentBuildId: machine.environment_build_id } : {}),
      }
    case "self_hosted_worker":
      return { kind: "hosted-worker", workerId: machine.worker_id as string }
    case "self_hosted_pool":
      return {
        kind: "worker-pool",
        ...(typeof machine.pool === "string" ? { pool: machine.pool } : {}),
        ...(isRecordValue(machine.labels)
          ? { labels: Object.fromEntries(Object.entries(machine.labels).filter((entry): entry is [string, string] => typeof entry[1] === "string")) }
          : {}),
      }
    default:
      throw new TypeError("Legacy Slate subagent target machine is unsupported")
  }
}

function isStoredSlateSubagentCompatibility(value: unknown): value is SlateSubagentStateCompatibility {
  return isRecordValue(value) && hasOnlyKeys(value, ["legacyEnvironmentCode", "legacyUnknownFields"]) &&
    (value.legacyEnvironmentCode === undefined ||
      (typeof value.legacyEnvironmentCode === "number" && Number.isInteger(value.legacyEnvironmentCode) &&
        value.legacyEnvironmentCode >= -2_147_483_648 && value.legacyEnvironmentCode <= 2_147_483_647)) &&
    (value.legacyUnknownFields === undefined ||
      (Array.isArray(value.legacyUnknownFields) && value.legacyUnknownFields.every(isStepUnknownField)))
}

function isStoredSlateSubagentStateEnvelope(value: unknown): value is StoredSlateSubagentStateEnvelope {
  if (!isRecordValue(value) || !hasOnlyKeys(value, ["format", "version", "state"]) ||
      value.format !== SUBAGENT_STATE_STORAGE_FORMAT || (value.version !== 1 && value.version !== 2) || !isRecordValue(value.state)) return false
  const state = value.state
  return hasOnlyKeys(state, [
    "createdAtMs", "lastUsedAtMs", "executionEnvironment", "conversationSnapshot", "subagentType", "modelId",
    "cloudAgent", "firstClassAgentId", "requestedRuntimeBuildId", "targetMachine", "compatibility",
  ]) &&
    typeof state.createdAtMs === "string" && isUnsignedTimestamp(state.createdAtMs) &&
    typeof state.lastUsedAtMs === "string" && isUnsignedTimestamp(state.lastUsedAtMs) &&
    typeof state.executionEnvironment === "string" && SUBAGENT_ENVIRONMENT_VALUES.has(state.executionEnvironment) &&
    (state.conversationSnapshot === undefined || isStoredSlateValue(state.conversationSnapshot)) &&
    (state.subagentType === undefined || isStoredSlateSubagentType(state.subagentType)) &&
    (state.modelId === undefined || typeof state.modelId === "string") &&
    (state.cloudAgent === undefined || (isRecordValue(state.cloudAgent) &&
      hasOnlyKeys(state.cloudAgent, ["agentId", "transcriptUri"]) && typeof state.cloudAgent.agentId === "string" &&
      (state.cloudAgent.transcriptUri === undefined || typeof state.cloudAgent.transcriptUri === "string"))) &&
    (state.firstClassAgentId === undefined || typeof state.firstClassAgentId === "string") &&
    (state.requestedRuntimeBuildId === undefined || typeof state.requestedRuntimeBuildId === "string") &&
    (state.targetMachine === undefined || (value.version === 1
      ? isStoredLegacyTaskTargetMachine(state.targetMachine)
      : isStoredSlateTargetMachine(state.targetMachine))) &&
    (state.compatibility === undefined || isStoredSlateSubagentCompatibility(state.compatibility))
}

function isUnsignedTimestamp(value: string): boolean {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) return false
  return BigInt(value) <= MAX_SUBAGENT_TIMESTAMP_MS
}

function isSlateSubagentConversationSnapshot(value: unknown): value is SlateSubagentConversationSnapshot {
  if (!isRecordValue(value) || typeof value.privacyMode !== "string" ||
      !Array.isArray(value.rootPromptMessagesJson) || !value.rootPromptMessagesJson.every(entry => entry instanceof Uint8Array) ||
      !Array.isArray(value.turns) || !value.turns.every(entry => entry instanceof Uint8Array) ||
      !Array.isArray(value.todos) || !value.todos.every(entry => entry instanceof Uint8Array) ||
      !Array.isArray(value.previousWorkspaceUris) || !Array.isArray(value.summaryArchives) ||
      !value.summaryArchives.every(entry => entry instanceof Uint8Array) ||
      !(value.fileStatesV2 instanceof Map) || !Array.isArray(value.readPaths)) return false
  return true
}

/** Writes new durable subagent references with Slate fields and imports old generated blobs on read. */
export function createSlateSubagentPersistedStateSerde(privacyMode: PrivacyMode): Serde<SlateSubagentPersistedState> {
  return {
    serialize(value) {
      const state = createSlateSubagentPersistedState(value)
      if (state.createdAtMs < 0n || state.createdAtMs > MAX_SUBAGENT_TIMESTAMP_MS ||
          state.lastUsedAtMs < 0n || state.lastUsedAtMs > MAX_SUBAGENT_TIMESTAMP_MS) {
        throw new TypeError("Slate subagent timestamps must be unsigned 64-bit milliseconds")
      }
      const envelope: StoredSlateSubagentStateEnvelope = {
        format: SUBAGENT_STATE_STORAGE_FORMAT,
        version: 2,
        state: {
          createdAtMs: state.createdAtMs.toString(),
          lastUsedAtMs: state.lastUsedAtMs.toString(),
          executionEnvironment: state.executionEnvironment,
          ...(state.conversationSnapshot === undefined
            ? {}
            : { conversationSnapshot: encodeSlateValue(state.conversationSnapshot, new Set(), "Subagent snapshot") }),
          ...(state.subagentType === undefined ? {} : { subagentType: state.subagentType }),
          ...(state.modelId === undefined ? {} : { modelId: state.modelId }),
          ...(state.cloudAgent === undefined
            ? {}
            : { cloudAgent: {
                agentId: state.cloudAgent.agentId,
                ...(state.cloudAgent.transcriptUri === undefined ? {} : { transcriptUri: state.cloudAgent.transcriptUri }),
              } }),
          ...(state.firstClassAgentId === undefined ? {} : { firstClassAgentId: state.firstClassAgentId }),
          ...(state.requestedRuntimeBuildId === undefined ? {} : { requestedRuntimeBuildId: state.requestedRuntimeBuildId }),
          ...(state.targetMachine === undefined ? {} : { targetMachine: state.targetMachine }),
          ...(state.compatibility === undefined ? {} : { compatibility: state.compatibility }),
        },
      }
      if (state.conversationSnapshot !== undefined && !isStoredSlateValue(envelope.state.conversationSnapshot)) {
        throw new TypeError("Slate subagent conversation snapshot is invalid")
      }
      if (state.subagentType !== undefined && !isStoredSlateSubagentType(state.subagentType)) {
        throw new TypeError("Slate subagent type is invalid")
      }
      if (state.targetMachine !== undefined && !isStoredSlateTargetMachine(state.targetMachine)) {
        throw new TypeError("Slate subagent target machine is invalid")
      }
      if (state.compatibility !== undefined && !isStoredSlateSubagentCompatibility(state.compatibility)) {
        throw new TypeError("Slate subagent compatibility data is invalid")
      }
      return utf8Serde.serialize(`SLATE-AGENT-SUBAGENT-STATE\n${JSON.stringify(envelope)}`)
    },
    deserialize(bytes) {
      if (!beginsWith(bytes, SUBAGENT_STATE_STORAGE_HEADER)) {
        const legacy = SubagentPersistedState.fromBinary(bytes)
        const redacted = toRedactedSubagentPersistedState(legacy, privacyMode)
        const projected = fromRedactedSubagentPersistedStateInterop(
          redacted as never,
          PrivacyCapability.UNSAFE_ALWAYS_ALLOWED,
          undefined,
        )
        return fromInteropSubagentPersistedState(projected, privacyMode, collectStepUnknownFields(legacy))
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(utf8Serde.deserialize(bytes.subarray(SUBAGENT_STATE_STORAGE_HEADER.length)))
      } catch (error) {
        throw new TypeError("Stored Slate subagent state is not valid JSON", { cause: error })
      }
      if (!isStoredSlateSubagentStateEnvelope(parsed)) throw new TypeError("Stored Slate subagent state envelope is invalid")
      const snapshot = parsed.state.conversationSnapshot === undefined
        ? undefined
        : decodeSlateValue(parsed.state.conversationSnapshot, privacyMode)
      if (snapshot !== undefined && !isSlateSubagentConversationSnapshot(snapshot)) {
        throw new TypeError("Stored Slate subagent conversation snapshot is invalid")
      }
      return createSlateSubagentPersistedState({
        createdAtMs: BigInt(parsed.state.createdAtMs),
        lastUsedAtMs: BigInt(parsed.state.lastUsedAtMs),
        executionEnvironment: parsed.state.executionEnvironment as SlateSubagentPersistedState["executionEnvironment"],
        ...(snapshot === undefined
          ? {}
          : { conversationSnapshot: { ...snapshot, privacyMode } }),
        ...(parsed.state.subagentType === undefined ? {} : { subagentType: parsed.state.subagentType as SlateSubagentType }),
        ...(parsed.state.modelId === undefined ? {} : { modelId: parsed.state.modelId as string }),
        ...(parsed.state.cloudAgent === undefined
          ? {}
          : { cloudAgent: parsed.state.cloudAgent as SlateSubagentPersistedState["cloudAgent"] }),
        ...(parsed.state.firstClassAgentId === undefined ? {} : { firstClassAgentId: parsed.state.firstClassAgentId as string }),
        ...(parsed.state.requestedRuntimeBuildId === undefined
          ? {}
          : { requestedRuntimeBuildId: parsed.state.requestedRuntimeBuildId as string }),
        ...(parsed.state.targetMachine === undefined
          ? {}
          : { targetMachine: parsed.version === 1
            ? taskTargetMachineFromV1(parsed.state.targetMachine)
            : parsed.state.targetMachine as TaskTargetMachine }),
        ...(parsed.state.compatibility === undefined
          ? {}
          : { compatibility: parsed.state.compatibility as SlateSubagentStateCompatibility }),
      })
    },
    getBlobType() {
      return { kind: "json", typeName: SUBAGENT_STATE_STORAGE_FORMAT }
    },
  }
}

export function deserializeSlateSubagentPersistedStateInterop(bytes: Uint8Array): SubagentPersistedState {
  return toInteropSubagentPersistedState(createSlateSubagentPersistedStateSerde(PrivacyModes.UNSPECIFIED).deserialize(bytes))
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

/** Agent records use Slate-owned serdes where migrated; remaining legacy codecs stay at this adapter boundary. */
export function createAgentStateMessageSerdesInterop(privacyMode: PrivacyMode) {
  return {
    shellInvocation: createSlateShellInvocationSerde(privacyMode, importLegacyShellInvocation),
    shellResult: createSlateShellResultSerde(privacyMode, importLegacyShellResult),
    userMessage: createSlateUserMessageSerde(privacyMode),
    conversationStep: createRedactedProtoSerde(ConversationStep, toRedactedConversationStep, serdeDecoder(fromRedactedConversationStep), privacyMode),
    conversationSummary: createSlateConversationSummarySerde(privacyMode),
    conversationSummaryArchive: createSlateConversationSummaryArchiveSerde(privacyMode),
    conversationPlan: createSlateConversationPlanSerde(privacyMode),
    todoItem: createSlateTodoItemSerde(privacyMode),
    subagentPersistedState: createSlateSubagentPersistedStateSerde(privacyMode),
  }
}

export function deserializeSlateShellInvocationInterop(bytes: Uint8Array) {
  return shellInvocationToRunner(createSlateShellInvocationSerde(
    PrivacyModes.UNSPECIFIED,
    importLegacyShellInvocation,
  ).deserialize(bytes))
}

export function deserializeSlateShellResultInterop(bytes: Uint8Array) {
  return shellResultToRunner(createSlateShellResultSerde(
    PrivacyModes.UNSPECIFIED,
    importLegacyShellResult,
  ).deserialize(bytes))
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
export const toRedactedSubagentPersistedStateInterop = toRedactedSubagentPersistedState
export const toRedactedUserMessageInterop = toRedactedUserMessage
export const fromRedactedTodoItemInterop = fromRedactedTodoItem
export const toRedactedTodoItemInterop = toRedactedTodoItem
export const createRedactedConversationTokenDetailsInterop = createRedactedConversationTokenDetails
