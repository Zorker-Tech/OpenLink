import type {
  SlateSubagentExecutionEnvironment,
} from "./subagent-run-state.ts"
import type { SlateSubagentTypeLike } from "./subagent-type.ts"
import type {
  CloudSubagentPersistedStateArgs,
  TaskTargetMachine,
} from "./tools/task-runtime-types.ts"

/**
 * The product-owned top-level shape of a subagent conversation snapshot.
 *
 * Turn blobs are the durable conversation references. Other fields remain opaque here until the shared
 * conversation snapshot itself is migrated; the interop adapter preserves them when crossing the legacy
 * storage and launch boundaries.
 */
export interface SlateTaskConversationState {
  readonly turns: readonly Uint8Array[]
  readonly [key: string]: unknown
}

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
  return { turns: [] }
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
  readonly conversationState: Pick<SlateTaskConversationState, "turns">
  readonly modelId: string | undefined
}): SlateSubagentPersistedState {
  return createSlateSubagentPersistedState({
    conversationState: input.conversationState as SlateTaskConversationState,
    ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
  })
}
