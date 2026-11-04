import type {
  SlateSubagentExecutionEnvironment,
} from "./subagent-run-state.ts"
import type { SlateSubagentTypeLike } from "./subagent-type.ts"
import type {
  CloudSubagentPersistedStateArgs,
  TaskTargetMachine,
} from "./tools/task-runtime-types.ts"
import { PrivacyMode } from "../redaction/privacy-mode.ts"
import type { SlateConversationState } from "./conversation-state.ts"

/** Subagent snapshots use the same first-party conversation schema as their owning conversation. */
export type SlateTaskConversationState = SlateConversationState

export interface SlateSubagentCloudReference {
  readonly bcId: string
  readonly transcriptPath?: string | undefined
}

/** Everything Slate needs to resume a subagent without importing the external persisted message. */
export interface SlateSubagentPersistedState {
  readonly conversationState?: SlateTaskConversationState | undefined
  readonly createdTimestampMs: bigint
  readonly lastUsedTimestampMs: bigint
  readonly subagentType?: SlateSubagentTypeLike | undefined
  readonly modelId?: string | undefined
  readonly environment: SlateSubagentExecutionEnvironment
  readonly cloudSubagent?: SlateSubagentCloudReference | undefined
  readonly firstClassBcId?: string | undefined
  readonly cloudRequestedEnvironmentBuildId?: string | undefined
  readonly machine?: TaskTargetMachine | undefined
}

export function createEmptySlateTaskConversationState(): SlateTaskConversationState {
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

/** Creates a persisted subagent record with stable empty defaults and only the supplied optional fields. */
export function createSlateSubagentPersistedState(
  input: Partial<SlateSubagentPersistedState> = {},
): SlateSubagentPersistedState {
  return {
    createdTimestampMs: input.createdTimestampMs ?? BigInt(0),
    lastUsedTimestampMs: input.lastUsedTimestampMs ?? BigInt(0),
    environment: input.environment ?? "unspecified",
    ...(input.conversationState === undefined ? {} : { conversationState: input.conversationState }),
    ...(input.subagentType === undefined ? {} : { subagentType: input.subagentType }),
    ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
    ...(input.cloudSubagent === undefined ? {} : { cloudSubagent: input.cloudSubagent }),
    ...(input.firstClassBcId === undefined ? {} : { firstClassBcId: input.firstClassBcId }),
    ...(input.cloudRequestedEnvironmentBuildId === undefined
      ? {}
      : { cloudRequestedEnvironmentBuildId: input.cloudRequestedEnvironmentBuildId }),
    ...(input.machine === undefined ? {} : { machine: input.machine }),
  }
}

export function createSlateLocalSubagentPersistedState(
  modelId: string | undefined,
): SlateSubagentPersistedState {
  return createSlateSubagentPersistedState({
    environment: "local",
    ...(modelId === undefined ? {} : { modelId }),
  })
}

export function createSlateCloudSubagentPersistedState(
  input: CloudSubagentPersistedStateArgs,
): SlateSubagentPersistedState {
  return createSlateSubagentPersistedState({
    environment: "cloud",
    cloudSubagent: {
      bcId: input.bcId,
      ...(input.transcriptPath === undefined ? {} : { transcriptPath: input.transcriptPath }),
    },
    machine: input.machine,
    ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
  })
}

export function createSlateSubagentConversationState(input: {
  readonly conversationState: SlateTaskConversationState
  readonly modelId: string | undefined
}): SlateSubagentPersistedState {
  return createSlateSubagentPersistedState({
    conversationState: input.conversationState,
    ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
  })
}
