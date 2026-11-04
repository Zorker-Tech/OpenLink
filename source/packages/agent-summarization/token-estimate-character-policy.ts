import type { TokenEstimateMessage, TokenEstimatePart } from "./token-estimate-contracts.ts"
import { isRedactedString } from "../redaction/redacted-values.ts"

export const PROMPT_CHARS_PER_TOKEN = 2.5
export const PROMPT_MESSAGE_FRAME_CHARS = 25
export const PROMPT_TOOL_FRAME_CHARS = 50

export function safeContentLength(value: unknown): number {
  if (typeof value === "string") return value.length
  if (typeof value !== "object" || value === null || !("length" in value)) return 0

  try {
    const candidate = value.length
    return typeof candidate === "number" ? candidate : 0
  } catch {
    return 0
  }
}

export function estimateStructuredPartCharacters(part: TokenEstimatePart): number {
  switch (part.type) {
    case "text": return safeContentLength(part.text)
    case "tool-call": return safeContentLength(part.args) + PROMPT_TOOL_FRAME_CHARS
    case "tool-result": return safeContentLength(part.result) + PROMPT_TOOL_FRAME_CHARS
    case "unknown": return safeContentLength(part.data)
    default: return 0
  }
}

export function readDefaultTextCharacters(message: TokenEstimateMessage): number {
  const body = message.content
  if (isRedactedString(body) || typeof body === "string") return safeContentLength(body)
  if (!Array.isArray(body)) return 0

  let characters = 0
  for (const item of body) {
    const part = item as TokenEstimatePart
    if (part.type === "text") characters += safeContentLength(part.text)
  }
  return characters
}
