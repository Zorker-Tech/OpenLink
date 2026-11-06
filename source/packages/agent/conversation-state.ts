/** Slate's in-memory conversation snapshot, before historical serialization. */
import type { PrivacyMode } from "../redaction/privacy-mode.ts"
import type { SlateGoalState, SlatePlanRegistryEntry } from "./goal-state.ts"
import type { SlateSubagentPersistedState } from "./subagent-persisted-state.ts"
import type { SlateSubagentRunState } from "./subagent-run-state.ts"
import type { SlateMode } from "./mode-processing.ts"

export interface SlateRedactedValue<T> {
  unwrap(purpose: import("../redaction/classification.ts").PrivacyCapability, options?: object): T
}

export interface SlateConversationTokenDetails {
  readonly promptContextUsageTree?: unknown
  readonly [key: string]: unknown
}

export interface SlateFileStateBlobs {
  readonly contentBlobId?: Uint8Array
  readonly initialContentBlobId?: Uint8Array
}

export interface SlateTrackedGitRepository {
  readonly repoPath: SlateRedactedValue<string>
  readonly branchName: string
}

export interface SlateConversationState {
  readonly privacyMode: PrivacyMode
  readonly rootPromptMessagesJson: readonly Uint8Array[]
  readonly turns: readonly Uint8Array[]
  readonly todos: readonly Uint8Array[]
  readonly pendingToolCalls?: readonly SlateRedactedValue<string>[]
  readonly tokenDetails?: SlateConversationTokenDetails
  readonly summary?: Uint8Array
  readonly plan?: Uint8Array
  readonly previousWorkspaceUris: readonly SlateRedactedValue<string>[]
  mode?: SlateMode
  /** Unknown persisted mode retained for lossless checkpoint write-back. */
  unknownModeCode?: number
  readonly summaryArchives: readonly Uint8Array[]
  readonly fileStatesV2: ReadonlyMap<string, SlateFileStateBlobs>
  readonly selfSummaryCount?: number
  readonly readPaths: readonly string[]
  readonly activeBranchName?: string
  readonly plans?: ReadonlyMap<string, SlatePlanRegistryEntry>
  readonly trackedGitRepoBranches?: readonly SlateTrackedGitRepository[]
  readonly agentType?: string
  readonly communicateUpdateHistory?: readonly {
    readonly step: SlateRedactedValue<string>
    readonly messageIndex: number
  }[]
  readonly subagentThreads?: ReadonlyMap<string, string> | Record<string, string>
  readonly communicateUpdateFinalSummary?: SlateRedactedValue<string>
  readonly communicateUpdateCompletedSubtitle?: SlateRedactedValue<string>
  readonly communicateUpdateStatesByParentToolCallId?: ReadonlyMap<string, unknown> | Record<string, unknown>
  readonly subagentStates?: ReadonlyMap<string, SlateSubagentPersistedState>
  readonly subagentRunsByParentToolCallId?: ReadonlyMap<string, SlateSubagentRunState>
  readonly conversationStartedTimestampMs?: bigint
  readonly conversationStartedTimeZone?: string
  readonly subagentStateRefs?: ReadonlyMap<string, Uint8Array>
  readonly goalState?: SlateGoalState
  readonly isRootProjectConversation?: boolean
  readonly completedAskQuestionToolCallIds?: readonly string[]
}
