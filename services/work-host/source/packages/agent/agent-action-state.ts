import { PrivacyMode, type PrivacyMode as PrivacyModeValue } from "../redaction/privacy-mode.ts"
import {
  isSlateResumeActionPayload,
  isSlateUserMessageActionPayload,
} from "./actions/user-message-action-contracts.ts"
import type {
  SlateResumeActionPayload,
  SlateUserMessageActionPayload,
} from "./actions/user-message-action-contracts.ts"
import type { AskQuestionCompletionAction } from "./actions/ask-question-completion-contracts.ts"
import type { SlateBackgroundTaskCompletionActionPayload } from "./actions/background-task-completion-contracts.ts"
import type {
  SlateBackgroundShellActionPayload,
  SlateBackgroundSubagentActionPayload,
} from "./actions/background-side-channel-contracts.ts"
import type { SlateCancelActionPayload } from "./actions/cancel-action-contracts.ts"
import type { SlateCancelSubagentActionPayload } from "./actions/cancel-subagent-action-contracts.ts"
import type { SlateContextInjectionActionPayload } from "./actions/context-injection-action-contracts.ts"
import type { SlateExecutePlanActionPayload } from "./actions/execute-plan-contracts.ts"
import type { SlateGoalContinuationActionPayload } from "./actions/goal-continuation-contracts.ts"
import type { SlateShellCommandActionPayload } from "./actions/shell-command-action-contracts.ts"
import type { SlateSubscriptionNotificationActionPayload } from "./actions/subscription-notification-contracts.ts"
import type { SlateSummarizeActionPayload } from "./actions/summarize-action-contracts.ts"

/** Product-owned routes accepted by the Slate Agent turn loop. */
export const SlateAgentActionKind = {
  USER_MESSAGE: "user-message",
  RESUME: "resume",
  CANCEL: "cancel",
  SUMMARIZE: "summarize",
  SHELL_COMMAND: "shell-command",
  DEPRECATED_PLAN_START: "deprecated-plan-start",
  EXECUTE_PLAN: "execute-plan",
  ASK_QUESTION_COMPLETION: "ask-question-completion",
  CANCEL_SUBAGENT: "cancel-subagent",
  BACKGROUND_TASK_COMPLETION: "background-task-completion",
  BACKGROUND_SHELL: "background-shell",
  BACKGROUND_SUBAGENT: "background-subagent",
  SUBSCRIPTION_NOTIFICATION: "subscription-notification",
  GOAL_CONTINUATION: "goal-continuation",
  CONTEXT_INJECTION: "context-injection",
  MISSING: "missing",
  UNSUPPORTED: "unsupported",
} as const

export type SlateAgentActionKind = (typeof SlateAgentActionKind)[keyof typeof SlateAgentActionKind]
export { isSlateResumeActionPayload, isSlateUserMessageActionPayload }
export type { SlateResumeActionPayload, SlateUserMessageActionPayload }

export type SlateUserMessageAction = SlateAgentAction<typeof SlateAgentActionKind.USER_MESSAGE>

export type SlateResumeAgentAction = SlateAgentAction<typeof SlateAgentActionKind.RESUME>

export interface SlateAgentActionContext {
  readonly privacyMode: PrivacyModeValue
  readonly actor?: {
    readonly authId?: string
    readonly userInfo?: Readonly<Record<string, unknown>>
  }
  readonly requestReferences?: Readonly<Record<string, unknown>>
  /** Kept so existing action telemetry keeps its stable label during the route migration. */
  readonly telemetryName?: string
}
export interface SlateAgentActionCompatibility {
  /** The historical route name is retained only to report a precise unsupported-action error. */
  readonly sourceKind?: string
}
/** An explicitly opaque value kept only while an unsupported or deprecated historical action is being migrated. */
export interface SlateLegacyAgentActionPayload {
  readonly schema: "slate.agent-action.legacy"
  readonly version: 1
  readonly sourceKind: string
  readonly value?: Readonly<Record<string, unknown>>
}

/** The route registry: active action kinds and payload schemas have one type-level source of truth. */
export interface SlateAgentActionPayloadByKind {
  readonly [SlateAgentActionKind.USER_MESSAGE]: SlateUserMessageActionPayload
  readonly [SlateAgentActionKind.RESUME]: SlateResumeActionPayload
  readonly [SlateAgentActionKind.CANCEL]: SlateCancelActionPayload
  readonly [SlateAgentActionKind.SUMMARIZE]: SlateSummarizeActionPayload
  readonly [SlateAgentActionKind.SHELL_COMMAND]: SlateShellCommandActionPayload
  readonly [SlateAgentActionKind.DEPRECATED_PLAN_START]: SlateLegacyAgentActionPayload
  readonly [SlateAgentActionKind.EXECUTE_PLAN]: SlateExecutePlanActionPayload
  readonly [SlateAgentActionKind.ASK_QUESTION_COMPLETION]: AskQuestionCompletionAction
  readonly [SlateAgentActionKind.CANCEL_SUBAGENT]: SlateCancelSubagentActionPayload
  readonly [SlateAgentActionKind.BACKGROUND_TASK_COMPLETION]: SlateBackgroundTaskCompletionActionPayload
  readonly [SlateAgentActionKind.BACKGROUND_SHELL]: SlateBackgroundShellActionPayload
  readonly [SlateAgentActionKind.BACKGROUND_SUBAGENT]: SlateBackgroundSubagentActionPayload
  readonly [SlateAgentActionKind.SUBSCRIPTION_NOTIFICATION]: SlateSubscriptionNotificationActionPayload
  readonly [SlateAgentActionKind.GOAL_CONTINUATION]: SlateGoalContinuationActionPayload
  readonly [SlateAgentActionKind.CONTEXT_INJECTION]: SlateContextInjectionActionPayload
  readonly [SlateAgentActionKind.MISSING]: undefined
  readonly [SlateAgentActionKind.UNSUPPORTED]: SlateLegacyAgentActionPayload
}

export interface SlateAgentActionEnvelope<
  Kind extends SlateAgentActionKind,
  Payload,
> {
  readonly kind: Kind
  readonly context: SlateAgentActionContext
  readonly compatibility?: SlateAgentActionCompatibility
  readonly payload: Payload
}

/** Slate's discriminated action union; kind and payload cannot be mixed across route families. */
export type SlateAgentAction<Kind extends SlateAgentActionKind = SlateAgentActionKind> =
  {
    [Route in Kind]: SlateAgentActionPayloadByKind[Route] extends undefined
      ? {
          readonly kind: Route
          readonly context: SlateAgentActionContext
          readonly compatibility?: SlateAgentActionCompatibility
          readonly payload?: undefined
        }
      : SlateAgentActionEnvelope<Route, SlateAgentActionPayloadByKind[Route]>
  }[Kind]

/** Creates the versioned wrapper for a value retained only for historical route recovery. */
export function createSlateLegacyAgentActionPayload(
  sourceKind: string,
  value?: Readonly<Record<string, unknown>>,
): SlateLegacyAgentActionPayload {
  return {
    schema: "slate.agent-action.legacy",
    version: 1,
    sourceKind,
    ...(value === undefined ? {} : { value }),
  }
}

/** Validates the isolated legacy wrapper without interpreting its route-specific value. */
export function isSlateLegacyAgentActionPayload(value: unknown): value is SlateLegacyAgentActionPayload {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const payload = value as Record<string, unknown>
  if (payload.schema !== "slate.agent-action.legacy" || payload.version !== 1 ||
      typeof payload.sourceKind !== "string") return false
  return payload.value === undefined || (payload.value !== null && typeof payload.value === "object" && !Array.isArray(payload.value))
}

/** Creates Slate's canonical no-new-request action for a retry/resume attempt. */
export function createSlateResumeAgentAction(
  privacyMode: PrivacyModeValue = PrivacyMode.UNSPECIFIED,
): SlateResumeAgentAction {
  return {
    kind: SlateAgentActionKind.RESUME,
    payload: { schema: "slate.agent-action.resume", version: 1 },
    context: { privacyMode },
  }
}
