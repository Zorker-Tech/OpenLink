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

import {
  isSlateSubscriptionNotificationActionPayload,
  subscriptionNotificationAsUserMessageAction,
  type SlateSubscriptionNotificationActionPayload,
} from "./subscription-notification-contracts.ts"

interface UserMessageActionHandler {
  handle(...args: unknown[]): Promise<unknown> | unknown
  handleSingleStep(...args: unknown[]): Promise<unknown> | unknown
  handleModelStep(...args: unknown[]): Promise<unknown> | unknown
}

export class SubscriptionWakeupActionHandler {
  constructor(readonly userMessageActionHandler: UserMessageActionHandler) {}

  getUserMessageActionHandler(): UserMessageActionHandler {
    return this.userMessageActionHandler
  }

  async handle(
    ctx: unknown,
    action: SlateSubscriptionNotificationActionPayload,
    rootPromptExecutor: unknown,
    stateHandler: unknown,
    mcpTools: unknown,
    onStateUpdate: unknown,
  ): Promise<unknown> {
    return await this.forward(
      "handle",
      ctx,
      action,
      rootPromptExecutor,
      stateHandler,
      mcpTools,
      onStateUpdate,
    )
  }

  async handleSingleStep(
    ctx: unknown,
    action: SlateSubscriptionNotificationActionPayload,
    rootPromptExecutor: unknown,
    stateHandler: unknown,
    mcpTools: unknown,
    onStateUpdate: unknown,
  ): Promise<unknown> {
    return await this.forward(
      "handleSingleStep",
      ctx,
      action,
      rootPromptExecutor,
      stateHandler,
      mcpTools,
      onStateUpdate,
    )
  }

  async handleModelStep(
    ctx: unknown,
    action: SlateSubscriptionNotificationActionPayload,
    rootPromptExecutor: unknown,
    stateHandler: unknown,
    mcpTools: unknown,
    onStateUpdate: unknown,
  ): Promise<unknown> {
    return await this.forward(
      "handleModelStep",
      ctx,
      action,
      rootPromptExecutor,
      stateHandler,
      mcpTools,
      onStateUpdate,
    )
  }

  private async forward(
    method: "handle" | "handleSingleStep" | "handleModelStep",
    ctx: unknown,
    action: SlateSubscriptionNotificationActionPayload,
    rootPromptExecutor: unknown,
    stateHandler: unknown,
    mcpTools: unknown,
    onStateUpdate: unknown,
  ): Promise<unknown> {
    if (!isSlateSubscriptionNotificationActionPayload(action)) {
      throw new TypeError("Subscription notification action must use the Slate v1 contract")
    }
    const adapted = {
      userMessageAction: subscriptionNotificationAsUserMessageAction(action),
      notificationCount: action.notifications.length,
    }
    return await this.userMessageActionHandler[method](
      ctx,
      adapted.userMessageAction,
      rootPromptExecutor,
      stateHandler,
      mcpTools,
      onStateUpdate,
      {
        forcePrependedUserMessages: true,
        maxPrependedUserMessages: adapted.notificationCount,
        isSyntheticWakeup: true,
      },
    );
  }
}
