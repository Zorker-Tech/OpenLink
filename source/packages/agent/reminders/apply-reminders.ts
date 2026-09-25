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

interface MutableToolResultContentPart {
  readonly type?: string
  readonly experimental_content?: Array<{ type: string; text: string }>
}

interface MutableReminderMessage {
  readonly role: string
  readonly content?: MutableToolResultContentPart[] | unknown
}

interface Reminder<TTodo> {
  shouldTrigger(context: ReminderContext<TTodo>): boolean
  generate(context: ReminderContext<TTodo>): string | undefined
}

export async function applyRemindersToToolResults<TTodo = unknown>(
  responseMessages: MutableReminderMessage[],
  reminders: readonly Reminder<TTodo>[],
  currentTodos: readonly TTodo[],
  conversationMessages: readonly MutableReminderMessage[],
): Promise<void> {
  if (reminders.length === 0) return
  const context = buildReminderContext(conversationMessages, currentTodos, responseMessages)
  const triggeredReminders: string[] = []
  for (const reminder of reminders) {
    if (reminder.shouldTrigger(context)) {
      const text = reminder.generate(context)
      if (text && text.length > 0) triggeredReminders.push(text)
    }
  }
  if (triggeredReminders.length === 0) return
  const combinedReminderText = triggeredReminders.join("\n\n")
  const toolMessages = responseMessages.filter(message => message.role === "tool" && Array.isArray(message.content))
  if (toolMessages.length === 0) return
  const lastToolMessage = toolMessages[toolMessages.length - 1]
  if (lastToolMessage && Array.isArray(lastToolMessage.content)) {
    const lastToolResult = lastToolMessage.content[lastToolMessage.content.length - 1]
    if (lastToolResult && lastToolResult.type === "tool-result") {
      if (Array.isArray(lastToolResult.experimental_content)) {
        lastToolResult.experimental_content.push({ type: "text", text: combinedReminderText })
      }
    }
  }
}
