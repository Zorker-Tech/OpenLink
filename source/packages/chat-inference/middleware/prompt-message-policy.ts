import type { PromptMessage } from "../base.ts"

/** Whether the assistant message has no content parts or text. */
export function isEmptyAssistantMessage(message: PromptMessage): boolean {
  return message.role === "assistant" && message.content.length === 0
}
