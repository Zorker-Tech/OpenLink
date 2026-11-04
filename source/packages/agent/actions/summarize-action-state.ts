import { buildSummarizeRefreshSnapshot } from "../utils/prompt-token-breakdown.ts"
import { estimateTokenCount, extractTextContent } from "../self-summary/token-estimate.ts"
import { RedactedUpdates } from "../../agent-core/redacted-interaction-updates.ts"
import type { Context } from "../../context/context.ts"
import type { PrivacyMode } from "../../redaction/privacy-mode.ts"
import {
  createInteropConversationSummary,
  createInteropConversationTokenDetails,
  decodeInteropPromptTokenBreakdown,
  encodeInteropPromptTokenBreakdown,
  isInteropSummaryPromptMessage,
} from "../../../adapters/interop/agent/summarize-action-adapter.ts"
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
  readonly summary: SummarizeLooseValue
  readonly state: SummarizeStateHandler
  readonly prompt: RootPromptExecutor
  readonly listener: { sendUpdate(context: Context, update: unknown): Promise<void> }
  readonly clearTurns: boolean
  readonly privacyMode: PrivacyMode
}): Promise<void> {
  options.state.setSummary(createInteropConversationSummary(options.privacyMode, options.summary))
  await options.listener.sendUpdate(options.context, RedactedUpdates.summary(options.summary))
  if (options.clearTurns) await options.state.clearTurns()

  const messages = options.prompt.getMessages()
  const usedTokens = estimateTokenCount(messages, { includeNonTextContent: true })
  const previousBreakdown = options.state.tokenDetails.breakdown
  const nextBreakdown = previousBreakdown === undefined
    ? previousBreakdown
    : encodeInteropPromptTokenBreakdown(buildSummarizeRefreshSnapshot({
      previousSnapshot: decodeInteropPromptTokenBreakdown(previousBreakdown),
      newSummarizedConversationCharCount: summarizedConversationCharCount(messages),
      totalUsedTokens: usedTokens,
      maxTokens: options.state.tokenDetails.maxTokens,
    }), options.privacyMode)

  options.state.setTokenDetails(createInteropConversationTokenDetails(options.privacyMode, {
    usedTokens,
    maxTokens: options.state.tokenDetails.maxTokens,
    breakdown: nextBreakdown,
    promptContextUsageTree: undefined,
  }))
}
