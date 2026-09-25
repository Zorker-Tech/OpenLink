/**
 * A conversation as a trace, which is the shape a transcript page reads.
 *
 * A stored conversation is a list of messages with their tool calls attached to the assistant message that
 * made them; a trace is a flat list of entries where each tool call and each tool result is its own row.
 * That flattening is what a reader wants — the calls and their results line up in the order they happened —
 * and it is also where the visibility mode applies: an external reader starts after the preamble, and the
 * very first message of an internal one is labelled as the system turn it is.
 *
 * Arguments and results arrive as text, and are parsed back into JSON when they are JSON, because a trace
 * is meant to be read as data rather than as quoted strings. Timestamps are carried as numbers with the
 * duration between them worked out here, since a reader should not have to subtract two fields to see how
 * long a call took.
 */

import { ConversationMessage_MessageType, type ConversationMessage } from "../../../packages/proto/generated/aiserver/v1/chat_pb.ts"

export enum HistoryVisibilityMode { INTERNAL = "INTERNAL", EXTERNAL = "EXTERNAL", NO_PREAMBLE = "NO_PREAMBLE" }
type ToolResult = ConversationMessage["toolResults"][number]

/** Text that is JSON is handed over as data; text that is not is handed over as it stands. */
function tryParseJson(value: string | undefined): unknown {
  if (!value) return undefined
  try { return JSON.parse(value) } catch { return value }
}

function applyToolCallTimestamps(target: Record<string, unknown>, toolResult: ToolResult): void {
  const startedAtMs = toolResult.startedAtMs !== undefined ? Number(toolResult.startedAtMs) : undefined
  const completedAtMs = toolResult.completedAtMs !== undefined ? Number(toolResult.completedAtMs) : undefined
  if (startedAtMs !== undefined) target.started_at_ms = startedAtMs
  if (completedAtMs !== undefined) target.completed_at_ms = completedAtMs
  if (startedAtMs !== undefined && completedAtMs !== undefined) target.duration_ms = completedAtMs - startedAtMs
}

function extractToolResultContent(toolResult: ToolResult): unknown {
  if (toolResult.content) return tryParseJson(toolResult.content)
  const result = toolResult.result?.result
  return result?.case && result.value !== undefined ? { resultType: result.case, value: result.value } : undefined
}

export function convertConversationMessagesToTrace(messages: readonly ConversationMessage[], visibilityMode: HistoryVisibilityMode): Array<Record<string, unknown>> {
  const output: Array<Record<string, unknown>> = []
  // An external reader is not shown the preamble, which is the first two messages.
  const startIndex = visibilityMode === HistoryVisibilityMode.EXTERNAL ? 2 : 0
  for (let index = startIndex; index < messages.length; index++) {
    const message = messages[index] as ConversationMessage
    // The first message of an internal conversation is what the platform said, not what the user said.
    const role = index === 0 && visibilityMode === HistoryVisibilityMode.INTERNAL && message.type === ConversationMessage_MessageType.HUMAN ? "system" : message.type === ConversationMessage_MessageType.HUMAN ? "user" : message.type === ConversationMessage_MessageType.AI ? "assistant" : "unknown"
    const trace: Record<string, unknown> = { role }
    if (message.text && message.text.trim().length > 0) trace.text = message.text
    if (message.thinking?.text && message.thinking.text.trim().length > 0) trace.thinking = message.thinking.text
    if (message.type === ConversationMessage_MessageType.AI && message.toolResults.length > 0) {
      const calls = message.toolResults.map((toolResult) => {
        const call: Record<string, unknown> = {}
        if (toolResult.toolCallId) call.tool_call_id = toolResult.toolCallId
        if (toolResult.toolName) call.tool_name = toolResult.toolName
        const args = toolResult.rawArgs || toolResult.args
        if (args) call.tool_args = tryParseJson(args)
        applyToolCallTimestamps(call, toolResult)
        return call
      })
      if (calls.length > 0) trace.tool_calls = calls
    }
    output.push(trace)
    // Each result follows the message that asked for it, so a reader sees call and result in order.
    if (message.type === ConversationMessage_MessageType.AI) for (const toolResult of message.toolResults) {
      const tool: Record<string, unknown> = { role: "tool" }
      if (toolResult.toolCallId) tool.tool_call_id = toolResult.toolCallId
      if (toolResult.toolName) tool.tool_name = toolResult.toolName
      const args = toolResult.rawArgs || toolResult.args
      if (args) tool.tool_args = tryParseJson(args)
      const result = extractToolResultContent(toolResult)
      if (result !== undefined) tool.tool_result = result
      applyToolCallTimestamps(tool, toolResult)
      output.push(tool)
    }
  }
  return output
}
