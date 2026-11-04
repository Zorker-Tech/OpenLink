import { createRedactedUserMessageAction } from "../redacted-protos/generated/agent/v1/agent_redacted.ts";

export interface AdaptedSubscriptionWakeup {
  readonly userMessageAction: unknown;
  readonly notificationCount: number;
}

/** Translates the counterpart's subscription action into the user-message action consumed by the agent. */
export function adaptSubscriptionWakeup(value: unknown): AdaptedSubscriptionWakeup {
  const action = value as {
    readonly _privacyMode: unknown;
    readonly notifications: readonly unknown[];
    readonly requestContext?: unknown;
    readonly sendToInteractionListener?: unknown;
  };
  const notifications = action.notifications;
  const currentMessage = notifications.at(-1);
  if (currentMessage === undefined) {
    throw new Error("Subscription notification action requires at least one notification");
  }

  return {
    userMessageAction: createRedactedUserMessageAction(action._privacyMode, {
      userMessage: currentMessage,
      prependUserMessages: notifications.slice(0, -1),
      requestContext: action.requestContext,
      sendToInteractionListener: action.sendToInteractionListener,
    }),
    notificationCount: notifications.length,
  };
}
