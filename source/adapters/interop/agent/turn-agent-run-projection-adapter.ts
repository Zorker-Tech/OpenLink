/** Convert the host's turn selection into the redacted Agent input required by the interop boundary. */

import { toRedactedConversationAction } from "../redacted-protos/generated/agent/v1/agent_redacted.ts"
import { ConversationAction, ConversationStateStructure } from "../proto/generated/agent/v1/agent_pb.ts"
import type { PrivacyMode } from "../../../packages/redaction/privacy-mode.ts"
import { DataClassification } from "../../../packages/redaction/classification.ts"
import { createRedactedString } from "../../../packages/redaction/create.ts"
import { isRedactedString } from "../../../packages/redaction/redacted-values.ts"
import type { RedactedString } from "../../../packages/redaction/redacted-values.ts"
import {
  isSlateResumeActionPayload,
  isSlateUserMessageActionPayload,
  SlateAgentActionKind,
  type SlateAgentAction,
  type SlateAgentActionKind as SlateAgentActionKindValue,
  type SlateResumeActionPayload,
  type SlateUserMessageActionPayload,
} from "../../../packages/agent/agent-action-state.ts"
import { isSlateConversationCheckpointV2, type SlateConversationCheckpointV2 } from "../../../packages/agent/conversation-checkpoint-state.ts"
import { decodeIncomingSlateUserMessage } from "./user-message-action-input-adapter.ts"
import { redactSlateUserMessage } from "./user-message-action-protocol-adapter.ts"
import { decodeExecutePlanAction } from "./execute-plan-action-adapter.ts"
import { slateAskQuestionCompletionFromRedacted } from "./ask-question-result-adapter.ts"
import { slateBackgroundTaskCompletionActionFromRedacted } from "./background-task-completion-adapter.ts"
import { slateShellCommandActionPayloadFromRedacted } from "./shell-command-action-adapter.ts"
import { isSlateExecutePlanActionPayload } from "../../../packages/agent/actions/execute-plan-contracts.ts"
import { isSlateBackgroundTaskCompletionActionPayload } from "../../../packages/agent/actions/background-task-completion-contracts.ts"
import {
  createSlateShellCommandActionPayload,
  isSlateShellCommandActionPayload,
  redactSlateShellCommandActionPayload,
} from "../../../packages/agent/actions/shell-command-action-contracts.ts"
import {
  createSlateGoalContinuationActionPayload,
  isSlateGoalContinuationActionPayload,
} from "../../../packages/agent/actions/goal-continuation-contracts.ts"
import {
  createSlateSubscriptionNotificationActionPayload,
  isSlateSubscriptionNotificationActionPayload,
} from "../../../packages/agent/actions/subscription-notification-contracts.ts"
import {
  createSlateCancelActionPayload,
  isSlateCancelActionPayload,
  redactSlateCancelActionPayload,
} from "../../../packages/agent/actions/cancel-action-contracts.ts"
import {
  createSlateSummarizeActionPayload,
  isSlateSummarizeActionPayload,
} from "../../../packages/agent/actions/summarize-action-contracts.ts"
import { interopAgentConversationCheckpointFromSlate } from "./agent-conversation-protobuf-adapter.ts"
import { toRedactedConversationStateStructureInterop } from "./agent-state-message-serdes-adapter.ts"

export {
  restoreAgentConversationState,
  restoreSlateConversationState,
} from "./redacted-conversation-state-adapter.ts"

export type InteropConversationAction = ConversationAction
export type InteropConversationState = ConversationStateStructure

export interface RedactedAgentAction {
  readonly _privacyMode: PrivacyMode
  readonly triggeringAuthId?: string | undefined
  readonly triggeringUserInfo?: Readonly<Record<string, unknown>> | undefined
  readonly requestContextParts?: Readonly<Record<string, unknown>> | undefined
  readonly action: { readonly case: string | undefined; readonly value?: Readonly<Record<string, unknown>> | undefined }
}

export interface RedactedAgentConversationState {
  readonly _privacyMode: PrivacyMode
  readonly rootPromptMessagesJson: readonly Uint8Array[]
  readonly turns: readonly Uint8Array[]
  readonly todos: readonly Uint8Array[]
  readonly pendingToolCalls: readonly RedactedString[]
  readonly previousWorkspaceUris: readonly RedactedString[]
  readonly summaryArchives: readonly Uint8Array[]
  readonly turnTimings: readonly Readonly<Record<string, unknown>>[]
  readonly readPaths: readonly RedactedString[]
  readonly [field: string]: unknown
}

export interface InteropTurnRunProjection {
  readonly state: RedactedAgentConversationState
  readonly action: SlateAgentAction
  readonly isResume: boolean
}

function slateUserMessageActionPayloadFromRedacted(
  value: Readonly<Record<string, unknown>> | undefined,
): SlateUserMessageActionPayload {
  const message = value?.userMessage === undefined ? undefined : decodeIncomingSlateUserMessage(value.userMessage)
  const earlierMessages = Array.isArray(value?.prependUserMessages)
    ? value.prependUserMessages.map(decodeIncomingSlateUserMessage)
    : []
  const requestContext = value?.requestContext
  const interruptedToolResolutions = value?.interruptedPendingToolCallResolutions
  const conversationHistory = value?.conversationHistory
  const compatibility = value === undefined
    ? undefined
    : {
        ...(requestContext === undefined ? {} : { requestContext }),
        ...(interruptedToolResolutions === undefined ? {} : { interruptedToolResolutions }),
        ...(conversationHistory === undefined ? {} : { conversationHistory }),
        legacyPayload: value,
      }
  return {
    schema: "slate.agent-action.user-message",
    version: 1,
    ...(message === undefined ? {} : { message }),
    earlierMessages,
    notifyUser: value?.sendToInteractionListener === true,
    ...(compatibility === undefined ? {} : { compatibility }),
  }
}

function slateResumeActionPayloadFromRedacted(
  value: Readonly<Record<string, unknown>> | undefined,
): SlateResumeActionPayload {
  if (value === undefined) return { schema: "slate.agent-action.resume", version: 1 }
  const requestContext = value.requestContext
  return {
    schema: "slate.agent-action.resume",
    version: 1,
    compatibility: {
      ...(requestContext === undefined ? {} : { requestContext }),
      legacyPayload: value,
    },
  }
}

function slateCancelActionPayloadFromRedacted(
  value: Readonly<Record<string, unknown>> | undefined,
  privacyMode: PrivacyMode,
) {
  const reasonValue = value?.reason
  const reason = isRedactedString(reasonValue)
    ? reasonValue
    : createRedactedString(
        typeof reasonValue === "string" ? reasonValue : "",
        DataClassification.CODE,
        "reason",
        privacyMode,
      )
  const interruptedToolResolutions = value?.interruptedPendingToolCallResolutions
  const compatibility = value === undefined
    ? undefined
    : {
        ...(interruptedToolResolutions === undefined ? {} : { interruptedToolResolutions }),
        legacyPayload: value,
      }
  return createSlateCancelActionPayload(reason, compatibility)
}

function slateSubscriptionNotificationPayloadFromRedacted(
  value: Readonly<Record<string, unknown>> | undefined,
): ReturnType<typeof createSlateSubscriptionNotificationActionPayload> {
  const notifications = Array.isArray(value?.notifications)
    ? value.notifications.map(decodeIncomingSlateUserMessage)
    : []
  const compatibility = value === undefined
    ? undefined
    : {
        ...(value.requestContext === undefined ? {} : { requestContext: value.requestContext }),
        legacyPayload: value,
      }
  return createSlateSubscriptionNotificationActionPayload({
    notifications,
    notifyUser: value?.sendToInteractionListener === true,
    ...(compatibility === undefined ? {} : { compatibility }),
  })
}

function isSlateAgentAction(value: InteropConversationAction | SlateAgentAction): value is SlateAgentAction {
  if (value === null || typeof value !== "object" || !("kind" in value) || !("context" in value)) return false
  return typeof value.kind === "string" && typeof value.context === "object" && value.context !== null
}

function redactSlateAgentAction(action: SlateAgentAction, privacyMode: PrivacyMode): SlateAgentAction {
  const context = { ...action.context, privacyMode }
  if (action.kind === SlateAgentActionKind.EXECUTE_PLAN && isSlateExecutePlanActionPayload(action.payload)) {
    return { ...action, context, payload: { ...action.payload, privacyMode } }
  }
  if (action.kind === SlateAgentActionKind.SUMMARIZE) {
    return {
      ...action,
      context,
      payload: isSlateSummarizeActionPayload(action.payload)
        ? action.payload
        : createSlateSummarizeActionPayload(),
    }
  }
  if (action.kind === SlateAgentActionKind.CANCEL) {
    return {
      ...action,
      context,
      payload: isSlateCancelActionPayload(action.payload)
        ? redactSlateCancelActionPayload(action.payload, privacyMode)
        : slateCancelActionPayloadFromRedacted(undefined, privacyMode),
    }
  }
  if (action.kind === SlateAgentActionKind.BACKGROUND_TASK_COMPLETION) {
    if (!isSlateBackgroundTaskCompletionActionPayload(action.payload)) {
      throw new TypeError("Background task completion action must use the Slate v1 contract")
    }
    return { ...action, context, payload: action.payload }
  }
  if (action.kind === SlateAgentActionKind.SHELL_COMMAND) {
    return {
      ...action,
      context,
      payload: isSlateShellCommandActionPayload(action.payload)
        ? redactSlateShellCommandActionPayload(action.payload, privacyMode)
        : createSlateShellCommandActionPayload({ privacyMode }),
    }
  }
  if (action.kind === SlateAgentActionKind.GOAL_CONTINUATION) {
    return {
      ...action,
      context,
      payload: isSlateGoalContinuationActionPayload(action.payload)
        ? action.payload
        : createSlateGoalContinuationActionPayload(),
    }
  }
  if (action.kind === SlateAgentActionKind.SUBSCRIPTION_NOTIFICATION) {
    if (!isSlateSubscriptionNotificationActionPayload(action.payload)) {
      throw new TypeError("Subscription notification action must use the Slate v1 contract")
    }
    return {
      ...action,
      context,
      payload: {
        ...action.payload,
        notifications: action.payload.notifications.map(message => redactSlateUserMessage(message, privacyMode)),
      },
    }
  }
  if (action.kind === SlateAgentActionKind.RESUME) {
    return {
      ...action,
      context,
      payload: isSlateResumeActionPayload(action.payload)
        ? action.payload
        : { schema: "slate.agent-action.resume", version: 1 },
    }
  }
  if (action.kind !== SlateAgentActionKind.USER_MESSAGE || !isSlateUserMessageActionPayload(action.payload)) {
    return { ...action, context }
  }
  return {
    ...action,
    context,
    payload: {
      ...action.payload,
      ...(action.payload.message === undefined ? {} : { message: redactSlateUserMessage(action.payload.message, privacyMode) }),
      earlierMessages: action.payload.earlierMessages.map(message => redactSlateUserMessage(message, privacyMode)),
    },
  }
}

const SLATE_ACTION_KIND_BY_INTEROP_CASE: Readonly<Record<string, SlateAgentActionKindValue>> = {
  userMessageAction: SlateAgentActionKind.USER_MESSAGE,
  resumeAction: SlateAgentActionKind.RESUME,
  cancelAction: SlateAgentActionKind.CANCEL,
  summarizeAction: SlateAgentActionKind.SUMMARIZE,
  shellCommandAction: SlateAgentActionKind.SHELL_COMMAND,
  startPlanAction: SlateAgentActionKind.DEPRECATED_PLAN_START,
  executePlanAction: SlateAgentActionKind.EXECUTE_PLAN,
  asyncAskQuestionCompletionAction: SlateAgentActionKind.ASK_QUESTION_COMPLETION,
  cancelSubagentAction: SlateAgentActionKind.CANCEL_SUBAGENT,
  backgroundTaskCompletionAction: SlateAgentActionKind.BACKGROUND_TASK_COMPLETION,
  backgroundShellAction: SlateAgentActionKind.BACKGROUND_SHELL,
  backgroundSubagentAction: SlateAgentActionKind.BACKGROUND_SUBAGENT,
  subscriptionNotificationAction: SlateAgentActionKind.SUBSCRIPTION_NOTIFICATION,
  goalContinuationAction: SlateAgentActionKind.GOAL_CONTINUATION,
  injectContextAction: SlateAgentActionKind.CONTEXT_INJECTION,
}

function slateAgentActionFromCaseValue(input: {
  readonly actionCase: string | undefined
  readonly value?: Readonly<Record<string, unknown>> | undefined
  readonly privacyMode: PrivacyMode
  readonly triggeringAuthId?: string | undefined
  readonly triggeringUserInfo?: Readonly<Record<string, unknown>> | undefined
  readonly requestContextParts?: Readonly<Record<string, unknown>> | undefined
}): SlateAgentAction {
  const kind = input.actionCase === undefined
    ? SlateAgentActionKind.MISSING
    : SLATE_ACTION_KIND_BY_INTEROP_CASE[input.actionCase] ?? SlateAgentActionKind.UNSUPPORTED
  return {
    kind,
    ...(input.value === undefined ? {} : { payload: input.value }),
    context: {
      privacyMode: input.privacyMode,
      ...(input.triggeringAuthId === undefined ? {} : { actor: {
        authId: input.triggeringAuthId,
        ...(input.triggeringUserInfo === undefined ? {} : { userInfo: input.triggeringUserInfo }),
      } }),
      ...(input.triggeringAuthId === undefined && input.triggeringUserInfo !== undefined
        ? { actor: { userInfo: input.triggeringUserInfo } }
        : {}),
      ...(input.requestContextParts === undefined ? {} : { requestReferences: input.requestContextParts }),
      ...(input.actionCase === undefined ? {} : { telemetryName: input.actionCase }),
    },
    ...(kind === SlateAgentActionKind.UNSUPPORTED && input.actionCase !== undefined
      ? { compatibility: { sourceKind: input.actionCase } }
      : {}),
  }
}

/** Converts the historical case/value action into Slate's internal route envelope during migration. */
export function slateAgentActionFromRedactedInterop(action: RedactedAgentAction): SlateAgentAction {
  const slateAction = slateAgentActionFromCaseValue({
    actionCase: action.action.case,
    ...(action.action.value === undefined ? {} : { value: action.action.value }),
    privacyMode: action._privacyMode,
    ...("triggeringAuthId" in action ? { triggeringAuthId: action.triggeringAuthId } : {}),
    ...("triggeringUserInfo" in action ? { triggeringUserInfo: action.triggeringUserInfo } : {}),
    ...("requestContextParts" in action ? { requestContextParts: action.requestContextParts } : {}),
  })
  if (slateAction.kind === SlateAgentActionKind.RESUME) {
    return { ...slateAction, payload: slateResumeActionPayloadFromRedacted(action.action.value) }
  }
  if (slateAction.kind === SlateAgentActionKind.CANCEL) {
    return {
      ...slateAction,
      payload: slateCancelActionPayloadFromRedacted(action.action.value, action._privacyMode),
    }
  }
  if (slateAction.kind === SlateAgentActionKind.BACKGROUND_TASK_COMPLETION) {
    return {
      ...slateAction,
      payload: slateBackgroundTaskCompletionActionFromRedacted(
        (action.action.value ?? { completions: [] }) as never,
      ),
    }
  }
  if (slateAction.kind === SlateAgentActionKind.SHELL_COMMAND) {
    return {
      ...slateAction,
      payload: slateShellCommandActionPayloadFromRedacted(action.action.value, action._privacyMode),
    }
  }
  if (slateAction.kind === SlateAgentActionKind.GOAL_CONTINUATION) {
    return { ...slateAction, payload: createSlateGoalContinuationActionPayload() }
  }
  if (slateAction.kind === SlateAgentActionKind.SUBSCRIPTION_NOTIFICATION) {
    return {
      ...slateAction,
      payload: slateSubscriptionNotificationPayloadFromRedacted(action.action.value),
    }
  }
  if (slateAction.kind === SlateAgentActionKind.SUMMARIZE) {
    return { ...slateAction, payload: createSlateSummarizeActionPayload() }
  }
  if (slateAction.kind === SlateAgentActionKind.EXECUTE_PLAN) {
    return { ...slateAction, payload: decodeExecutePlanAction(action.action.value) }
  }
  if (slateAction.kind === SlateAgentActionKind.ASK_QUESTION_COMPLETION) {
    return {
      ...slateAction,
      payload: slateAskQuestionCompletionFromRedacted(action.action.value, action._privacyMode),
    }
  }
  if (slateAction.kind === SlateAgentActionKind.USER_MESSAGE) {
    return { ...slateAction, payload: slateUserMessageActionPayloadFromRedacted(action.action.value) }
  }
  return slateAction
}

/** Converts a counterpart action at a direct Agent entry such as the task subagent runner. */
export function slateAgentActionFromInterop(
  action: InteropConversationAction,
  privacyMode: PrivacyMode,
): SlateAgentAction {
  return slateAgentActionFromRedactedInterop(toRedactedConversationAction(action, privacyMode))
}

/** Adapts a historical queued oneof value into the same Slate route contract. */
export function slateAgentActionFromQueuedInterop(
  action: { readonly case: string | undefined; readonly value?: unknown },
  privacyMode: PrivacyMode,
): SlateAgentAction {
  if (action.case === "userMessageAction") {
    const wrapped = new ConversationAction({ action: { case: "userMessageAction", value: action.value as never } })
    return slateAgentActionFromRedactedInterop(toRedactedConversationAction(wrapped, privacyMode))
  }
  if (action.case === "resumeAction") {
    const wrapped = new ConversationAction({ action: { case: "resumeAction", value: action.value as never } })
    return slateAgentActionFromRedactedInterop(toRedactedConversationAction(wrapped, privacyMode))
  }
  if (action.case === "summarizeAction") {
    const wrapped = new ConversationAction({ action: { case: "summarizeAction", value: action.value as never } })
    return slateAgentActionFromRedactedInterop(toRedactedConversationAction(wrapped, privacyMode))
  }
  if (action.case === "cancelAction") {
    const wrapped = new ConversationAction({ action: { case: "cancelAction", value: action.value as never } })
    return slateAgentActionFromRedactedInterop(toRedactedConversationAction(wrapped, privacyMode))
  }
  if (action.case === "backgroundTaskCompletionAction") {
    const wrapped = new ConversationAction({ action: { case: "backgroundTaskCompletionAction", value: action.value as never } })
    return slateAgentActionFromRedactedInterop(toRedactedConversationAction(wrapped, privacyMode))
  }
  if (action.case === "shellCommandAction") {
    const wrapped = new ConversationAction({ action: { case: "shellCommandAction", value: action.value as never } })
    return slateAgentActionFromRedactedInterop(toRedactedConversationAction(wrapped, privacyMode))
  }
  if (action.case === "goalContinuationAction") {
    const wrapped = new ConversationAction({ action: { case: "goalContinuationAction", value: action.value as never } })
    return slateAgentActionFromRedactedInterop(toRedactedConversationAction(wrapped, privacyMode))
  }
  if (action.case === "subscriptionNotificationAction") {
    const wrapped = new ConversationAction({ action: { case: "subscriptionNotificationAction", value: action.value as never } })
    return slateAgentActionFromRedactedInterop(toRedactedConversationAction(wrapped, privacyMode))
  }
  if (action.case === "executePlanAction") {
    const wrapped = new ConversationAction({ action: { case: "executePlanAction", value: action.value as never } })
    return slateAgentActionFromRedactedInterop(toRedactedConversationAction(wrapped, privacyMode))
  }
  if (action.case === "asyncAskQuestionCompletionAction") {
    const wrapped = new ConversationAction({ action: { case: "asyncAskQuestionCompletionAction", value: action.value as never } })
    return slateAgentActionFromRedactedInterop(toRedactedConversationAction(wrapped, privacyMode))
  }
  const value = action.value
  return slateAgentActionFromCaseValue({
    actionCase: action.case,
    ...(value === undefined ? {} : { value: value as Readonly<Record<string, unknown>> }),
    privacyMode,
  })
}

export function cloneInteropConversationState(state: InteropConversationState): InteropConversationState {
  return ConversationStateStructure.fromBinary(state.toBinary())
}

/** Projects the store's Slate checkpoint at the runner boundary, while accepting old stores during migration. */
export function runnerConversationStateFromStoreCheckpoint(value: unknown): InteropConversationState {
  if (isSlateConversationCheckpointV2(value)) {
    return interopAgentConversationCheckpointFromSlate(value)
  }
  if (value !== null && typeof value === "object") {
    const toBinary = (value as { readonly toBinary?: unknown }).toBinary
    if (typeof toBinary === "function") return cloneInteropConversationState(value as ConversationStateStructure)
  }
  throw new TypeError("Agent conversation store returned an unsupported checkpoint")
}

export function projectInteropTurnRun(input: {
  readonly baseState: InteropConversationState
  readonly action: InteropConversationAction | SlateAgentAction
  readonly resumeFrom?: InteropConversationState
  readonly resumeAction: InteropConversationAction | SlateAgentAction
  readonly privacyMode: PrivacyMode
}): InteropTurnRunProjection {
  const isResume = input.resumeFrom !== undefined
  const selectedAction = isResume ? input.resumeAction : input.action
  const slateAction = isSlateAgentAction(selectedAction)
    ? redactSlateAgentAction(selectedAction, input.privacyMode)
    : slateAgentActionFromRedactedInterop(toRedactedConversationAction(selectedAction, input.privacyMode))
  return {
    state: toRedactedConversationStateStructureInterop(input.resumeFrom ?? input.baseState, input.privacyMode),
    action: slateAction,
    isResume,
  }
}
