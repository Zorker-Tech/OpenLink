import {
  isSlateUserMessageActionPayload,
  type SlateUserMessageActionPayload,
} from "../agent-action-state.ts"
import type { SlateUserMessage } from "../user-message-state.ts"

/** The Slate notification batch that wakes a subscription's conversation. */
export interface SlateSubscriptionNotificationActionPayload {
  readonly schema: "slate.agent-action.subscription-notification"
  readonly version: 1
  readonly notifications: readonly SlateUserMessage[]
  readonly notifyUser: boolean
  readonly compatibility?: {
    readonly requestContext?: unknown
    readonly legacyPayload?: Readonly<Record<string, unknown>>
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

export function createSlateSubscriptionNotificationActionPayload(input: {
  readonly notifications: readonly SlateUserMessage[]
  readonly notifyUser: boolean
  readonly compatibility?: SlateSubscriptionNotificationActionPayload["compatibility"]
}): SlateSubscriptionNotificationActionPayload {
  return {
    schema: "slate.agent-action.subscription-notification",
    version: 1,
    notifications: [...input.notifications],
    notifyUser: input.notifyUser,
    ...(input.compatibility === undefined ? {} : { compatibility: input.compatibility }),
  }
}

export function isSlateSubscriptionNotificationActionPayload(
  value: unknown,
): value is SlateSubscriptionNotificationActionPayload {
  if (!isRecord(value) || value.schema !== "slate.agent-action.subscription-notification" ||
      value.version !== 1 || typeof value.notifyUser !== "boolean" || !Array.isArray(value.notifications)) {
    return false
  }
  if (!isSlateUserMessageActionPayload({
    schema: "slate.agent-action.user-message",
    version: 1,
    earlierMessages: value.notifications,
    notifyUser: false,
  })) return false
  if (value.compatibility === undefined) return true
  if (!isRecord(value.compatibility)) return false
  return value.compatibility.legacyPayload === undefined || isRecord(value.compatibility.legacyPayload)
}

/** Uses the final notification as the current turn and keeps earlier notifications in their original order. */
export function subscriptionNotificationAsUserMessageAction(
  action: SlateSubscriptionNotificationActionPayload,
): SlateUserMessageActionPayload {
  if (!isSlateSubscriptionNotificationActionPayload(action)) {
    throw new TypeError("Subscription notification action must use the Slate v1 contract")
  }
  const message = action.notifications.at(-1)
  if (message === undefined) throw new Error("Subscription notification action requires at least one notification")
  const compatibility = action.compatibility === undefined
    ? undefined
    : {
        ...(action.compatibility.requestContext === undefined
          ? {}
          : { requestContext: action.compatibility.requestContext }),
        ...(action.compatibility.legacyPayload === undefined
          ? {}
          : { legacyPayload: action.compatibility.legacyPayload }),
      }
  return {
    schema: "slate.agent-action.user-message",
    version: 1,
    message,
    earlierMessages: action.notifications.slice(0, -1),
    notifyUser: action.notifyUser,
    ...(compatibility === undefined ? {} : { compatibility }),
  }
}
