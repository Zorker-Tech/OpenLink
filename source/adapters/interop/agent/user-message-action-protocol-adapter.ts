import {
  AgentMode,
  ProjectDetails,
  SimulatedMsgReason,
  UserMessage,
} from "../proto/generated/agent/v1/agent_pb.ts"
import { TodoStatus } from "../proto/generated/agent/v1/todo_tool_pb.ts"
import { RequestContext } from "../proto/generated/agent/v1/request_context_exec_pb.ts"
import {
  createRedactedConversationTokenDetails,
  fromRedactedConversationPlan,
  fromRedactedToolCall,
  fromRedactedUserMessage,
  toRedactedConversationPlan,
  toRedactedInteractionUpdate,
  toRedactedToolCall,
} from "../redacted-protos/generated/agent/v1/agent_redacted.ts"
import {
  fromRedactedTodoItem,
  toRedactedTodoItem,
} from "../redacted-protos/generated/agent/v1/todo_tool_redacted.ts"
import { fromRedactedMcpToolDefinition } from "../redacted-protos/generated/agent/v1/mcp_redacted.ts"
import { fromRedactedRequestContext } from "../redacted-protos/generated/agent/v1/request_context_exec_redacted.ts"
import {
  fromInteropHookContextMessages,
  toInteropHookContextMessages,
} from "./hook-context-adapter.ts"
import { fromInteropAgentMode, toInteropAgentMode } from "./mode-processing-adapter.ts"
import {
  SlateSimulatedMessageReason,
  type SlateSimulatedMessageReason as SlateSimulatedMessageReasonValue,
  type SlateUserMessage,
} from "../../../packages/agent/user-message-state.ts"
import { SlateMode } from "../../../packages/agent/mode-processing.ts"

export const AgentModeInterop = AgentMode
export type AgentModeInterop = AgentMode
export const TodoStatusInterop = TodoStatus
export type RequestContextInterop = RequestContext
export type UserMessageInterop = UserMessage

export const createRedactedConversationTokenDetailsInterop = createRedactedConversationTokenDetails
export const fromRedactedConversationPlanInterop = fromRedactedConversationPlan
export const fromRedactedToolCallInterop = fromRedactedToolCall
export const fromRedactedUserMessageInterop = fromRedactedUserMessage
export const toRedactedConversationPlanInterop = toRedactedConversationPlan
export const toRedactedInteractionUpdateInterop = toRedactedInteractionUpdate
export const toRedactedToolCallInterop = toRedactedToolCall
export const fromRedactedTodoItemInterop = fromRedactedTodoItem
export const toRedactedTodoItemInterop = toRedactedTodoItem
export const fromRedactedMcpToolDefinitionInterop = fromRedactedMcpToolDefinition
export const fromRedactedRequestContextInterop = fromRedactedRequestContext

export function createSyntheticUserMessageInterop(input: {
  readonly text: string
  readonly messageId: string
  readonly isSimulatedMsg: boolean
}): UserMessageInterop {
  return new UserMessage(input)
}

export function cloneUserMessageInterop(message: UserMessageInterop): UserMessageInterop {
  return new UserMessage({ ...message })
}

export function hookContextsFromUserMessageInterop(
  message: UserMessageInterop,
): ReturnType<typeof fromInteropHookContextMessages> {
  return Array.isArray(message.hookAdditionalContexts)
    ? fromInteropHookContextMessages(message.hookAdditionalContexts)
    : []
}

export function attachSelectedContextToUserMessageInterop(input: {
  readonly message: UserMessageInterop
  readonly selectedContext: unknown
  readonly promptReferenceId?: string
}): UserMessageInterop {
  return new UserMessage({
    ...input.message,
    ...(input.promptReferenceId === undefined ? {} : { promptReferenceId: input.promptReferenceId }),
    selectedContext: input.selectedContext as never,
  })
}

const INTEROP_TO_SLATE_SIMULATED_REASON = new Map<number, SlateSimulatedMessageReasonValue>([
  [SimulatedMsgReason.UNSPECIFIED, SlateSimulatedMessageReason.UNSPECIFIED],
  [SimulatedMsgReason.PLAN_EXECUTION, SlateSimulatedMessageReason.PLAN_EXECUTION],
  [SimulatedMsgReason.COMMIT_REMINDER, SlateSimulatedMessageReason.COMMIT_REMINDER],
  [SimulatedMsgReason.BACKGROUND_TASK_COMPLETION, SlateSimulatedMessageReason.BACKGROUND_TASK_COMPLETION],
  [SimulatedMsgReason.DIFF_TAB_COMMIT, SlateSimulatedMessageReason.DIFF_TAB_COMMIT],
  [SimulatedMsgReason.DIFF_TAB_COMMIT_AND_PUSH, SlateSimulatedMessageReason.DIFF_TAB_COMMIT_AND_PUSH],
  [SimulatedMsgReason.DIFF_TAB_PUSH, SlateSimulatedMessageReason.DIFF_TAB_PUSH],
  [SimulatedMsgReason.DIFF_TAB_CREATE_PR, SlateSimulatedMessageReason.DIFF_TAB_CREATE_PR],
  [SimulatedMsgReason.DIFF_TAB_FIX_MERGE_CONFLICTS, SlateSimulatedMessageReason.DIFF_TAB_FIX_MERGE_CONFLICTS],
  [SimulatedMsgReason.USER_SENT_TO_SUBAGENT, SlateSimulatedMessageReason.USER_SENT_TO_SUBAGENT],
  [SimulatedMsgReason.USER_INTERRUPTED_SUBAGENT, SlateSimulatedMessageReason.USER_INTERRUPTED_SUBAGENT],
  [SimulatedMsgReason.USER_QUEUED_TO_SUBAGENT, SlateSimulatedMessageReason.USER_QUEUED_TO_SUBAGENT],
  [SimulatedMsgReason.BABYSIT_PR_IN_CLOUD, SlateSimulatedMessageReason.BABYSIT_PR_IN_CLOUD],
  [SimulatedMsgReason.CI_PANEL_INVESTIGATE_FAILURE, SlateSimulatedMessageReason.CI_PANEL_INVESTIGATE_FAILURE],
  [SimulatedMsgReason.MULTITASK, SlateSimulatedMessageReason.MULTITASK],
  [SimulatedMsgReason.BUILD_IN_PARALLEL, SlateSimulatedMessageReason.BUILD_IN_PARALLEL],
  [SimulatedMsgReason.MULTITASK_SPLIT_PRS, SlateSimulatedMessageReason.MULTITASK_SPLIT_PRS],
  [SimulatedMsgReason.APPLY_LOCALLY, SlateSimulatedMessageReason.APPLY_LOCALLY],
  [SimulatedMsgReason.CHECKOUT_BRANCH, SlateSimulatedMessageReason.CHECKOUT_BRANCH],
  [SimulatedMsgReason.DIFF_TAB_UPDATE_BRANCH, SlateSimulatedMessageReason.DIFF_TAB_UPDATE_BRANCH],
  [SimulatedMsgReason.PR_TAB_BUGBOT_FIX, SlateSimulatedMessageReason.PR_TAB_AUTOMATED_REVIEW_FIX],
  [SimulatedMsgReason.RUN_BUGBOT_REVIEW, SlateSimulatedMessageReason.RUN_AUTOMATED_REVIEW],
  [SimulatedMsgReason.RUN_SECURITY_REVIEW, SlateSimulatedMessageReason.RUN_SECURITY_REVIEW],
  [SimulatedMsgReason.FSD_APPLY_FINDING, SlateSimulatedMessageReason.FSD_APPLY_FINDING],
  [SimulatedMsgReason.FSD_UNDO_FINDING, SlateSimulatedMessageReason.FSD_UNDO_FINDING],
  [SimulatedMsgReason.FSD_START, SlateSimulatedMessageReason.FSD_START],
  [SimulatedMsgReason.FSD_PR_INTERRUPT, SlateSimulatedMessageReason.FSD_PR_INTERRUPT],
  [SimulatedMsgReason.SUBSCRIPTION, SlateSimulatedMessageReason.SUBSCRIPTION],
  [SimulatedMsgReason.DIFF_TAB_CREATE_BRANCH, SlateSimulatedMessageReason.DIFF_TAB_CREATE_BRANCH],
  [SimulatedMsgReason.AGENT_STORE_CONFLICT, SlateSimulatedMessageReason.AGENT_STORE_CONFLICT],
  [SimulatedMsgReason.GOAL_CONTINUATION, SlateSimulatedMessageReason.GOAL_CONTINUATION],
  [SimulatedMsgReason.PROJECT_KICKOFF, SlateSimulatedMessageReason.PROJECT_KICKOFF],
])

const SLATE_TO_INTEROP_SIMULATED_REASON = new Map<SlateSimulatedMessageReasonValue, SimulatedMsgReason>(
  [...INTEROP_TO_SLATE_SIMULATED_REASON].map(([code, reason]) => [reason, code]),
)

export function fromInteropSimulatedMessageReason(
  reason: SimulatedMsgReason | undefined,
): SlateSimulatedMessageReasonValue | undefined {
  if (reason === undefined) return undefined
  return INTEROP_TO_SLATE_SIMULATED_REASON.get(reason) ?? `unknown-${reason}`
}

export function toInteropSimulatedMessageReason(
  reason: SlateSimulatedMessageReasonValue | undefined,
): SimulatedMsgReason {
  if (reason === undefined) return SimulatedMsgReason.UNSPECIFIED
  const known = SLATE_TO_INTEROP_SIMULATED_REASON.get(reason)
  if (known !== undefined) return known
  const unknown = /^unknown-(-?\d+)$/.exec(reason)
  return unknown === null ? SimulatedMsgReason.UNSPECIFIED : Number(unknown[1]) as SimulatedMsgReason
}

/** Projects the generated message into the record consumed by Slate's turn policy. */
export function fromInteropUserMessage(message: UserMessageInterop): SlateUserMessage {
  const mode = fromInteropAgentMode(message.mode) ?? SlateMode.UNSPECIFIED
  const simulatedMsgReason = message.simulatedMsgReason === undefined
    ? undefined
    : fromInteropSimulatedMessageReason(message.simulatedMsgReason)
  return {
    text: message.text,
    messageId: message.messageId,
    ...(message.selectedContext === undefined ? {} : { selectedContext: message.selectedContext }),
    mode,
    ...(toInteropAgentMode(mode) === message.mode ? {} : { unknownModeCode: message.mode }),
    ...(message.isSimulatedMsg === undefined ? {} : { isSimulatedMsg: message.isSimulatedMsg }),
    ...(message.bestOfNGroupId === undefined ? {} : { bestOfNGroupId: message.bestOfNGroupId }),
    ...(message.tryUseBestOfNPromotion === undefined
      ? {}
      : { tryUseBestOfNPromotion: message.tryUseBestOfNPromotion }),
    ...(message.richText === undefined ? {} : { richText: message.richText }),
    ...(simulatedMsgReason === undefined ? {} : { simulatedMsgReason }),
    conversationStateBlobId: new Uint8Array(message.conversationStateBlobId),
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
    ...(message.textBlobId === undefined ? {} : { textBlobId: new Uint8Array(message.textBlobId) }),
    ...(message.richTextBlobId === undefined
      ? {}
      : { richTextBlobId: new Uint8Array(message.richTextBlobId) }),
    hookContexts: fromInteropHookContextMessages(message.hookAdditionalContexts),
    ...(message.customModeIntent === undefined ? {} : { customModeIntent: message.customModeIntent }),
    ...(message.projectDetails === undefined
      ? {}
      : {
          projectDetails: {
            ...(message.projectDetails.name === undefined ? {} : { name: message.projectDetails.name }),
            ...(message.projectDetails.subagent === undefined
              ? {}
              : {
                  subagent: {
                    ...(message.projectDetails.subagent.storeDir === undefined
                      ? {}
                      : { storeDir: message.projectDetails.subagent.storeDir }),
                  },
                }),
            ...(message.projectDetails.sideChat === undefined
              ? {}
              : {
                  sideChat: {
                    ...(message.projectDetails.sideChat.storeDir === undefined
                      ? {}
                      : { storeDir: message.projectDetails.sideChat.storeDir }),
                  },
                }),
          },
        }),
  }
}

/** Reconstructs the persisted message only after Slate's turn policy has finished. */
export function toInteropUserMessage(message: SlateUserMessage): UserMessageInterop {
  return new UserMessage({
    text: message.text,
    messageId: message.messageId,
    ...(message.selectedContext === undefined ? {} : { selectedContext: message.selectedContext as never }),
    mode: message.unknownModeCode === undefined
      ? toInteropAgentMode(message.mode)
      : message.unknownModeCode as AgentMode,
    ...(message.isSimulatedMsg === undefined ? {} : { isSimulatedMsg: message.isSimulatedMsg }),
    ...(message.bestOfNGroupId === undefined ? {} : { bestOfNGroupId: message.bestOfNGroupId }),
    ...(message.tryUseBestOfNPromotion === undefined
      ? {}
      : { tryUseBestOfNPromotion: message.tryUseBestOfNPromotion }),
    ...(message.richText === undefined ? {} : { richText: message.richText }),
    ...(message.simulatedMsgReason === undefined
      ? {}
      : { simulatedMsgReason: toInteropSimulatedMessageReason(message.simulatedMsgReason) }),
    conversationStateBlobId: new Uint8Array(message.conversationStateBlobId),
    ...(message.subagentSystemReminder === undefined
      ? {}
      : { subagentSystemReminder: message.subagentSystemReminder }),
    ...(message.triggeringUserInfo === undefined ? {} : { triggeringUserInfo: message.triggeringUserInfo as never }),
    ...(message.executePlanInfo === undefined ? {} : { executePlanInfo: message.executePlanInfo as never }),
    ...(message.simulatedMessageMetadata === undefined
      ? {}
      : { simulatedMessageMetadata: message.simulatedMessageMetadata as never }),
    ...(message.promptReferenceId === undefined ? {} : { promptReferenceId: message.promptReferenceId }),
    ...(message.threadId === undefined ? {} : { threadId: message.threadId }),
    ...(message.textBlobId === undefined ? {} : { textBlobId: new Uint8Array(message.textBlobId) }),
    ...(message.richTextBlobId === undefined
      ? {}
      : { richTextBlobId: new Uint8Array(message.richTextBlobId) }),
    hookAdditionalContexts: toInteropHookContextMessages(message.hookContexts),
    ...(message.customModeIntent === undefined ? {} : { customModeIntent: message.customModeIntent as never }),
    ...(message.projectDetails === undefined
      ? {}
      : {
          projectDetails: new ProjectDetails({
            ...(message.projectDetails.name === undefined ? {} : { name: message.projectDetails.name }),
            ...(message.projectDetails.subagent === undefined
              ? {}
              : { subagent: message.projectDetails.subagent as never }),
            ...(message.projectDetails.sideChat === undefined
              ? {}
              : { sideChat: message.projectDetails.sideChat as never }),
          }),
        }),
  })
}

export function createEmptyRequestContextInterop(): RequestContextInterop {
  return new RequestContext()
}
