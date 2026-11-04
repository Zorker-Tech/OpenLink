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

interface ReplayToolCallPart {
  readonly type: string
  readonly toolName: string
  readonly args: RedactedToolArguments
  readonly toolCallId: string
}

const QUESTION_TOOL_NAMES = new Set(["askquestion", "multiplechoice"])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function originalQuestionId(args: RedactedToolArguments): string | undefined {
  let decoded: unknown
  try {
    decoded = JSON.parse(args.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED))
  } catch {
    return undefined
  }
  if (!isRecord(decoded)) return undefined
  const originalId = decoded.async_original_tool_call_id
  return typeof originalId === "string" && originalId.length > 0 ? originalId : undefined
}

function isQuestionTool(name: string): boolean {
  const key = name.toLowerCase().replaceAll("_", "")
  return QUESTION_TOOL_NAMES.has(key)
}

export function collectLiveAskQuestionOriginalIds(messages: readonly ReplayHorizonMessage[]): Set<string> {
  const pendingOriginalIds = new Set<string>()
  for (const message of messages) {
    if (message.role !== "assistant") continue
    if (!Array.isArray(message.content)) continue

    for (const content of message.content) {
      const part = content as ReplayToolCallPart
      if (part.type !== "tool-call" || !isQuestionTool(part.toolName)) continue

      const origin = originalQuestionId(part.args) ?? part.toolCallId
      if (origin.length === 0) continue
      pendingOriginalIds.add(origin)
    }
  }
  return pendingOriginalIds
}
