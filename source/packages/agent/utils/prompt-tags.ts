/**
 * Finding the tags in a prompt.
 *
 * A prompt is assembled from sections and then read back — to measure what each section costs, to drop
 * one, or to replace it — and reading it back means finding tag ranges rather than parsing XML: the
 * prompt is text, sections can be nested, and an attribute value may contain a `>`, which is why the
 * scan tracks quotes.
 */

export interface TagRange {
  start: number
  end: number
  tagName: string
}

/** The end of an opening tag, skipping `>` inside quoted attribute values. */
function findOpenTagEnd(content: string, startIndex: number): number {
  let inQuote = false
  for (let index = startIndex; index < content.length; index++) {
    const character = content[index]
    if (inQuote) {
      if (character === '"') inQuote = false
      continue
    }
    if (character === '"') {
      inQuote = true
      continue
    }
    if (character === ">") return index
  }
  return -1
}

const OPENING_TAG = /<([a-zA-Z_][a-zA-Z0-9_]*)(?=[\s/>])/g

export function extractCompleteTagRangesMatching(
  promptContent: string,
  matches: (tagName: string) => boolean,
): TagRange[] {
  const ranges: TagRange[] = []
  let searchStart = 0
  while (searchStart < promptContent.length) {
    OPENING_TAG.lastIndex = searchStart
    const match = OPENING_TAG.exec(promptContent)
    if (match === null) break
    const openIndex = match.index
    const tagName = match[1] as string
    if (!matches(tagName)) {
      searchStart = openIndex + 1
      continue
    }
    const openTagEnd = findOpenTagEnd(promptContent, openIndex + 1 + tagName.length)
    if (openTagEnd === -1) break
    const closeTag = `</${tagName}>`
    const closeIndex = promptContent.indexOf(closeTag, openTagEnd + 1)
    if (closeIndex === -1) {
      searchStart = openIndex + 1
      continue
    }
    const end = closeIndex + closeTag.length
    ranges.push({ start: openIndex, end, tagName })
    searchStart = end
  }
  return ranges
}

export function extractSelfClosingTagRangesMatching(
  promptContent: string,
  matches: (tagName: string) => boolean,
): TagRange[] {
  const ranges: TagRange[] = []
  let searchStart = 0
  while (searchStart < promptContent.length) {
    OPENING_TAG.lastIndex = searchStart
    const match = OPENING_TAG.exec(promptContent)
    if (match === null) break
    const openIndex = match.index
    const tagName = match[1] as string
    if (!matches(tagName)) {
      searchStart = openIndex + 1
      continue
    }
    const openTagEnd = findOpenTagEnd(promptContent, openIndex + 1 + tagName.length)
    if (openTagEnd === -1) break
    let lastNonWhitespace = openTagEnd - 1
    while (lastNonWhitespace > openIndex && /\s/.test(promptContent[lastNonWhitespace] as string)) lastNonWhitespace--
    if (promptContent[lastNonWhitespace] !== "/") {
      searchStart = openIndex + 1
      continue
    }
    const end = openTagEnd + 1
    ranges.push({ start: openIndex, end, tagName })
    searchStart = end
  }
  return ranges
}

/** The tags that delimit an MCP server's section in a prompt. */
export const MCP_SERVER_TAG_NAMES = new Set([
  "mcp_file_system_server",
  "mcp_meta_tool_server",
  "namespace",
  "dynamic_tool_namespace",
])

export function isMcpServerTagName(tagName: string): boolean {
  return MCP_SERVER_TAG_NAMES.has(tagName)
}

/** Both forms, self-closing first, with a section counted once even if both match. */
export function extractMcpServerTagRanges(promptContent: string): TagRange[] {
  const seen = new Set<number>()
  const ranges: TagRange[] = []
  const add = (range: TagRange): void => {
    if (seen.has(range.start)) return
    seen.add(range.start)
    ranges.push(range)
  }
  for (const range of extractSelfClosingTagRangesMatching(promptContent, isMcpServerTagName)) add(range)
  for (const range of extractCompleteTagRangesMatching(promptContent, isMcpServerTagName)) add(range)
  return ranges
}

export function extractCompleteTagRanges(promptContent: string, tagName: string): TagRange[] {
  return extractCompleteTagRangesMatching(promptContent, candidate => candidate === tagName)
}
