/**
 * Reading a prompt the way the platform assembled it.
 *
 * Both the token breakdown and the context tree have to take a prompt apart, and they have to take it
 * apart the same way or the two views of one prompt would disagree. The rules they share live here:
 * which tags carry MCP and dynamic tool definitions, which message carries a summary instead of the
 * conversation, how a task tool's description is split from the subagent definitions it contains, and
 * how a nested block is kept from being counted twice.
 */

import { extractCompleteTagRangesMatching, type TagRange } from "./prompt-tags.ts"
import type { PromptMessageLike, PromptToolLike } from "./prompt-shapes.ts"

export function isMcpBlockTag(tagName: string): boolean {
  return tagName.startsWith("mcp_")
}

export function isDynamicToolBlockTag(tagName: string): boolean {
  return tagName.startsWith("dynamic_tool")
}

/** The blocks that describe tools the model may call; they are counted as MCP and dynamic tools. */
export function isToolDiscoveryBlockTag(tagName: string): boolean {
  return isMcpBlockTag(tagName) || isDynamicToolBlockTag(tagName)
}

/** The summarizer marks the message that stands in for the conversation it replaced. */
export function isSummaryCarrierMessage(message: PromptMessageLike): boolean {
  return message.role === "user" && message.providerOptions?.slate?.isSummary === true
}

/** Of the ranges found, only the outermost: a block nested inside another is part of it. */
export function selectOutermostRanges(ranges: readonly TagRange[]): TagRange[] {
  const sorted = [...ranges].sort((left, right) => {
    if (left.start !== right.start) return left.start - right.start
    return right.end - left.end
  })
  const selected: TagRange[] = []
  let coveredUntil = -1
  for (const range of sorted) {
    if (range.start < coveredUntil) continue
    selected.push(range)
    coveredUntil = range.end
  }
  return selected
}

export function extractToolDiscoveryBlocks(text: string): string[] {
  const ranges = extractCompleteTagRangesMatching(text, isToolDiscoveryBlockTag)
  return selectOutermostRanges(ranges).map(range => text.slice(range.start, range.end))
}

export function stripTagBlocks(text: string, matchesStrippedTag: (tagName: string) => boolean): string {
  const outermost = selectOutermostRanges(extractCompleteTagRangesMatching(text, matchesStrippedTag))
  let stripped = ""
  let cursor = 0
  for (const range of outermost) {
    stripped += text.slice(cursor, range.start)
    cursor = range.end
  }
  stripped += text.slice(cursor)
  return stripped
}

/**
 * The task tool's description carries the list of subagent types inside it, and those definitions are
 * the subagent category rather than the tool's own. Removing the occurrence the generator reports keeps
 * the two from counting the same text.
 */
export function splitSubagentDescriptionFromTool(
  tool: PromptToolLike,
  description: string,
  descriptionProps: Record<string, unknown>,
): { toolDescription: string; subagentText: string } {
  if (tool.toolIdentifier !== "TASK" || !("descriptionTokenPartsGenerator" in tool)) {
    return { toolDescription: description, subagentText: "" }
  }
  const subagentText = tool.descriptionTokenPartsGenerator?.(descriptionProps).subagentDescriptionText ?? ""
  if (subagentText.length === 0) return { toolDescription: description, subagentText: "" }
  const lastOccurrence = description.lastIndexOf(subagentText)
  if (lastOccurrence === -1) return { toolDescription: description, subagentText: "" }
  return {
    toolDescription: description.slice(0, lastOccurrence) + description.slice(lastOccurrence + subagentText.length),
    subagentText,
  }
}

/** How the provider sees a tool: its name, its description, and its schema as it is sent. */
export function serializeProviderFacingToolDefinition(tool: Record<string, any>): string {
  return `${tool.name} ${tool.description} ${JSON.stringify(tool.customToolFormat ?? tool.parameters)}`
}

/** The text of a message: a bare string, or the text parts of its content. */
export function getTextLikeContentParts(content: unknown): string[] {
  if (typeof content === "string") return [content]
  if (!Array.isArray(content)) return []
  const out: string[] = []
  for (const part of content) {
    if (typeof part === "string") {
      out.push(part)
      continue
    }
    if (typeof part === "object" && part !== null && "text" in part && typeof (part as { text?: unknown }).text === "string") {
      out.push((part as { text: string }).text)
    }
  }
  return out
}
