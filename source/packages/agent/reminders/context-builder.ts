/** A compact view of recent tool activity for reminder rules. */

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

interface ToolAttempt {
  readonly tool: string
  readonly succeeded: boolean
  readonly error: Error | undefined
}

interface ToolHistory {
  readonly toolCallCount: number
  readonly toolTypeCounters: Map<string, number>
  readonly consecutiveFailures: Map<string, number>
  readonly currentToolName: string | undefined
  readonly currentToolError: Error | undefined
  readonly currentToolSuccess: boolean | undefined
}

function collectToolAttempts(messages: readonly ReminderMessage[]): ToolAttempt[] {
  const attempts: ToolAttempt[] = []
  for (const message of messages) {
    if (message.role !== "tool" || !Array.isArray(message.content)) continue

    for (const part of message.content as ToolResultContentPart[]) {
      const failed = Boolean(part.isError)
      attempts.push({
        tool: part.toolName ?? "unknown",
        succeeded: !failed,
        error: failed ? new Error(String(part.result)) : undefined,
      })
    }
  }
  return attempts
}

function summarizeToolAttempts(attempts: readonly ToolAttempt[]): ToolHistory {
  const callsByTool = new Map<string, number>()
  const failureRunByTool = new Map<string, number>()

  for (const attempt of attempts) {
    const callCount = callsByTool.get(attempt.tool) ?? 0
    callsByTool.set(attempt.tool, callCount + 1)

    const priorFailureRun = failureRunByTool.get(attempt.tool) ?? 0
    failureRunByTool.set(attempt.tool, attempt.succeeded ? 0 : priorFailureRun + 1)
  }

  const latestAttempt = attempts.at(-1)
  return {
    toolCallCount: attempts.length,
    toolTypeCounters: callsByTool,
    consecutiveFailures: failureRunByTool,
    currentToolName: latestAttempt?.tool,
    currentToolError: latestAttempt?.error,
    currentToolSuccess: latestAttempt?.succeeded,
  }
}

export function buildReminderContext<TTodo = unknown>(
  messages: readonly ReminderMessage[],
  todos: readonly TTodo[],
  responseMessages: readonly ReminderMessage[] = [],
): ReminderContext<TTodo> {
  return {
    ...summarizeToolAttempts(collectToolAttempts(messages)),
    todos,
    conversationMessages: messages,
    responseMessages,
  }
}
