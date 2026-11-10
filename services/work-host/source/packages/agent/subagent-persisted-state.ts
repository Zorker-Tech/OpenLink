import type { SlateSubagentExecutionEnvironment } from "./subagent-run-state.ts"
import { createSlateSubagentType, type SlateSubagentType } from "./subagent-type.ts"
import { cloneTaskTargetMachine, type CloudSubagentPersistedStateArgs, type TaskTargetMachine } from "./tools/task-runtime-types.ts"
import { PrivacyMode } from "../redaction/privacy-mode.ts"
import type { SlateConversationState } from "./conversation-state.ts"

/** Subagent snapshots use the same first-party conversation schema as their owning conversation. */
export type SlateSubagentConversationSnapshot = SlateConversationState
export type SlateTaskConversationState = SlateSubagentConversationSnapshot

export interface SlateSubagentCloudAgent {
  readonly agentId: string
  readonly transcriptUri?: string | undefined
}

/** Product-owned state required to resume a delegated task. */
export interface SlateSubagentPersistedState {
  readonly conversationSnapshot?: SlateSubagentConversationSnapshot | undefined
  readonly createdAtMs: bigint
  readonly lastUsedAtMs: bigint
  readonly subagentType?: SlateSubagentType | undefined
  readonly modelId?: string | undefined
  readonly executionEnvironment: SlateSubagentExecutionEnvironment
  readonly cloudAgent?: SlateSubagentCloudAgent | undefined
  readonly firstClassAgentId?: string | undefined
  readonly requestedRuntimeBuildId?: string | undefined
  readonly targetMachine?: TaskTargetMachine | undefined
}

export function createEmptySlateSubagentConversationSnapshot(): SlateSubagentConversationSnapshot {
  return {
    privacyMode: PrivacyMode.UNSPECIFIED,
    rootPromptMessagesJson: [],
    turns: [],
    todos: [],
    previousWorkspaceUris: [],
    summaryArchives: [],
    fileStatesV2: new Map(),
    readPaths: [],
  }
}

/** Creates a persisted subagent record with stable defaults and only supplied optional values. */
export function createSlateSubagentPersistedState(
  input: Partial<SlateSubagentPersistedState> = {},
): SlateSubagentPersistedState {
  return {
    createdAtMs: input.createdAtMs ?? BigInt(0),
    lastUsedAtMs: input.lastUsedAtMs ?? BigInt(0),
    executionEnvironment: input.executionEnvironment ?? "unspecified",
    ...(input.conversationSnapshot === undefined ? {} : { conversationSnapshot: input.conversationSnapshot }),
    ...(input.subagentType === undefined ? {} : {
      subagentType: createSlateSubagentType(input.subagentType.kind, {
        ...(input.subagentType.customName === undefined ? {} : { customName: input.subagentType.customName }),
      }),
    }),
    ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
    ...(input.cloudAgent === undefined ? {} : { cloudAgent: { ...input.cloudAgent } }),
    ...(input.firstClassAgentId === undefined ? {} : { firstClassAgentId: input.firstClassAgentId }),
    ...(input.requestedRuntimeBuildId === undefined
      ? {}
      : { requestedRuntimeBuildId: input.requestedRuntimeBuildId }),
    ...(input.targetMachine === undefined ? {} : { targetMachine: cloneTaskTargetMachine(input.targetMachine) }),
  }
}

export function createSlateLocalSubagentPersistedState(
  modelId: string | undefined,
): SlateSubagentPersistedState {
  return createSlateSubagentPersistedState({
    executionEnvironment: "local",
    ...(modelId === undefined ? {} : { modelId }),
  })
}

export function createSlateCloudSubagentPersistedState(
  input: CloudSubagentPersistedStateArgs,
): SlateSubagentPersistedState {
  return createSlateSubagentPersistedState({
    executionEnvironment: "cloud",
    cloudAgent: {
      agentId: input.agentId,
      ...(input.transcriptUri === undefined ? {} : { transcriptUri: input.transcriptUri }),
    },
    targetMachine: input.targetMachine,
    ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
  })
}

export function createSlateSubagentConversationState(input: {
  readonly conversationSnapshot: SlateSubagentConversationSnapshot
  readonly modelId: string | undefined
}): SlateSubagentPersistedState {
  return createSlateSubagentPersistedState({
    conversationSnapshot: input.conversationSnapshot,
    ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
  })
}
