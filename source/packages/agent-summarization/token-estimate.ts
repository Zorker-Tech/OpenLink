import { isRedactedString } from "../redaction/redacted-values.ts"
import {
  estimateStructuredPartCharacters,
  PROMPT_CHARS_PER_TOKEN,
  PROMPT_MESSAGE_FRAME_CHARS,
  readDefaultTextCharacters,
} from "./token-estimate-character-policy.ts"
import type { TokenEstimateMessage, TokenEstimateOptions, TokenEstimatePart } from "./token-estimate-contracts.ts"

export type { TokenEstimateMessage, TokenEstimateOptions } from "./token-estimate-contracts.ts"

/** Estimates prompt size for threshold decisions without invoking a model tokenizer. */
export function estimateTokenCount(
  messages: readonly TokenEstimateMessage[],
  options?: TokenEstimateOptions | null,
): number {
  const includeParts = options?.includeNonTextContent ?? false
  const textCharacterCount = options?.textContentLengthFn ?? readDefaultTextCharacters
  let characterCount = 0

  for (const message of messages) {
    const content = message.content
    if (isRedactedString(content) || typeof content === "string") {
      characterCount += textCharacterCount(message)
    } else if (Array.isArray(content)) {
      if (includeParts) {
        for (const item of content) characterCount += estimateStructuredPartCharacters(item as TokenEstimatePart)
      } else {
        characterCount += textCharacterCount(message)
      }
    }
    characterCount += PROMPT_MESSAGE_FRAME_CHARS
  }

  return Math.ceil(characterCount / PROMPT_CHARS_PER_TOKEN)
}
