import {
  countToolCallsSinceLastSendMessage,
  type MessageLike,
  type PromptExecutor,
} from "./send-message-reminder-middleware.ts"
import {
  buildOpeningMessageReminder,
  DEFAULT_OPENING_MESSAGE_TOOL_LIMIT,
  hasPlainTextDeliveryThisTurn,
  isOpeningMessageReminder,
  OPENING_MESSAGE_REMINDER_TEXT,
} from "./opening-message-reminder-policy.ts"

export {
  buildOpeningMessageReminder,
  DEFAULT_OPENING_MESSAGE_TOOL_LIMIT,
  hasPlainTextDelivery,
  hasPlainTextDeliveryThisTurn,
  isOpeningMessageReminder,
  isPlainTextDeliveryArgs,
  OPENING_MESSAGE_REMINDER_TEXT,
} from "./opening-message-reminder-policy.ts"

export class OpeningMessageReminderMiddleware implements PromptExecutor {
  constructor(
    readonly innerExecutor: PromptExecutor,
    readonly threshold: number,
    readonly reminder: MessageLike,
  ) {}

  getMessages(): readonly MessageLike[] { return this.innerExecutor.getMessages() }
  getState(): readonly MessageLike[] { return this.innerExecutor.getState() }
  clearMessages(): void { this.innerExecutor.clearMessages() }
  appendMessages(messages: MessageLike | readonly MessageLike[]): void { this.innerExecutor.appendMessages(messages) }

  stream(...args: any[]): unknown {
    const messages = this.innerExecutor.getMessages()
    const lastMessage = messages.at(-1)
    const alreadyDelivered = hasPlainTextDeliveryThisTurn(messages)
    const tooManySilentTools = countToolCallsSinceLastSendMessage(messages) > this.threshold

    if (lastMessage != null && !isOpeningMessageReminder(lastMessage) && !alreadyDelivered && tooManySilentTools) {
      this.innerExecutor.appendMessages(this.reminder)
    }
    return this.innerExecutor.stream(...args)
  }
}

export function createOpeningMessageReminder(options: {
  readonly threshold?: number
  readonly message?: string
} = {}) {
  const threshold = options.threshold ?? DEFAULT_OPENING_MESSAGE_TOOL_LIMIT
  const reminder = buildOpeningMessageReminder(options.message ?? OPENING_MESSAGE_REMINDER_TEXT)
  return (executor: PromptExecutor) => new OpeningMessageReminderMiddleware(executor, threshold, reminder)
}
