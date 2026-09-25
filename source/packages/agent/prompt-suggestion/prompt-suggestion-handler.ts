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
 * What comes back is a suggestion only if it looks like one. A model asked for the user's next words may
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
const SILENCE_TAG_REGEX = /<{1,2}\/?\s*silence\s*\/?>/i
const promptSuggestionOutcome = createCounter("agent.prompt_suggestion.outcome", {
  description: "Prompt suggestion outcome by model",
  labelNames: ["model", "outcome"],
})

type RedactedMessage = ReturnType<typeof toRedactedCoreMessages>[number]

interface PromptSuggestionStreamResult {
  readonly response: Promise<unknown>
  readonly fullStream: AsyncIterable<{ readonly type: string; readonly textDelta?: string | undefined }>
  readonly extendedUsage: Promise<{ readonly inputTokens: number; readonly cacheReadTokens: number }>
}

interface PromptSuggestionExecutor {
  getMessages(): readonly RedactedMessage[]
  clearMessages(): void
  appendMessages(messages: readonly RedactedMessage[]): void
  stream(ctx: Context, invocationId: string, tools: readonly unknown[], options: { readonly maxTokens: number }): PromptSuggestionStreamResult
}

interface PromptSuggestionInteractionListener {
  sendUpdate(ctx: Context, update: ReturnType<typeof Updates.promptSuggestion>): Promise<void> | void
}

interface PromptSuggestionPriceOptions {
  readonly maxInputTokenCost?: number | undefined
  readonly getModelInputCostForContext?: ((model: string, estimatedTokens: number) => number) | undefined
}

/** What the conversation would cost to send, estimated from its text rather than counted by a tokenizer. */
function countConversationHistoryTokens(messages: readonly { readonly role: string; readonly content: unknown }[]) {
  let conversationHistoryTokens = 0
  const nonSystemMessages = messages.filter(message => message.role !== "system")
  const conversationHistoryMessageCount = nonSystemMessages.length
  for (const message of nonSystemMessages) {
    if (typeof message.content === "string") {
      conversationHistoryTokens += estimateStringTokenCount(message.content)
    } else if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (typeof part === "string") {
          conversationHistoryTokens += estimateStringTokenCount(part)
        } else if (typeof part === "object" && part !== null) {
          if ("text" in part && typeof part.text === "string") {
            conversationHistoryTokens += estimateStringTokenCount(part.text)
          }
          if ("toolName" in part && typeof part.toolName === "string") {
            conversationHistoryTokens += estimateStringTokenCount(part.toolName)
          }
          if ("args" in part && part.args !== undefined) {
            conversationHistoryTokens += estimateStringTokenCount(JSON.stringify(part.args)!)
          }
          if ("result" in part && part.result !== undefined) {
            conversationHistoryTokens += estimateStringTokenCount(JSON.stringify(part.result)!)
          }
        }
      }
    }
  }
  return { conversationHistoryTokens, conversationHistoryMessageCount }
}

function countWords(text: string): number {
  const words = text.trim().split(/\s+/)
  return words.length > 0 && words[0] !== "" ? words.length : 0
}

/** Why an answer was not usable as a suggestion, so each reason can be counted separately. */
function extractSuggestionWithReason(
  response: string,
  maxWords = PROMPT_SUGGESTION_MAX_WORDS,
):
  | { readonly type: "empty" }
  | { readonly type: "bad_output"; readonly suggestion: string; readonly reason: "human_prefix" | "thinking_tags" }
  | { readonly type: "too_long"; readonly suggestion: string; readonly wordCount: number }
  | { readonly type: "success"; readonly suggestion: string } {
  const trimmed = response.trim()
  if (trimmed.length === 0) {
    return { type: "empty" }
  }
  if (SILENCE_TAG_REGEX.test(trimmed)) {
    return { type: "empty" }
  }
  // Only the first line is a suggestion; anything after it is the model continuing instead.
  const firstLine = trimmed.split(/\r?\n/)[0]!.trim()
  const unquoted = firstLine.replace(/^"(.*)"$/, "$1").trim()
  if (unquoted.length === 0) {
    return { type: "empty" }
  }
  if (unquoted.startsWith("Human:")) {
    return {
      type: "bad_output",
      suggestion: unquoted,
      reason: "human_prefix",
    }
  }
  if (/<\/?think>/.test(unquoted)) {
    return {
      type: "bad_output",
      suggestion: unquoted,
      reason: "thinking_tags",
    }
  }
  const wordCount = countWords(unquoted)
  if (wordCount > maxWords) {
    return { type: "too_long", suggestion: unquoted, wordCount }
  }
  return { type: "success", suggestion: unquoted }
}

export async function requestPromptSuggestion(
  parentCtx: Context,
  invocationId: string,
  model: string,
  executor: PromptSuggestionExecutor,
  interactionListener: PromptSuggestionInteractionListener,
  tools: readonly unknown[],
  messagesSnapshot: readonly RedactedMessage[] | undefined,
  priceOptions: PromptSuggestionPriceOptions | undefined,
): Promise<void> {
  using spanCtxt = createSpan(parentCtx.withName("requestPromptSuggestion"))
  const ctx = spanCtxt.ctx
  const currentMessages = messagesSnapshot ?? executor.getMessages()
  const maxCost = priceOptions?.maxInputTokenCost
  const costFn = priceOptions?.getModelInputCostForContext
  try {
    // The estimate is of the input alone, plus a fixed allowance for the instructions that go with it.
    if (maxCost && maxCost > 0 && costFn) {
      const unwrappedMessages = fromRedactedCoreMessages(currentMessages, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED)
      const { conversationHistoryTokens: rawEstimatedTokens } = countConversationHistoryTokens(unwrappedMessages)
      const SYSTEM_PROMPT_OVERHEAD_TOKENS = 2e4
      const estimatedTokens = rawEstimatedTokens + SYSTEM_PROMPT_OVERHEAD_TOKENS
      const inputCost = costFn(model, estimatedTokens)
      if (inputCost > maxCost) {
        logger.info(ctx, "Prompt suggestion skipped: model too expensive", { model, rawEstimatedTokens, estimatedTokens, inputCost, maxCost })
        promptSuggestionOutcome.increment(ctx, 1, { model, outcome: "skipped_expensive" })
        return
      }
    }
    // A snapshot replaces what the executor holds, so the suggestion sees the conversation as it is now.
    if (messagesSnapshot) {
      executor.clearMessages()
      executor.appendMessages(messagesSnapshot)
    }
    const isLargeContext = isLargeContextModel(model)
    const userMessage = {
      role: "user",
      content: promptSuggestionUserMessage(isLargeContext),
      providerOptions: {
        cursor: {
          inferenceReason: "prompt-suggestion",
          featureType: "promptSuggestion",
        },
      },
    }
    executor.appendMessages(toRedactedCoreMessages([userMessage], PrivacyMode.UNSPECIFIED))
    try {
      // A suggestion is a sentence or two, and the model that reads more context is allowed more of them.
      const maxTokens = isLargeContext ? 128 : 64
      const streamResult = executor.stream(ctx, invocationId, tools, { maxTokens })
      // The response promise is settled alongside the stream so a failure is not lost if the stream ends first.
      const settledResponse = streamResult.response.then(() => ({ didReject: false as const }), error => ({ didReject: true as const, error }))
      let responseText = ""
      for await (const chunk of streamResult.fullStream) {
        if (chunk.type === "text-delta") {
          responseText += chunk.textDelta ?? ""
        }
      }
      const responseResult = await settledResponse
      if (responseResult.didReject) {
        throw responseResult.error
      }
      const extendedUsage = await streamResult.extendedUsage
      const cacheHitRatio = extendedUsage.inputTokens > 0 ? (extendedUsage.cacheReadTokens / extendedUsage.inputTokens).toFixed(2) : "N/A"
      logger.info(ctx, "Prompt suggestion completed", { inputTokens: extendedUsage.inputTokens, cacheReadTokens: extendedUsage.cacheReadTokens, cacheHitRatio })
      const extractionResult = extractSuggestionWithReason(responseText)
      switch (extractionResult.type) {
        case "success":
          promptSuggestionOutcome.increment(ctx, 1, { model, outcome: "suggested" })
          await interactionListener.sendUpdate(ctx, Updates.promptSuggestion(extractionResult.suggestion))
          break
        case "too_long":
          logger.info(ctx, "Prompt suggestion discarded: too long", { wordCount: extractionResult.wordCount, maxWords: PROMPT_SUGGESTION_MAX_WORDS, suggestion: extractionResult.suggestion })
          promptSuggestionOutcome.increment(ctx, 1, { model, outcome: "too_long" })
          break
        case "bad_output":
          logger.info(ctx, "Prompt suggestion discarded: bad output", { reason: extractionResult.reason, suggestion: extractionResult.suggestion })
          promptSuggestionOutcome.increment(ctx, 1, { model, outcome: "bad_output" })
          break
        case "empty":
          promptSuggestionOutcome.increment(ctx, 1, { model, outcome: "no_suggestion" })
          break
      }
    } catch (error) {
      promptSuggestionOutcome.increment(ctx, 1, { model, outcome: "error" })
      logger.error(ctx, "Error during prompt suggestion request", error)
    } finally {
      // Whatever happened, the executor holds the conversation it held before.
      executor.clearMessages()
      executor.appendMessages(currentMessages)
    }
  } catch {}
}
