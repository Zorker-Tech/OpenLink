/**
 * A subscription notification handled as the user message it stands in for.
 *
 * A subscription firing wakes the conversation, and what the agent should do with it is what it would do
 * with a user message — so the action is adapted into one rather than given its own path, which would
 * drift. The last notification is the message; the ones before it are prepended, because they are the
 * context the last one arrived in, and the adaptation is bounded by how many there were so a backlog
 * cannot grow the message without limit.
 *
 * The run is marked as a synthetic wakeup, since the user did not speak, and every step of the turn goes
 * through the same adaptation so the three entry points cannot disagree.
 */

import { createRedactedUserMessageAction } from "../../redacted-protos/generated/agent/v1/agent_redacted.ts"

interface SubscriptionNotificationAction {
  readonly _privacyMode: unknown
  readonly notifications: readonly unknown[]
  readonly requestContext?: unknown
  readonly sendToInteractionListener?: unknown
}

interface UserMessageActionHandler {
  handle(...args: unknown[]): Promise<unknown> | unknown
  handleSingleStep(...args: unknown[]): Promise<unknown> | unknown
  handleModelStep(...args: unknown[]): Promise<unknown> | unknown
}

export class SubscriptionNotificationActionHandler {
  constructor(readonly userMessageActionHandler: UserMessageActionHandler) {}

  getUserMessageActionHandler(): UserMessageActionHandler {
    return this.userMessageActionHandler
  }

  async handle(
    ctx: unknown,
    action: SubscriptionNotificationAction,
    rootPromptExecutor: unknown,
    stateHandler: unknown,
    mcpTools: unknown,
    onStateUpdate: unknown,
  ): Promise<unknown> {
    return await this.userMessageActionHandler.handle(
      ctx,
      adaptSubscriptionNotificationAction(action),
      rootPromptExecutor,
      stateHandler,
      mcpTools,
      onStateUpdate,
      delegateOptions(action),
    )
  }

  async handleSingleStep(
    ctx: unknown,
    action: SubscriptionNotificationAction,
    rootPromptExecutor: unknown,
    stateHandler: unknown,
    mcpTools: unknown,
    onStateUpdate: unknown,
  ): Promise<unknown> {
    return await this.userMessageActionHandler.handleSingleStep(
      ctx,
      adaptSubscriptionNotificationAction(action),
      rootPromptExecutor,
      stateHandler,
      mcpTools,
      onStateUpdate,
      delegateOptions(action),
    )
  }

  async handleModelStep(
    ctx: unknown,
    action: SubscriptionNotificationAction,
    rootPromptExecutor: unknown,
    stateHandler: unknown,
    mcpTools: unknown,
    onStateUpdate: unknown,
  ): Promise<unknown> {
    return await this.userMessageActionHandler.handleModelStep(
      ctx,
      adaptSubscriptionNotificationAction(action),
      rootPromptExecutor,
      stateHandler,
      mcpTools,
      onStateUpdate,
      delegateOptions(action),
    )
  }
}

function delegateOptions(action: SubscriptionNotificationAction) {
  return {
    forcePrependedUserMessages: true,
    maxPrependedUserMessages: action.notifications.length,
    isSyntheticWakeup: true,
  }
}

function adaptSubscriptionNotificationAction(action: SubscriptionNotificationAction) {
  const userMessage = action.notifications.at(-1)
  if (userMessage === undefined) {
    throw new Error("Subscription notification action requires at least one notification")
  }
  return createRedactedUserMessageAction(action._privacyMode, {
    userMessage,
    prependUserMessages: action.notifications.slice(0, -1),
    requestContext: action.requestContext,
    sendToInteractionListener: action.sendToInteractionListener,
  })
}
