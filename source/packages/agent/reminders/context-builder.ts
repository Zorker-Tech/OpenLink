/**
 * What a reminder is told about the conversation when it decides whether to trigger.
 *
 * A reminder is a rule about a pattern — three failures in a row, a todo list that has not moved — so
 * what it needs is the pattern's inputs rather than the conversation itself: how many tool calls have
 * happened, how many of each kind, and how many of each kind have failed in a row. The failures are
 * counted per tool rather than overall, because three failures of the same command is a signal and three
 * failures spread across three different commands is not.
 *
 * The most recent tool result is called out separately, since a reminder usually triggers on what just
 * happened rather than on the totals.
 */

interface ToolResultContentPart {
  readonly toolName?: string
  readonly isError?: boolean
  readonly result?: unknown
}

interface ReminderMessage {
  readonly role: string
  readonly content?: unknown
}

export interface ReminderContext<TTodo = unknown> {
  readonly toolCallCount: number
  readonly toolTypeCounters: Map<string, number>
  readonly consecutiveFailures: Map<string, number>
  readonly currentToolName: string | undefined
  readonly currentToolError: Error | undefined
  readonly currentToolSuccess: boolean | undefined
  readonly todos: readonly TTodo[]
  readonly conversationMessages: readonly ReminderMessage[]
  readonly responseMessages: readonly ReminderMessage[]
}

export function buildReminderContext<TTodo = unknown>(
  messages: readonly ReminderMessage[],
  todos: readonly TTodo[],
  responseMessages: readonly ReminderMessage[] = [],
): ReminderContext<TTodo> {
  let toolCallCount = 0
  const toolTypeCounters = new Map<string, number>()
  const consecutiveFailures = new Map<string, number>()
  let currentToolName: string | undefined
  let currentToolError: Error | undefined
  let currentToolSuccess: boolean | undefined
  for (const message of messages) {
    if (message.role === "tool" && Array.isArray(message.content)) {
      for (const toolResult of message.content as ToolResultContentPart[]) {
        const toolName = toolResult.toolName ?? "unknown"
        const success = !toolResult.isError
        toolCallCount++
        toolTypeCounters.set(toolName, (toolTypeCounters.get(toolName) ?? 0) + 1)
        // A success resets that tool's streak; a failure extends it.
        if (success) {
          consecutiveFailures.set(toolName, 0)
        } else {
          consecutiveFailures.set(toolName, (consecutiveFailures.get(toolName) ?? 0) + 1)
        }
        currentToolName = toolName
        currentToolSuccess = success
        currentToolError = toolResult.isError ? new Error(String(toolResult.result)) : undefined
      }
    }
  }
  return {
    toolCallCount,
    toolTypeCounters,
    consecutiveFailures,
    currentToolName,
    currentToolError,
    currentToolSuccess,
    todos,
    conversationMessages: messages,
    responseMessages,
  }
}
