/** Slate's product record for a user message while it is becoming a conversation turn. */
import type { HookContextEntry } from "../hooks-carriers/hook-additional-context.ts"
import type { SlateMode } from "./mode-processing.ts"

export const SlateSimulatedMessageReason = {
  UNSPECIFIED: "unspecified",
  PLAN_EXECUTION: "plan-execution",
  COMMIT_REMINDER: "commit-reminder",
  BACKGROUND_TASK_COMPLETION: "background-task-completion",
  DIFF_TAB_COMMIT: "diff-tab-commit",
  DIFF_TAB_COMMIT_AND_PUSH: "diff-tab-commit-and-push",
  DIFF_TAB_PUSH: "diff-tab-push",
  DIFF_TAB_CREATE_PR: "diff-tab-create-pr",
  DIFF_TAB_FIX_MERGE_CONFLICTS: "diff-tab-fix-merge-conflicts",
  USER_SENT_TO_SUBAGENT: "user-sent-to-subagent",
  USER_INTERRUPTED_SUBAGENT: "user-interrupted-subagent",
  USER_QUEUED_TO_SUBAGENT: "user-queued-to-subagent",
  BABYSIT_PR_IN_CLOUD: "babysit-pr-in-cloud",
  CI_PANEL_INVESTIGATE_FAILURE: "ci-panel-investigate-failure",
  MULTITASK: "multitask",
  BUILD_IN_PARALLEL: "build-in-parallel",
  MULTITASK_SPLIT_PRS: "multitask-split-prs",
  APPLY_LOCALLY: "apply-locally",
  CHECKOUT_BRANCH: "checkout-branch",
  DIFF_TAB_UPDATE_BRANCH: "diff-tab-update-branch",
  PR_TAB_AUTOMATED_REVIEW_FIX: "pr-tab-automated-review-fix",
  RUN_AUTOMATED_REVIEW: "run-automated-review",
  RUN_SECURITY_REVIEW: "run-security-review",
  FSD_APPLY_FINDING: "fsd-apply-finding",
  FSD_UNDO_FINDING: "fsd-undo-finding",
  FSD_START: "fsd-start",
  FSD_PR_INTERRUPT: "fsd-pr-interrupt",
  SUBSCRIPTION: "subscription",
  DIFF_TAB_CREATE_BRANCH: "diff-tab-create-branch",
  AGENT_STORE_CONFLICT: "agent-store-conflict",
  GOAL_CONTINUATION: "goal-continuation",
  PROJECT_KICKOFF: "project-kickoff",
} as const

export type SlateSimulatedMessageReason =
  (typeof SlateSimulatedMessageReason)[keyof typeof SlateSimulatedMessageReason]
  | `unknown-${number}`

export interface SlateProjectConversationDetails {
  name?: string
  subagent?: SlateProjectSubagentDetails
  sideChat?: SlateProjectSideChatDetails
}

export interface SlateProjectSubagentDetails {
  storeDir?: string
}

export interface SlateProjectSideChatDetails {
  storeDir?: string
}

/**
 * The top-level user-message record needed while a turn is prepared.
 *
 * Nested selected-context, simulated metadata and custom-mode values remain opaque until their own
 * product models are introduced. They are carried unchanged through the compatibility adapter.
 */
export interface SlateUserMessage {
  text: string
  messageId: string
  selectedContext?: unknown
  mode: SlateMode
  /** Unknown persisted mode retained for lossless write-back while policy uses Slate's fallback. */
  unknownModeCode?: number
  isSimulatedMsg?: boolean
  bestOfNGroupId?: string
  tryUseBestOfNPromotion?: boolean
  richText?: string
  simulatedMsgReason?: SlateSimulatedMessageReason
  conversationStateBlobId: Uint8Array
  subagentSystemReminder?: string
  triggeringUserInfo?: unknown
  executePlanInfo?: unknown
  simulatedMessageMetadata?: unknown
  promptReferenceId?: string
  threadId?: string
  textBlobId?: Uint8Array
  richTextBlobId?: Uint8Array
  hookContexts: readonly HookContextEntry[]
  customModeIntent?: unknown
  projectDetails?: SlateProjectConversationDetails
}

function cloneBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes)
}

function copyProjectDetails(
  details: SlateProjectConversationDetails | undefined,
): SlateProjectConversationDetails | undefined {
  return details === undefined
    ? undefined
    : {
        ...(details.name === undefined ? {} : { name: details.name }),
        ...(details.subagent === undefined
          ? {}
          : {
              subagent: {
                ...(details.subagent.storeDir === undefined ? {} : { storeDir: details.subagent.storeDir }),
              },
            }),
        ...(details.sideChat === undefined
          ? {}
          : {
              sideChat: {
                ...(details.sideChat.storeDir === undefined ? {} : { storeDir: details.sideChat.storeDir }),
              },
            }),
      }
}

/** Copies mutable inputs while sharing only opaque nested wire values that have no Slate projector yet. */
export function cloneSlateUserMessage(message: SlateUserMessage): SlateUserMessage {
  const projectDetails = message.projectDetails === undefined
    ? undefined
    : copyProjectDetails(message.projectDetails)
  return {
    text: message.text,
    messageId: message.messageId,
    ...(message.selectedContext === undefined ? {} : { selectedContext: message.selectedContext }),
    mode: message.mode,
    ...(message.unknownModeCode === undefined ? {} : { unknownModeCode: message.unknownModeCode }),
    ...(message.isSimulatedMsg === undefined ? {} : { isSimulatedMsg: message.isSimulatedMsg }),
    ...(message.bestOfNGroupId === undefined ? {} : { bestOfNGroupId: message.bestOfNGroupId }),
    ...(message.tryUseBestOfNPromotion === undefined
      ? {}
      : { tryUseBestOfNPromotion: message.tryUseBestOfNPromotion }),
    ...(message.richText === undefined ? {} : { richText: message.richText }),
    ...(message.simulatedMsgReason === undefined ? {} : { simulatedMsgReason: message.simulatedMsgReason }),
    conversationStateBlobId: cloneBytes(message.conversationStateBlobId),
    ...(message.subagentSystemReminder === undefined
      ? {}
      : { subagentSystemReminder: message.subagentSystemReminder }),
    ...(message.triggeringUserInfo === undefined ? {} : { triggeringUserInfo: message.triggeringUserInfo }),
    ...(message.executePlanInfo === undefined ? {} : { executePlanInfo: message.executePlanInfo }),
    ...(message.simulatedMessageMetadata === undefined
      ? {}
      : { simulatedMessageMetadata: message.simulatedMessageMetadata }),
    ...(message.promptReferenceId === undefined ? {} : { promptReferenceId: message.promptReferenceId }),
    ...(message.threadId === undefined ? {} : { threadId: message.threadId }),
    ...(message.textBlobId === undefined ? {} : { textBlobId: cloneBytes(message.textBlobId) }),
    ...(message.richTextBlobId === undefined ? {} : { richTextBlobId: cloneBytes(message.richTextBlobId) }),
    hookContexts: message.hookContexts.map(context => ({ ...context })),
    ...(message.customModeIntent === undefined ? {} : { customModeIntent: message.customModeIntent }),
    ...(projectDetails === undefined ? {} : { projectDetails }),
  }
}
