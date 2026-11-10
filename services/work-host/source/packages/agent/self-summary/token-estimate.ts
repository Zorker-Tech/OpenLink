/** Counts the text a summary can actually see, excluding hidden reasoning. */

import {
  estimateTokenCount as estimateConversationTokens,
  type TokenEstimateOptions,
} from "../../agent-summarization/token-estimate.ts"
import { DataClassification, PrivacyCapability } from "../../redaction/classification.ts"
import { createRedactedString, safeString } from "../../redaction/create.ts"
import type { PrivacyMode } from "../../redaction/privacy-mode.ts"
import { isRedactedString, type RedactedString } from "../../redaction/redacted-values.ts"
import { stripThinkingTags } from "../loop-detection/agent-loop-detector.ts"

export interface SelfSummaryMessage {
  readonly content: unknown
  readonly _privacyMode: PrivacyMode
  readonly [key: string]: unknown
}

interface TextContentPart {
  readonly type?: unknown
  readonly text: RedactedString
}

function summaryText(text: string, privacyMode: PrivacyMode): RedactedString {
  return createRedactedString(
    stripThinkingTags(text),
    DataClassification.CODE,
    "extractedTextContent",
    privacyMode,
  )
}

function readableParts(parts: readonly unknown[]): string {
  const segments: string[] = []
  for (const part of parts as readonly TextContentPart[]) {
    if (part.type !== "text") continue
    const text = part.text.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED)
    if (text.length > 0) segments.push(text)
  }
  return segments.join("\n")
}

export function extractTextContent(message: SelfSummaryMessage): RedactedString {
  const { content, _privacyMode } = message

  if (isRedactedString(content)) return content.safeTransform(stripThinkingTags)
  if (typeof content === "string") return summaryText(content, _privacyMode)
  if (Array.isArray(content)) return summaryText(readableParts(content), _privacyMode)
  return safeString("")
}

export function estimateTokenCount(
  messages: readonly SelfSummaryMessage[],
  options?: Omit<TokenEstimateOptions, "textContentLengthFn"> | null,
): number {
  return estimateConversationTokens(messages, {
    ...options,
    textContentLengthFn: message => extractTextContent(message as SelfSummaryMessage).length,
  })
}
