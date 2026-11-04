export interface ConsoleLogPromptInput {
  readonly level: string
  readonly timestamp: number
  readonly message: string
}

export interface ConsoleLogsTextContent {
  readonly type: "text"
  readonly text: string
}

function formatLogLine(log: ConsoleLogPromptInput): string {
  const localTime = new Date(log.timestamp).toLocaleTimeString()
  return `${log.level} ${localTime}: ${log.message}`
}

export function renderConsoleLogsContext(
  logs: readonly ConsoleLogPromptInput[],
): ConsoleLogsTextContent | undefined {
  if (logs.length === 0) return undefined

  const renderedLogs = logs.map(formatLogLine).join("\n")
  return {
    type: "text",
    text: `<console_logs_context>\nConsole output attached from the runtime:\n${renderedLogs}\n</console_logs_context>`,
  }
}
