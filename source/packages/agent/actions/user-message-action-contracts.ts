import type { SlateUserMessage } from "../user-message-state.ts"

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
