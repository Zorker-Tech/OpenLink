import {
  AgentMode,
  ExecutePlanInfo,
  ProjectDetails,
  SimulatedMsgReason,
  UserMessage,
} from "../proto/generated/agent/v1/agent_pb.ts"
import { TodoStatus } from "../proto/generated/agent/v1/todo_tool_pb.ts"
import { RequestContext } from "../proto/generated/agent/v1/request_context_exec_pb.ts"
import {
  fromRedactedConversationPlan,
  fromRedactedToolCall,
  fromRedactedUserMessage,
  toRedactedConversationPlan,
  toRedactedInteractionUpdate,
  toRedactedToolCall,
  toRedactedUserMessage,
} from "../redacted-protos/generated/agent/v1/agent_redacted.ts"
import {
  fromRedactedTodoItem,
  toRedactedTodoItem,
} from "../redacted-protos/generated/agent/v1/todo_tool_redacted.ts"
import { toRedactedSelectedContext } from "../redacted-protos/generated/agent/v1/selected_context_redacted.ts"
import { fromRedactedMcpToolDefinition } from "../redacted-protos/generated/agent/v1/mcp_redacted.ts"
import { fromRedactedRequestContext } from "../redacted-protos/generated/agent/v1/request_context_exec_redacted.ts"
import { PrivacyCapability } from "../../../packages/redaction/classification.ts"
import {
  fromInteropHookContextMessages,
  toInteropHookContextMessages,
} from "./hook-context-adapter.ts"
import { fromInteropAgentMode, toInteropAgentMode } from "./mode-processing-adapter.ts"
import {
  customModeIntentFromInterop,
  customModeIntentToInterop,
  simulationDetailsFromInterop,
  simulationDetailsToInterop,
  triggeringActorFromInterop,
  triggeringActorToInterop,
} from "./user-message-metadata-adapter.ts"
import {
  cloneSlateUserMessage,
  SlateSimulatedMessageReason,
  type SlateSimulatedMessageReason as SlateSimulatedMessageReasonValue,
  type SlateUserMessage,
  type SlatePlanExecutionIntent,
} from "../../../packages/agent/user-message-state.ts"
import { SlateMode } from "../../../packages/agent/mode-processing.ts"
import { SlateRedactedInteractionUpdates } from "../../../packages/agent-core/slate-interaction-updates.ts"
import type { SlateRedactedUserMessageAppendedUpdate } from "../../../packages/agent-core/interaction-update-contracts.ts"
import { PrivacyMode as PrivacyModes } from "../../../packages/redaction/privacy-mode.ts"
import { RedactedString } from "../../../packages/redaction/redacted-values.ts"
import { fromInteropSelectedContextState, toInteropSelectedContextState } from "./selected-context-state-adapter.ts"
import type { SlateSelectedContextState } from "../../../packages/agent/context/selected-context-state.ts"

export const AgentModeInterop = AgentMode
export type AgentModeInterop = AgentMode
export const TodoStatusInterop = TodoStatus
export type RequestContextInterop = RequestContext
export type UserMessageInterop = UserMessage

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

/** Identifies the pending question call before its redacted runner projection is written to the transcript. */
export function isAskQuestionToolCallInterop(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const tool = (value as { readonly tool?: unknown }).tool
  return tool !== null && typeof tool === "object" && !Array.isArray(tool) &&
    (tool as { readonly case?: unknown }).case === "askQuestionToolCall"
}

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
  readonly selectedContext: SlateSelectedContextState
  readonly promptReferenceId?: string
}): UserMessageInterop {
  return new UserMessage({
    ...input.message,
    ...(input.promptReferenceId === undefined ? {} : { promptReferenceId: input.promptReferenceId }),
    selectedContext: toInteropSelectedContextState(input.selectedContext),
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

function planExecutionFromInterop(value: ExecutePlanInfo | undefined): SlatePlanExecutionIntent | undefined {
  return value === undefined ? undefined : { id: value.planId, title: value.planTitle }
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
  const triggeringActor = triggeringActorFromInterop(message.triggeringUserInfo)
  const planExecution = planExecutionFromInterop(message.executePlanInfo)
  const simulation = simulationDetailsFromInterop(message.simulatedMessageMetadata)
  const modeIntent = customModeIntentFromInterop(message.customModeIntent)
  const selectedContext = message.selectedContext === undefined
    ? undefined
    : fromInteropSelectedContextState(message.selectedContext)
  return {
    text: message.text as never,
    messageId: message.messageId,
    ...(selectedContext === undefined ? {} : { selectedContext }),
    mode,
    ...(message.isSimulatedMsg === undefined ? {} : { isSimulatedMsg: message.isSimulatedMsg }),
    ...(message.bestOfNGroupId === undefined ? {} : { bestOfNGroupId: message.bestOfNGroupId }),
    ...(message.tryUseBestOfNPromotion === undefined
      ? {}
      : { tryUseBestOfNPromotion: message.tryUseBestOfNPromotion }),
    ...(message.richText === undefined ? {} : { richText: message.richText as never }),
    ...(simulatedMsgReason === undefined ? {} : { simulatedMsgReason }),
    conversationStateBlobId: new Uint8Array(message.conversationStateBlobId),
    ...(message.subagentSystemReminder === undefined
      ? {}
      : { subagentSystemReminder: message.subagentSystemReminder }),
    ...(triggeringActor === undefined ? {} : { triggeringActor }),
    ...(planExecution === undefined ? {} : { planExecution }),
    ...(simulation === undefined ? {} : { simulation }),
    ...(message.promptReferenceId === undefined ? {} : { promptReferenceId: message.promptReferenceId }),
    ...(message.threadId === undefined ? {} : { threadId: message.threadId }),
    ...(message.textBlobId === undefined ? {} : { textBlobId: new Uint8Array(message.textBlobId) }),
    ...(message.richTextBlobId === undefined
      ? {}
      : { richTextBlobId: new Uint8Array(message.richTextBlobId) }),
    hookContexts: fromInteropHookContextMessages(message.hookAdditionalContexts),
    ...(modeIntent === undefined ? {} : { modeIntent }),
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
  const triggeringUserInfo = triggeringActorToInterop(message.triggeringActor)
  const simulatedMessageMetadata = simulationDetailsToInterop(message.simulation)
  const customModeIntent = customModeIntentToInterop(message.modeIntent)
  const selectedContext = message.selectedContext === undefined
    ? undefined
    : toInteropSelectedContextState(message.selectedContext)
  const interop = new UserMessage({
    text: message.text as never,
    messageId: message.messageId,
    ...(selectedContext === undefined ? {} : { selectedContext }),
    mode: toInteropAgentMode(message.mode),
    ...(message.isSimulatedMsg === undefined ? {} : { isSimulatedMsg: message.isSimulatedMsg }),
    ...(message.bestOfNGroupId === undefined ? {} : { bestOfNGroupId: message.bestOfNGroupId }),
    ...(message.tryUseBestOfNPromotion === undefined
      ? {}
      : { tryUseBestOfNPromotion: message.tryUseBestOfNPromotion }),
    ...(message.richText === undefined ? {} : { richText: message.richText as never }),
    ...(message.simulatedMsgReason === undefined
      ? {}
      : { simulatedMsgReason: toInteropSimulatedMessageReason(message.simulatedMsgReason) }),
    conversationStateBlobId: new Uint8Array(message.conversationStateBlobId),
    ...(message.subagentSystemReminder === undefined
      ? {}
      : { subagentSystemReminder: message.subagentSystemReminder as never }),
    ...(triggeringUserInfo === undefined ? {} : { triggeringUserInfo }),
    ...(message.planExecution === undefined
      ? {}
      : {
          executePlanInfo: new ExecutePlanInfo({
            planId: message.planExecution.id as never,
            planTitle: message.planExecution.title as never,
          }),
        }),
    ...(simulatedMessageMetadata === undefined ? {} : { simulatedMessageMetadata }),
    ...(message.promptReferenceId === undefined ? {} : { promptReferenceId: message.promptReferenceId }),
    ...(message.threadId === undefined ? {} : { threadId: message.threadId }),
    ...(message.textBlobId === undefined ? {} : { textBlobId: new Uint8Array(message.textBlobId) }),
    ...(message.richTextBlobId === undefined
      ? {}
      : { richTextBlobId: new Uint8Array(message.richTextBlobId) }),
    hookAdditionalContexts: toInteropHookContextMessages(message.hookContexts.map(context => ({
      event: context.event,
      text: context.text as never,
    }))),
    ...(customModeIntent === undefined ? {} : { customModeIntent }),
    ...(message.projectDetails === undefined
      ? {}
      : {
          projectDetails: new ProjectDetails({
            ...(message.projectDetails.name === undefined ? {} : { name: message.projectDetails.name as never }),
            ...(message.projectDetails.subagent === undefined
              ? {}
              : { subagent: message.projectDetails.subagent as never }),
            ...(message.projectDetails.sideChat === undefined
              ? {}
              : { sideChat: message.projectDetails.sideChat as never }),
          }),
        }),
  })
  return interop
}

/** Projects a Slate turn record into the plain message view required by legacy runtime readers. */
export function toPlainInteropUserMessage(message: SlateUserMessage): UserMessageInterop {
  const projected = toInteropUserMessage(message)
  const projectedText: unknown = (projected as unknown as { readonly text: unknown }).text
  const redacted = projectedText instanceof RedactedString
    ? projected.selectedContext === undefined
      ? projected
      : {
          ...projected,
          selectedContext: toRedactedSelectedContext(projected.selectedContext, PrivacyModes.UNSPECIFIED),
        } as unknown as UserMessageInterop
    : toRedactedUserMessage(projected, PrivacyModes.UNSPECIFIED)
  return fromRedactedUserMessage(
    redacted as never,
    PrivacyCapability.UNSAFE_ALWAYS_ALLOWED,
    undefined,
  )
}

/** Applies privacy policy while keeping the stored and returned turn record Slate-owned. */
export function redactSlateUserMessage(
  message: SlateUserMessage,
  privacyMode: import("../../../packages/redaction/privacy-mode.ts").PrivacyMode,
): SlateUserMessage {
  const redacted = fromInteropUserMessage(
    toRedactedUserMessage(toInteropUserMessage(message), privacyMode) as unknown as UserMessageInterop,
  )
  return cloneSlateUserMessage(redacted)
}

/** Builds the Slate-owned interaction update emitted when a user message joins the conversation. */
export function slateUserMessageAppendedUpdate(
  message: SlateUserMessage,
  privacyMode: PrivacyModes,
): SlateRedactedUserMessageAppendedUpdate {
  return SlateRedactedInteractionUpdates.userMessageAppended(
    redactSlateUserMessage(message, privacyMode),
    privacyMode,
  )
}

/** Restores the plain turn record when the in-process listener reads a redacted appended message. */
export function unredactSlateUserMessage(message: SlateUserMessage): SlateUserMessage {
  return fromInteropUserMessage(fromRedactedUserMessage(
    toInteropUserMessage(message) as never,
    PrivacyCapability.UNSAFE_ALWAYS_ALLOWED,
    undefined,
  ))
}

/** Builds the legacy interaction update carrier at the listener edge from Slate-owned message data. */
export function slateUserMessageUpdateCarrier(
  message: SlateUserMessage,
  privacyMode: import("../../../packages/redaction/privacy-mode.ts").PrivacyMode,
): Readonly<Record<string, unknown>> & { readonly _privacyMode: import("../../../packages/redaction/privacy-mode.ts").PrivacyMode } {
  const redacted = redactSlateUserMessage(message, privacyMode)
  return Object.assign({ _privacyMode: privacyMode }, toInteropUserMessage(redacted)) as unknown as Readonly<Record<string, unknown>> & {
    readonly _privacyMode: import("../../../packages/redaction/privacy-mode.ts").PrivacyMode
  }
}

export function createEmptyRequestContextInterop(): RequestContextInterop {
  return new RequestContext()
}
