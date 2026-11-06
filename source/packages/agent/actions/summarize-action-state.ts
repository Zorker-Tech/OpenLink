import { buildSummarizeRefreshSnapshot } from "../utils/prompt-token-breakdown.ts"
import { estimateTokenCount, extractTextContent } from "../self-summary/token-estimate.ts"
import { RedactedUpdates } from "../../agent-core/redacted-interaction-updates.ts"
import { createRedactedString } from "../../redaction/create.ts"
import { DataClassification, PrivacyCapability } from "../../redaction/classification.ts"
import { RedactedString } from "../../redaction/redacted-values.ts"
import type { Context } from "../../context/context.ts"
import type { PrivacyMode } from "../../redaction/privacy-mode.ts"
import { isInteropSummaryPromptMessage } from "../../../adapters/interop/agent/summarize-action-adapter.ts"
import type { RootPromptExecutor, SummarizeStateHandler, SummarizeLooseValue } from "./summarize-action-contracts.ts"

function summarizedConversationCharCount(messages: readonly SummarizeLooseValue[]): number {
  let characterCount = 0
  for (const message of messages) {
    if (isInteropSummaryPromptMessage(message)) characterCount += extractTextContent(message).length
  }
  return characterCount
}

export async function applySummaryToConversation(options: {
  readonly context: Context
  readonly summary: string | RedactedString
  readonly state: SummarizeStateHandler
  readonly prompt: RootPromptExecutor
  readonly listener: { sendUpdate(context: Context, update: unknown): Promise<void> }
  readonly clearTurns: boolean
  readonly privacyMode: PrivacyMode
}): Promise<void> {
  const summaryText = options.summary instanceof RedactedString
    ? options.summary.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED)
    : options.summary
  const redactedSummary = options.summary instanceof RedactedString
    ? options.summary
    : createRedactedString(options.summary, DataClassification.CODE, "summary", options.privacyMode)
  options.state.setSummary({ content: summaryText })
  await options.listener.sendUpdate(options.context, RedactedUpdates.summary(redactedSummary))
  if (options.clearTurns) await options.state.clearTurns()

  const messages = options.prompt.getMessages()
  const usedTokens = estimateTokenCount(messages, { includeNonTextContent: true })
  const previousBreakdown = options.state.tokenDetails.breakdown
  const nextBreakdown = previousBreakdown === undefined
    ? previousBreakdown
    : buildSummarizeRefreshSnapshot({
      previousSnapshot: previousBreakdown,
      newSummarizedConversationCharCount: summarizedConversationCharCount(messages),
      totalUsedTokens: usedTokens,
      maxTokens: options.state.tokenDetails.maximumTokens,
    })

  options.state.setTokenDetails({
    usedTokens,
    maximumTokens: options.state.tokenDetails.maximumTokens,
    ...(nextBreakdown === undefined ? {} : { breakdown: nextBreakdown }),
  })
}
