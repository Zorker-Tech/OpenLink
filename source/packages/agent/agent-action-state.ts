import { PrivacyMode, type PrivacyMode as PrivacyModeValue } from "../redaction/privacy-mode.ts"
import type { SlateUserMessage } from "./user-message-state.ts"

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

/** The versioned payload for a user turn created inside Slate. */
export interface SlateUserMessageActionPayload {
  readonly schema: "slate.agent-action.user-message"
  readonly version: 1
  readonly message?: SlateUserMessage
  readonly earlierMessages: readonly SlateUserMessage[]
  readonly notifyUser: boolean
  /** Fields still being migrated from old queued actions. New Slate actions leave this absent. */
  readonly compatibility?: {
    readonly requestContext?: unknown
    readonly interruptedToolResolutions?: unknown
    readonly conversationHistory?: unknown
    readonly legacyPayload?: Readonly<Record<string, unknown>>
  }
}

export type SlateUserMessageAction = SlateAgentAction<
  typeof SlateAgentActionKind.USER_MESSAGE,
  SlateUserMessageActionPayload
> & { readonly payload: SlateUserMessageActionPayload }

/** The retry action emitted when a saved turn resumes without a new user request. */
export interface SlateResumeActionPayload {
  readonly schema: "slate.agent-action.resume"
  readonly version: 1
  /** Only historical resume inputs carry request context through this migration sidecar. */
  readonly compatibility?: {
    readonly requestContext?: unknown
    readonly legacyPayload?: Readonly<Record<string, unknown>>
  }
}

export type SlateResumeAgentAction = SlateAgentAction<
  typeof SlateAgentActionKind.RESUME,
  SlateResumeActionPayload
> & { readonly payload: SlateResumeActionPayload }

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

/**
 * Slate's action envelope. The route, context and user-message payload are Slate-owned. Remaining action families
 * keep their payloads behind an explicitly historical migration bridge until their own contracts and redaction rules land.
 */
export interface SlateAgentAction<
  Kind extends SlateAgentActionKind = SlateAgentActionKind,
  Payload = unknown,
> {
  readonly kind: Kind
  readonly payload?: Payload
  readonly context: SlateAgentActionContext
  readonly compatibility?: SlateAgentActionCompatibility
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

/** Runtime guard for the typed first-party user-message action payload. */
export function isSlateUserMessageActionPayload(value: unknown): value is SlateUserMessageActionPayload {
  if (value === null || typeof value !== "object") return false
  const payload = value as Record<string, unknown>
  if (payload.schema !== "slate.agent-action.user-message" || payload.version !== 1 ||
      !Array.isArray(payload.earlierMessages) || typeof payload.notifyUser !== "boolean") return false
  const validMessage = (candidate: unknown): boolean => {
    if (candidate === undefined) return true
    if (candidate === null || typeof candidate !== "object") return false
    const message = candidate as Record<string, unknown>
    return typeof message.text === "string" ||
      (typeof message.text === "object" && message.text !== null && "unwrap" in message.text)
  }
  if (!validMessage(payload.message) || !payload.earlierMessages.every(validMessage)) return false
  if (payload.compatibility === undefined) return true
  if (payload.compatibility === null || typeof payload.compatibility !== "object") return false
  const compatibility = payload.compatibility as Record<string, unknown>
  return (compatibility.requestContext === undefined || typeof compatibility.requestContext === "object") &&
    (compatibility.interruptedToolResolutions === undefined || typeof compatibility.interruptedToolResolutions === "object") &&
    (compatibility.conversationHistory === undefined || typeof compatibility.conversationHistory === "object") &&
    (compatibility.legacyPayload === undefined || typeof compatibility.legacyPayload === "object")
}

/** Runtime guard for the versioned resume payload. */
export function isSlateResumeActionPayload(value: unknown): value is SlateResumeActionPayload {
  if (value === null || typeof value !== "object") return false
  const payload = value as Record<string, unknown>
  if (payload.schema !== "slate.agent-action.resume" || payload.version !== 1) return false
  if (payload.compatibility === undefined) return true
  if (payload.compatibility === null || typeof payload.compatibility !== "object") return false
  const compatibility = payload.compatibility as Record<string, unknown>
  return (compatibility.requestContext === undefined || typeof compatibility.requestContext === "object") &&
    (compatibility.legacyPayload === undefined || typeof compatibility.legacyPayload === "object")
}
