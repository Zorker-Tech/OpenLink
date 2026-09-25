/**
 * The console output the user attached, as context.
 *
 * A user debugging a page attaches the console, and what makes it useful is the order and the moment: the
 * level and the time are kept on each line so a failure can be placed relative to what preceded it. The
 * times are rendered in the reader's own zone rather than as raw timestamps, because the agent is
 * reasoning about a sequence the user watched.
 */

import type { SelectedConsoleLog } from "../../proto/generated/agent/v1/selected_context_pb.ts"

export interface ConsoleLogsTextContent {
  readonly type: "text"
  readonly text: string
}

export function renderConsoleLogsContext(
  consoleLogs: readonly SelectedConsoleLog[],
): ConsoleLogsTextContent | undefined {
  if (consoleLogs.length === 0) return undefined
  const logsText = consoleLogs
    .map(log => `${log.level} ${new Date(log.timestamp).toLocaleTimeString()}: ${log.message}`)
    .join("\n")
  return {
    type: "text",
    text: `<console_logs_context>
Recent logs from the runtime connected to the AI agent.
${logsText}
</console_logs_context>`,
  }
}
