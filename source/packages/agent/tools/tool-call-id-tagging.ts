/**
 * Putting a tool call's reference on the result the model reads.
 *
 * The model is told about tool calls by reference, so the reference has to be attached to the result
 * rather than only to the call: a result that arrives without one cannot be referred to later. It is
 * appended to the result's text, or added as a text part when the result has none — and never twice, so
 * a result that already ends in its tag is left alone.
 *
 * Only a session where the model is talking to a subagent directly is tagged, because that is the
 * conversation in which references are used.
 */

import { createToolCallReferenceId, isValidPromptReferenceId, renderToolCallIdTag } from "./prompt-reference-contract.ts"
import { getIsDirectMetaParentChildSubagentFromContext } from "../utils/request-scope.ts"

function hasTagAtEnd(text: string, tag: string): boolean {
  return text.trimEnd().endsWith(tag)
}

function appendTag(text: string, tag: string): string {
  return hasTagAtEnd(text, tag) ? text : `${text}\n${tag}`
}

interface ToolResultPart {
  type: string
  toolCallId: string
  result?: unknown
  experimental_content?: Array<{ type?: string; text?: string }>
}

interface ToolMessage {
  role: string
  content?: unknown
}

export function appendToolCallIdTagsToToolResults(messages: readonly ToolMessage[]): void {
  for (const message of messages) {
    if (message.role !== "tool" || !Array.isArray(message.content)) continue
    for (const candidate of message.content) {
      if (
        candidate === null || typeof candidate !== "object" ||
        !("type" in candidate) || candidate.type !== "tool-result" ||
        !("toolCallId" in candidate) || typeof candidate.toolCallId !== "string"
      ) {
        continue
      }
      const part = candidate as ToolResultPart
      const refId = createToolCallReferenceId(part.toolCallId)
      if (!isValidPromptReferenceId(refId)) continue
      const tag = renderToolCallIdTag(refId)
      if (typeof part.result === "string") part.result = appendTag(part.result, tag)
      else if (part.result === undefined || part.result === null) part.result = tag
      if (!Array.isArray(part.experimental_content)) continue
      let updatedTextPart = false
      for (let index = part.experimental_content.length - 1; index >= 0; index--) {
        const contentPart = part.experimental_content[index]
        if (contentPart?.type === "text" && typeof contentPart.text === "string") {
          contentPart.text = appendTag(contentPart.text, tag)
          updatedTextPart = true
          break
        }
      }
      if (!updatedTextPart) part.experimental_content.push({ type: "text", text: tag })
    }
  }
}

export function shouldTagToolCallIdsForCurrentContext(
  ctx: Parameters<typeof getIsDirectMetaParentChildSubagentFromContext>[0],
): boolean {
  return getIsDirectMetaParentChildSubagentFromContext(ctx)
}
