/** Slate's in-memory conversation snapshot, before historical serialization. */
import type { PrivacyMode } from "../redaction/privacy-mode.ts"
import type { SlateGoalState, SlatePlanRegistryEntry } from "./goal-state.ts"
import type { SlateSubagentPersistedState } from "./subagent-persisted-state.ts"
import type { SlateSubagentRunState } from "./subagent-run-state.ts"
import type { SlateMode } from "./mode-processing.ts"
import type {
  PromptContextUsageTreeValue,
  PromptTokenBreakdownSnapshotValue,
} from "./utils/prompt-usage-contracts.ts"

export interface SlateRedactedValue<T> {
  unwrap(purpose: import("../redaction/classification.ts").PrivacyCapability, options?: object): T
}

export type SlateConversationTokenDetailCompatibilityValue =
  | null
  | boolean
  | number
  | string
  | bigint
  | Uint8Array
  | Date
  | SlateRedactedValue<string>
  | SlateRedactedValue<Uint8Array>
  | SlateConversationTokenDetailLegacyMessage
  | readonly SlateConversationTokenDetailCompatibilityValue[]
  | ReadonlyMap<SlateConversationTokenDetailCompatibilityValue, SlateConversationTokenDetailCompatibilityValue>
  | ReadonlySet<SlateConversationTokenDetailCompatibilityValue>
  | SlateConversationTokenDetailCompatibilityObject

export interface SlateConversationTokenDetailLegacyMessage {
  readonly kind: "legacy-protobuf-message"
  readonly typeName: string
  readonly binary: Uint8Array
}

export interface SlateConversationTokenDetailCompatibilityObject {
  readonly [key: string]: SlateConversationTokenDetailCompatibilityValue
}

export interface SlateConversationTokenDetailsCompatibility {
  readonly legacyFields?: Readonly<Record<string, SlateConversationTokenDetailCompatibilityValue>>
}

export interface SlateConversationTokenDetails {
  readonly usedTokens: number
  readonly maximumTokens: number
  readonly breakdown?: PromptTokenBreakdownSnapshotValue
  readonly contextTree?: PromptContextUsageTreeValue
  readonly usageSnapshotBlobId?: Uint8Array
  readonly compatibility?: SlateConversationTokenDetailsCompatibility
}

export interface SlateCommunicationHistoryEntry {
  readonly step: string
  readonly messageIndex: number
}

export interface SlateCommunicationTurnState {
  readonly history: readonly SlateCommunicationHistoryEntry[]
  readonly finalSummary?: string
  readonly completedSubtitle?: string
}

export interface SlateFileStateBlobs {
  readonly contentBlobId?: Uint8Array
  readonly initialContentBlobId?: Uint8Array
}

export interface SlateTrackedGitRepository {
  readonly repoPath: string
  readonly branchName: string
}

export interface SlateConversationState {
  readonly privacyMode: PrivacyMode
  readonly rootPromptMessagesJson: readonly Uint8Array[]
  readonly turns: readonly Uint8Array[]
  readonly todos: readonly Uint8Array[]
  readonly pendingToolCalls?: readonly string[]
  readonly tokenDetails?: SlateConversationTokenDetails
  readonly summary?: Uint8Array
  readonly plan?: Uint8Array
  readonly previousWorkspaceUris: readonly string[]
  mode?: SlateMode
  /** Unknown persisted mode retained for lossless checkpoint write-back. */
  unknownModeCode?: number
  readonly summaryArchives: readonly Uint8Array[]
  readonly legacyFileContentBlobIds?: ReadonlyMap<string, Uint8Array> | Record<string, Uint8Array>
  readonly fileStatesV2: ReadonlyMap<string, SlateFileStateBlobs>
  readonly selfSummaryCount?: number
  readonly readPaths: readonly string[]
  readonly activeBranchName?: string
  readonly plans?: ReadonlyMap<string, SlatePlanRegistryEntry>
  readonly trackedGitRepoBranches?: readonly SlateTrackedGitRepository[]
  readonly agentType?: string
  readonly communicationHistory?: readonly SlateCommunicationHistoryEntry[]
  readonly subagentThreads?: ReadonlyMap<string, string> | Record<string, string>
  readonly communicationFinalSummary?: string
  readonly communicationCompletedSubtitle?: string
  readonly communicationTurnsByCallId?: ReadonlyMap<string, SlateCommunicationTurnState> | Record<string, SlateCommunicationTurnState>
  readonly subagentStates?: ReadonlyMap<string, SlateSubagentPersistedState>
  readonly subagentRunsByParentToolCallId?: ReadonlyMap<string, SlateSubagentRunState>
  readonly conversationStartedTimestampMs?: bigint
  readonly conversationStartedTimeZone?: string
  readonly subagentStateRefs?: ReadonlyMap<string, Uint8Array>
  readonly goalState?: SlateGoalState
  readonly isRootProjectConversation?: boolean
  readonly completedAskQuestionToolCallIds?: readonly string[]
}
