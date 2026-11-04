import {
  isInjectedReminderMessage,
  type MessageLike,
} from "./send-message-reminder-middleware.ts"
import { SLATE_SEND_MESSAGE_TOOL_NAME } from "./tools/send-message-tool.ts"

export const DEFAULT_OPENING_MESSAGE_TOOL_LIMIT = 1
export const OPENING_MESSAGE_REMINDER_TEXT = `<system_reminder>
The user has not received a reply this turn. Before making another tool call, send a short acknowledgment or progress update with SendMessage. Tool output and ordinary assistant text are private; only that text call appears in the chat. Continue the task after the update.
</system_reminder>`

export function buildOpeningMessageReminder(content: string): MessageLike {
  return {
    role: "user",
    content,
    providerOptions: { cursor: { slateOpeningMessageReminder: true } },
  }
}

export function isOpeningMessageReminder(message: MessageLike): boolean {
  return message.providerOptions?.cursor?.slateOpeningMessageReminder === true
    || message.providerOptions?.cursor?.slateStartOfTurnAckReminder === true
}

export function isPlainTextDeliveryArgs(args: unknown): boolean {
  return typeof args === "object"
    && args !== null
    && "type" in args
    && args.type === "text"
}

export function hasPlainTextDelivery(message: MessageLike): boolean {
  if (message.role !== "assistant" || typeof message.content === "string") return false
  return message.content.some((part) => {
    const candidate = part as typeof part & { readonly args?: unknown }
    return candidate.type === "tool-call"
      && candidate.toolName === SLATE_SEND_MESSAGE_TOOL_NAME
      && isPlainTextDeliveryArgs(candidate.args)
  })
}

export function hasPlainTextDeliveryThisTurn(messages: readonly MessageLike[]): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message == null || isInjectedReminderMessage(message)) continue
    if (message.role === "user" || message.role === "system") return false
    if (hasPlainTextDelivery(message)) return true
  }
  return false
}
