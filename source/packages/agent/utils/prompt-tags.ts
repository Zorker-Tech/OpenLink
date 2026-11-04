export {
  extractCompleteTagRanges,
  extractCompleteTagRangesMatching,
  extractSelfClosingTagRangesMatching,
  type TagRange,
} from "./prompt-tag-range-parser.ts"

import {
  extractCompleteTagRangesMatching,
  extractSelfClosingTagRangesMatching,
  type TagRange,
} from "./prompt-tag-range-parser.ts"

/** Prompt marker names understood by Slate's MCP tool catalog. */
export const MCP_SERVER_TAG_NAMES = new Set([
  "mcp_file_system_server",
  "mcp_meta_tool_server",
  "namespace",
  "dynamic_tool_namespace",
])

export function isMcpServerTagName(tagName: string): boolean {
  return MCP_SERVER_TAG_NAMES.has(tagName)
}

/** Preserve the prompt reader's ordering: standalone namespaces before complete sections. */
export function extractMcpServerTagRanges(promptContent: string): TagRange[] {
  const seenStarts = new Set<number>()
  const ranges: TagRange[] = []
  const addOnce = (range: TagRange): void => {
    if (seenStarts.has(range.start)) return
    seenStarts.add(range.start)
    ranges.push(range)
  }
  for (const range of extractSelfClosingTagRangesMatching(promptContent, isMcpServerTagName)) addOnce(range)
  for (const range of extractCompleteTagRangesMatching(promptContent, isMcpServerTagName)) addOnce(range)
  return ranges
}
