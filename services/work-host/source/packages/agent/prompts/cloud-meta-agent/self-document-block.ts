import { NAMED_AGENT_STORE_SELF_PATH } from "../../constants.ts"

const SELF_DOCUMENT_TAG = "agent_self_document"
const SELF_DOCUMENT_OPEN = "<" + SELF_DOCUMENT_TAG + ">"
const SELF_DOCUMENT_CLOSE = "</" + SELF_DOCUMENT_TAG + ">"
const USER_INFO_CLOSE = "</user_info>"

interface BlockRange {
  readonly start: number
  readonly end: number
}

function firstBlockRange(text: string): BlockRange | undefined {
  const start = text.indexOf(SELF_DOCUMENT_OPEN)
  if (start < 0) return undefined
  const closeStart = text.indexOf(SELF_DOCUMENT_CLOSE, start + SELF_DOCUMENT_OPEN.length)
  if (closeStart < 0) return undefined
  return { start, end: closeStart + SELF_DOCUMENT_CLOSE.length }
}

export function renderNamedAgentSelfDocumentBlock(contents: string | null | undefined): string {
  const document = contents?.trim()
  const storedText = document === undefined || document.length === 0
    ? "No self document has been written at " + NAMED_AGENT_STORE_SELF_PATH + "."
    : document
  const safeText = storedText
    .replaceAll(SELF_DOCUMENT_OPEN, "<\\" + SELF_DOCUMENT_TAG + ">")
    .replaceAll(SELF_DOCUMENT_CLOSE, "<\\/" + SELF_DOCUMENT_TAG + ">")
  const instruction = "Identity record from " + NAMED_AGENT_STORE_SELF_PATH +
    ". This copy is refreshed automatically; use it to identify yourself instead of reopening the file."
  return [SELF_DOCUMENT_OPEN, instruction, "", safeText, SELF_DOCUMENT_CLOSE].join("\n")
}

export function extractNamedAgentSelfDocumentBlock(text: string | undefined): string | undefined {
  if (text === undefined) return undefined
  const range = firstBlockRange(text)
  return range === undefined ? undefined : text.slice(range.start, range.end)
}

export function refreshSelfDocumentText(text: string, contents: string | null | undefined): string | undefined {
  const replacement = renderNamedAgentSelfDocumentBlock(contents)
  const range = firstBlockRange(text)
  if (range !== undefined) {
    return text.slice(0, range.start) + replacement + text.slice(range.end)
  }

  const closeAt = text.indexOf(USER_INFO_CLOSE)
  if (closeAt < 0) return undefined
  const boundary = closeAt + USER_INFO_CLOSE.length
  return text.slice(0, boundary) + "\n\n" + replacement + text.slice(boundary)
}
