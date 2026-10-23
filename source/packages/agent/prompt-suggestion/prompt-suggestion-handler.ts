/**
 * Asking for a suggestion of what the user might type next.
 *
 * A suggestion is a small, cheap inference that runs beside the real work: the conversation is handed to a
 * model with one instruction appended, and whatever comes back is a candidate for the input box. Because it
 * runs on every turn, three things matter more than the suggestion itself. It has to be cheap, so a session
 * with a cost ceiling estimates the input first and skips the call when the model would be too expensive.
 * It has to leave the conversation as it found it, so the suggestion's own instruction is appended to a copy
 * and the executor is restored afterwards whether the call succeeded or failed. And it has to fail quietly:
 * a suggestion is a convenience, so nothing about it may disturb the turn that is running.
 *
 * What comes back is a suggestion only if it looks like one. A model asked for the user's next wordList may
 * instead continue the conversation, think out loud, or write an essay, so the first line is taken, quotes
 * are stripped, and the result is discarded if it starts as a speaker turn, contains thinking tags, is
 * longer than a suggestion, or is empty — each with its own outcome recorded, because "the model answered
 * badly" and "the model answered nothing" are different problems. A session's own silence tag is treated as
 * a deliberate no.
 */

import { createLogger, createSpan, type Context } from "../../context/index.ts"
import { Updates } from "../../agent-core/interaction-updates.ts"
import { createCounter } from "../../metrics/index.ts"
import { PrivacyMode } from "../../redaction/privacy-mode.ts"
import { PrivacyCapability } from "../../redaction/classification.ts"
import { fromRedactedCoreMessages, toRedactedCoreMessages } from "../../redaction/message-redaction.ts"
import { promptSuggestionUserMessage, PROMPT_SUGGESTION_MAX_WORDS } from "../prompts/prompt-suggestion.ts"
import { estimateStringTokenCount } from "../utils/token-estimate.ts"
import { isLargeContextModel } from "../../utils/model-markers.ts"

const logger = createLogger("prompt-suggestion")
/** A model that has nothing to suggest may say so with a tag rather than with an empty answer. */
const SILENCE_PATTERN = /<{1,2}\/?\s*silence\s*\/?>/i
const outcomeCounter = createCounter("agent.prompt_suggestion.outcome", {
  description: "Prompt suggestion outcome by model",
  labelNames: ["model", "outcome"],
})

type RedactedChatMessage = ReturnType<typeof toRedactedCoreMessages>[number]

interface SuggestionStream {
  readonly response: Promise<unknown>
  readonly fullStream: AsyncIterable<{ readonly type: string; readonly textDelta?: string | undefined }>
  readonly extendedUsage: Promise<{ readonly inputTokens: number; readonly cacheReadTokens: number }>
}

interface SuggestionExecutorPort {
  getMessages(): readonly RedactedChatMessage[]
  clearMessages(): void
  appendMessages(messages: readonly RedactedChatMessage[]): void
  stream(ctx: Context, invocationId: string, tools: readonly unknown[], options: { readonly maxTokens: number }): SuggestionStream
}

interface SuggestionListenerPort {
  sendUpdate(ctx: Context, update: ReturnType<typeof Updates.promptSuggestion>): Promise<void> | void
}

interface PriceOptions {
  readonly maxInputTokenCost?: number | undefined
  readonly getModelInputCostForContext?: ((model: string, inputEstimate: number) => number) | undefined
}

/** What the conversation would cost to send, estimated from its text rather than counted by a tokenizer. */
function estimateConversationCost(messages: readonly { readonly role: string; readonly content: unknown }[]) {
  let conversationHistoryTokens = 0
  const participantMessages = messages.filter(transcriptMessage => transcriptMessage.role !== "system")
  const historyMessageCount = participantMessages.length
  for (const transcriptMessage of participantMessages) {
    if (typeof transcriptMessage.content === "string") {
      conversationHistoryTokens += estimateStringTokenCount(transcriptMessage.content)
    } else if (Array.isArray(transcriptMessage.content)) {
      for (const contentPart of transcriptMessage.content) {
        if (typeof contentPart === "string") {
          conversationHistoryTokens += estimateStringTokenCount(contentPart)
        } else if (typeof contentPart === "object" && contentPart !== null) {
          if ("text" in contentPart && typeof contentPart.text === "string") {
            conversationHistoryTokens += estimateStringTokenCount(contentPart.text)
          }
          if ("toolName" in contentPart && typeof contentPart.toolName === "string") {
            conversationHistoryTokens += estimateStringTokenCount(contentPart.toolName)
          }
          if ("args" in contentPart && contentPart.args !== undefined) {
            conversationHistoryTokens += estimateStringTokenCount(JSON.stringify(contentPart.args)!)
          }
          if ("result" in contentPart && contentPart.result !== undefined) {
            conversationHistoryTokens += estimateStringTokenCount(JSON.stringify(contentPart.result)!)
          }
        }
      }
    }
  }
  return { conversationHistoryTokens, historyMessageCount }
}

function wordCountOf(text: string): number {
  const wordList = text.trim().split(/\s+/)
  return wordList.length > 0 && wordList[0] !== "" ? wordList.length : 0
}

/** Why an answer was not usable as a suggestion, so each reason can be counted separately. */
function suggestionFromResponse(
  rawResponse: string,
  wordLimit = PROMPT_SUGGESTION_MAX_WORDS,
):
  | { readonly type: "empty" }
  | { readonly type: "bad_output"; readonly suggestion: string; readonly reason: "human_prefix" | "thinking_tags" }
  | { readonly type: "too_long"; readonly suggestion: string; readonly wordCount: number }
  | { readonly type: "success"; readonly suggestion: string } {
  const stripped = rawResponse.trim()
  if (stripped.length === 0) {
    return { type: "empty" }
  }
  if (SILENCE_PATTERN.test(stripped)) {
    return { type: "empty" }
  }
  // Only the first line is a suggestion; anything after it is the model continuing instead.
  const headline = stripped.split(/\r?\n/)[0]!.trim()
  const candidate = headline.replace(/^"(.*)"$/, "$1").trim()
  if (candidate.length === 0) {
    return { type: "empty" }
  }
  if (candidate.startsWith("Human:")) {
    return {
      type: "bad_output",
      suggestion: candidate,
      reason: "human_prefix",
    }
  }
  if (/<\/?think>/.test(candidate)) {
    return {
      type: "bad_output",
      suggestion: candidate,
      reason: "thinking_tags",
    }
  }
  const wordCount = wordCountOf(candidate)
  if (wordCount > wordLimit) {
    return { type: "too_long", suggestion: candidate, wordCount }
  }
  return { type: "success", suggestion: candidate }
}

export async function requestPromptSuggestion(
  parentCtx: Context,
  invocationId: string,
  model: string,
  executor: SuggestionExecutorPort,
  interactionListener: SuggestionListenerPort,
  tools: readonly unknown[],
  messagesSnapshot: readonly RedactedChatMessage[] | undefined,
  priceOptions: PriceOptions | undefined,
): Promise<void> {
  using suggestionSpan = createSpan(parentCtx.withName("requestPromptSuggestion"))
  const ctx = suggestionSpan.ctx
  const conversationMessages = messagesSnapshot ?? executor.getMessages()
  const costCeiling = priceOptions?.maxInputTokenCost
  const inputCostOf = priceOptions?.getModelInputCostForContext
  try {
    // The estimate is of the input alone, plus a fixed allowance for the instructions that go with it.
    if (costCeiling && costCeiling > 0 && inputCostOf) {
      const plainMessages = fromRedactedCoreMessages(conversationMessages, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED)
      const { conversationHistoryTokens: historyTokens } = estimateConversationCost(plainMessages)
      const SYSTEM_PROMPT_OVERHEAD_TOKENS = 2e4
      const inputEstimate = historyTokens + SYSTEM_PROMPT_OVERHEAD_TOKENS
      const estimatedCost = inputCostOf(model, inputEstimate)
      if (estimatedCost > costCeiling) {
        logger.info(ctx, "Prompt suggestion skipped: model too expensive", { model, historyTokens, inputEstimate, estimatedCost, costCeiling })
        outcomeCounter.increment(ctx, 1, { model, outcome: "skipped_expensive" })
        return
      }
    }
    // A snapshot replaces what the executor holds, so the suggestion sees the conversation as it is now.
    if (messagesSnapshot) {
      executor.clearMessages()
      executor.appendMessages(messagesSnapshot)
    }
    const readsLargerContext = isLargeContextModel(model)
    const suggestionInstruction = {
      role: "user",
      content: promptSuggestionUserMessage(readsLargerContext),
      providerOptions: {
        cursor: {
          inferenceReason: "prompt-suggestion",
          featureType: "promptSuggestion",
        },
      },
    }
    executor.appendMessages(toRedactedCoreMessages([suggestionInstruction], PrivacyMode.UNSPECIFIED))
    try {
      // A suggestion is a sentence or two, and the model that reads more context is allowed more of them.
      const maxTokens = readsLargerContext ? 128 : 64
      const suggestionStream = executor.stream(ctx, invocationId, tools, { maxTokens })
      // The rawResponse promise is settled alongside the stream so a failure is not lost if the stream ends first.
      const settledCall = suggestionStream.response.then(() => ({ didReject: false as const }), failure => ({ didReject: true as const, failure }))
      let answerText = ""
      for await (const chunk of suggestionStream.fullStream) {
        if (chunk.type === "text-delta") {
          answerText += chunk.textDelta ?? ""
        }
      }
      const settledResult = await settledCall
      if (settledResult.didReject) {
        throw settledResult.failure
      }
      const usageReport = await suggestionStream.extendedUsage
      const cacheRatio = usageReport.inputTokens > 0 ? (usageReport.cacheReadTokens / usageReport.inputTokens).toFixed(2) : "N/A"
      logger.info(ctx, "Prompt suggestion completed", { inputTokens: usageReport.inputTokens, cacheReadTokens: usageReport.cacheReadTokens, cacheRatio })
      const parsedSuggestion = suggestionFromResponse(answerText)
      switch (parsedSuggestion.type) {
        case "success":
          outcomeCounter.increment(ctx, 1, { model, outcome: "suggested" })
          await interactionListener.sendUpdate(ctx, Updates.promptSuggestion(parsedSuggestion.suggestion))
          break
        case "too_long":
          logger.info(ctx, "Prompt suggestion discarded: too long", { wordCount: parsedSuggestion.wordCount, wordLimit: PROMPT_SUGGESTION_MAX_WORDS, suggestion: parsedSuggestion.suggestion })
          outcomeCounter.increment(ctx, 1, { model, outcome: "too_long" })
          break
        case "bad_output":
          logger.info(ctx, "Prompt suggestion discarded: bad output", { reason: parsedSuggestion.reason, suggestion: parsedSuggestion.suggestion })
          outcomeCounter.increment(ctx, 1, { model, outcome: "bad_output" })
          break
        case "empty":
          outcomeCounter.increment(ctx, 1, { model, outcome: "no_suggestion" })
          break
      }
    } catch (failure) {
      outcomeCounter.increment(ctx, 1, { model, outcome: "failure" })
      logger.error(ctx, "Error during prompt suggestion request", failure)
    } finally {
      // Whatever happened, the executor holds the conversation it held before.
      executor.clearMessages()
      executor.appendMessages(conversationMessages)
    }
  } catch {}
}
