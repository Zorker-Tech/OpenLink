/**
 * Attaching reminders to the result of the tool call that triggered them.
 *
 * A reminder is about what just happened — a todo list that went stale, a habit worth nudging — so it
 * belongs with the tool result rather than in a message of its own: the model reads it in the same breath
 * as the result, and nothing about the conversation's shape changes. Several reminders that trigger at
 * once are combined into one block, and the block goes on the *last* tool result, which is the one the
 * model is about to read.
 *
 * Nothing is attached when nothing triggered, and a reminder that produces no text is not a reminder.
 */

import { buildReminderContext, type ReminderContext } from "./context-builder.ts"

interface ToolResultContentPart {
  readonly type?: string
  readonly experimental_content?: Array<{ type: string; text: string }>
}

interface ReminderMessage {
  readonly role: string
  readonly content?: unknown
}

interface Reminder<TTodo> {
  shouldTrigger(context: ReminderContext<TTodo>): boolean
  generate(context: ReminderContext<TTodo>): string | undefined
}

export async function applyRemindersToToolResults<TTodo = unknown>(
  responseMessages: ReminderMessage[],
  reminders: readonly Reminder<TTodo>[],
  currentTodos: readonly TTodo[],
  conversationMessages: readonly ReminderMessage[],
): Promise<void> {
  if (reminders.length === 0) return
  const context = buildReminderContext(conversationMessages, currentTodos, responseMessages)

  const messagesToAttach: string[] = []
  for (const reminder of reminders) {
    if (!reminder.shouldTrigger(context)) continue
    const text = reminder.generate(context)
    if (text !== undefined && text.length > 0) messagesToAttach.push(text)
  }
  if (messagesToAttach.length === 0) return

  appendToLastToolResult(responseMessages, messagesToAttach.join("\n\n"))
}

function appendToLastToolResult(messages: readonly ReminderMessage[], text: string): void {
  let target: ReminderMessage | undefined
  for (const message of messages) {
    if (message.role === "tool" && Array.isArray(message.content)) target = message
  }
  if (target === undefined || !Array.isArray(target.content)) return

  const parts = target.content as ToolResultContentPart[]
  const finalPart = parts[parts.length - 1]
  if (finalPart?.type !== "tool-result" || !Array.isArray(finalPart.experimental_content)) return
  finalPart.experimental_content.push({ type: "text", text })
}
