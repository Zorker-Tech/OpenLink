/**
 * Which questions are still waiting for an answer.
 *
 * A question asked in the foreground can be pushed into the background — the user is asked to continue
 * later — and then the same question exists in two places: the original call, and the asynchronous one
 * that carries the original's id in its arguments. When the conversation is replayed, the platform needs
 * to know which questions are live rather than which calls were made, and the id of the original is what
 * ties the two together.
 *
 * The tool is recognized by name in either spelling, because the name has changed once and a
 * conversation may contain either.
 */

import { PrivacyCapability } from "../../../../redaction/classification.ts"

interface RedactedToolArguments {
  unwrap(purpose: PrivacyCapability): string
}

interface ReplayHorizonMessage {
  readonly role: string
  readonly content: unknown
}

function readAsyncOriginalToolCallId(args: RedactedToolArguments): string | undefined {
  let parsedArgs: unknown
  try {
    parsedArgs = JSON.parse(args.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED))
  } catch {
    return undefined
  }
  if (
    typeof parsedArgs !== "object" ||
    parsedArgs === null ||
    Array.isArray(parsedArgs) ||
    !("async_original_tool_call_id" in parsedArgs)
  ) {
    return undefined
  }
  const originalToolCallId = parsedArgs.async_original_tool_call_id
  return typeof originalToolCallId === "string" && originalToolCallId.length > 0 ? originalToolCallId : undefined
}

function isAskQuestionToolName(toolName: string): boolean {
  const normalized = toolName.toLowerCase().replace(/_/g, "")
  return normalized === "askquestion" || normalized === "multiplechoice"
}

export function collectLiveAskQuestionOriginalIds(messages: readonly ReplayHorizonMessage[]): Set<string> {
  const liveOriginalIds = new Set<string>()
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue
    for (const part of message.content) {
      const typedPart = part as {
        readonly type: string
        readonly toolName: string
        readonly args: RedactedToolArguments
        readonly toolCallId: string
      }
      if (typedPart.type !== "tool-call" || !isAskQuestionToolName(typedPart.toolName)) continue
      // A foreground question names itself; an asynchronous one names the question it came from.
      const originalToolCallId = readAsyncOriginalToolCallId(typedPart.args) ?? typedPart.toolCallId
      if (originalToolCallId.length > 0) liveOriginalIds.add(originalToolCallId)
    }
  }
  return liveOriginalIds
}
