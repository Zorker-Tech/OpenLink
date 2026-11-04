export interface TagRange {
  readonly start: number
  readonly end: number
  readonly tagName: string
}

type RangeKind = "complete" | "self-closing"

const OPENING_TAG = /<([a-zA-Z_][a-zA-Z0-9_]*)(?=[\s/>])/g

function openingEnd(text: string, afterName: number): number {
  let quoted = false
  for (let index = afterName; index < text.length; index += 1) {
    const character = text[index]
    if (quoted) {
      if (character === '"') quoted = false
    } else if (character === '"') {
      quoted = true
    } else if (character === ">") {
      return index
    }
  }
  return -1
}

function scanTagRanges(text: string, matches: (name: string) => boolean, kind: RangeKind): TagRange[] {
  const ranges: TagRange[] = []
  let cursor = 0
  while (cursor < text.length) {
    OPENING_TAG.lastIndex = cursor
    const opening = OPENING_TAG.exec(text)
    if (opening === null) break

    const start = opening.index
    const name = opening[1] as string
    if (!matches(name)) {
      cursor = start + 1
      continue
    }

    const endOfOpening = openingEnd(text, start + name.length + 1)
    if (endOfOpening < 0) break
    let end: number
    if (kind === "self-closing") {
      if (!text.slice(start, endOfOpening).trimEnd().endsWith("/")) {
        cursor = start + 1
        continue
      }
      end = endOfOpening + 1
    } else {
      const closeStart = text.indexOf(`</${name}>`, endOfOpening + 1)
      if (closeStart < 0) {
        cursor = start + 1
        continue
      }
      end = closeStart + name.length + 3
    }

    ranges.push({ start, end, tagName: name })
    cursor = end
  }
  return ranges
}

export function extractCompleteTagRangesMatching(
  promptContent: string,
  matches: (tagName: string) => boolean,
): TagRange[] {
  return scanTagRanges(promptContent, matches, "complete")
}

export function extractSelfClosingTagRangesMatching(
  promptContent: string,
  matches: (tagName: string) => boolean,
): TagRange[] {
  return scanTagRanges(promptContent, matches, "self-closing")
}

export function extractCompleteTagRanges(promptContent: string, tagName: string): TagRange[] {
  return extractCompleteTagRangesMatching(promptContent, (candidate) => candidate === tagName)
}
