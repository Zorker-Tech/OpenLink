/**
 * Compacting a conversation the way the provider's compaction is asked for.
 *
 * The provider has two ways of being asked, and they are not the same request. The beta path is what the
 * provider recognizes on its own: the conversation is sent as it stands and one line tells it to continue,
 * and the provider is expected to write the checkpoint. The explicit path is the same exchange asked in
 * words: the instructions — the platform's own, or the ones a caller supplied — are the last message, and
 * the answer is the summary.
 *
 * The beta path has a floor. The provider's own compaction is only worth asking for on a conversation that
 * is already large, so a small one is refused with the estimate rather than sent, since a refusal the caller
 * can read is better than a request that quietly does nothing.
 *
 * What the model writes back is not the summary alone: it reasons first, and it may wrap the answer in its
 * own tags. So the analysis around the answer is taken off — the leading one and a trailing one that
 * contains no summary — and what is kept is the summary body, falling back to the whole answer when the
 * model did not tag anything.
 */

import {
  appendDurableBlocks,
  prependDurableBlocks,
  renderDurableBlocks,
  type DurableBlockEnrichments,
} from "../../agent-summarization/durable-blocks.ts"
import { getRetryDirective } from "../../agent-summarization/error-handling.ts"
import {
  runSummarizationPipeline,
  type SummarizationEnrichments,
  type SummarizationPipelineOptions,
} from "../../agent-summarization/pipeline.ts"
import { prepareMessagesForCompaction } from "../../agent-summarization/prepare-messages.ts"
import { collectAllSkillBlocks } from "../../agent-summarization/skill-persistence.ts"
import { SUMMARIZATION_CURSOR_PROVIDER_OPTIONS } from "../../agent-summarization/summarization-handler.ts"
import type { Context } from "../../context/context.ts"
import { createLogger, createSpan } from "../../context/index.ts"
import { createCounter, createHistogram } from "../../metrics/index.ts"
import { DataClassification, PrivacyCapability } from "../../redaction/classification.ts"
import { fromRedactedCoreMessage, toRedactedCoreMessage } from "../../redaction/message-redaction.ts"
import { createRedactedString, safeString } from "../../redaction/create.ts"
import { TAGGED_COMPACTION_INSTRUCTIONS } from "./constants.ts"
import {
  executeSelfSummaryWithRetry,
  type SelfSummaryPromptSession,
  type SelfSummaryRetryOptions,
  type SelfSummaryStateHandler,
  type SelfSummaryTool,
} from "./self-summary-handler.ts"
import { extractTextContent } from "./token-estimate.ts"

type RedactedCoreMessage = Parameters<typeof fromRedactedCoreMessage>[0]
type RedactedInteractionListener = Parameters<typeof executeSelfSummaryWithRetry>[3]

interface AnthropicPartition {
  readonly systemMessage: RedactedCoreMessage | undefined
  readonly userInfoMessage: RedactedCoreMessage | undefined
  readonly messagesToSummarize: readonly RedactedCoreMessage[]
  readonly preservedTailMessages: readonly RedactedCoreMessage[]
  readonly skillBlocks: readonly string[]
}

interface AnthropicRawSummary {
  readonly text: string
  readonly inputTokens: number
  readonly outputTokens: number
}

export interface AnthropicCompactionOptions extends SelfSummaryRetryOptions {
  readonly explicit?: boolean | undefined
  readonly anthropicCompactionInstructions?: string | undefined
}

const logger = createLogger("@slate/agent")
const MIN_ANTHROPIC_COMPACTION_INPUT_TOKENS = 50_000
const APPROX_CHARS_PER_TOKEN = 4
const compactionInputTokens = createHistogram("anthropic_compaction.input_token", {
  description: "Input tokens consumed during Anthropic compaction",
  labelNames: ["mode"],
})
const compactionOutputTokens = createHistogram("anthropic_compaction.output_token", {
  description: "Output tokens generated during Anthropic compaction",
  labelNames: ["mode"],
})
const compactionCacheReadTokens = createHistogram("anthropic_compaction.cache_read_token", {
  description: "Cache read tokens during Anthropic compaction",
  labelNames: ["mode"],
})
const compactionCacheWriteTokens = createHistogram("anthropic_compaction.cache_write_token", {
  description: "Cache write tokens during Anthropic compaction",
  labelNames: ["mode"],
})
const compactionTimeTakenMs = createHistogram("anthropic_compaction.time_taken_ms", {
  description: "Time taken for Anthropic compaction in milliseconds",
  labelNames: ["mode"],
})
const compactionStatus = createCounter("anthropic_compaction.status", {
  description: "Count of Anthropic compaction attempts and their outcomes",
  labelNames: ["outcome", "errorKind", "mode"],
})

export class AnthropicCompactionHandler {
  declare readonly promptSession: SelfSummaryPromptSession
  declare readonly stateHandler: SelfSummaryStateHandler
  declare readonly interactionListener: RedactedInteractionListener
  declare readonly tools: SelfSummaryTool[]
  declare readonly extraT: unknown
  declare readonly modelId: string
  declare readonly compactionMode: "explicit" | "beta"
  declare readonly anthropicCompactionInstructions: string | undefined
  declare readonly retryOptions: SelfSummaryRetryOptions

  constructor(
    promptSession: SelfSummaryPromptSession,
    stateHandler: SelfSummaryStateHandler,
    interactionListener: RedactedInteractionListener,
    tools: SelfSummaryTool[],
    extraT: unknown,
    modelId: string,
    options?: AnthropicCompactionOptions,
  ) {
    this.promptSession = promptSession
    this.stateHandler = stateHandler
    this.interactionListener = interactionListener
    this.tools = tools
    this.extraT = extraT
    this.modelId = modelId
    // The mode and the instructions are this handler's own options; everything else is a retry option.
    const { explicit, anthropicCompactionInstructions, ...retry } = options ?? {}
    this.compactionMode = explicit === true ? "explicit" : "beta"
    this.anthropicCompactionInstructions = anthropicCompactionInstructions
    this.retryOptions = retry
  }

  getModelId(): string { return this.modelId }
  getMetricsModelLabel(): string { return this.modelId }

  /** Nothing is kept back: this compaction is asked for when the whole conversation must be replaced. */
  partitionMessages(messages: readonly RedactedCoreMessage[], _options: SummarizationPipelineOptions): AnthropicPartition {
    const { systemMessage, userInfoMessage, messagesForSummarization } = prepareMessagesForCompaction(messages)
    const skillBlocks = collectAllSkillBlocks(messagesForSummarization)
    return {
      systemMessage,
      userInfoMessage,
      messagesToSummarize: messagesForSummarization,
      preservedTailMessages: [],
      skillBlocks,
    }
  }

  async generateSummary(
    ctx: Context,
    partitioned: AnthropicPartition,
    _options: SummarizationPipelineOptions,
  ): Promise<AnthropicRawSummary> {
    // The provider's own compaction is only asked for on a conversation that is already large.
    if (this.compactionMode === "beta") {
      assertAnthropicCompactionInputTokens(partitioned.messagesToSummarize)
    }
    if (!partitioned.systemMessage) throw new Error("Expected system message in conversation")
    const privacySource = partitioned.preservedTailMessages[0] ?? partitioned.userInfoMessage ?? partitioned.systemMessage
    // The beta path asks in the provider's own words; the explicit path asks in ours, or the caller's.
    const finalUserContent = this.compactionMode === "explicit"
      ? this.anthropicCompactionInstructions ?? TAGGED_COMPACTION_INSTRUCTIONS
      : "Continue from where you left off."
    logger.info(
      ctx,
      this.compactionMode === "explicit"
        ? "[anthropic-compaction] generating summary via explicit user prompt"
        : "[anthropic-compaction] generating summary via compact beta",
      { mode: this.compactionMode },
    )
    const compactInputMessages: RedactedCoreMessage[] = [
      partitioned.systemMessage,
      ...(partitioned.userInfoMessage ? [partitioned.userInfoMessage] : []),
      ...partitioned.messagesToSummarize,
      {
        _privacyMode: privacySource._privacyMode,
        role: "user",
        content: safeString(finalUserContent),
        providerOptions: SUMMARIZATION_CURSOR_PROVIDER_OPTIONS,
      },
    ]
    const unredact = (message: RedactedCoreMessage) =>
      fromRedactedCoreMessage(message, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED)
    const { assistantMessage, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } =
      await executeSelfSummaryWithRetry(
        ctx,
        this.promptSession,
        this.stateHandler,
        this.interactionListener,
        compactInputMessages.map(unredact),
        this.tools,
        this.extraT,
        {
          preservedPrefixMessageCount: 1 + (partitioned.userInfoMessage !== undefined ? 1 : 0),
          ...this.retryOptions,
        },
      )
    const modeLabels = { mode: this.compactionMode }
    compactionInputTokens.histogram(ctx, inputTokens, modeLabels)
    compactionOutputTokens.histogram(ctx, outputTokens, modeLabels)
    compactionCacheReadTokens.histogram(ctx, cacheReadTokens!, modeLabels)
    compactionCacheWriteTokens.histogram(ctx, cacheWriteTokens!, modeLabels)
    const summaryText = extractTextContent(
      toRedactedCoreMessage(assistantMessage, this.stateHandler.getPrivacyMode()),
    ).unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED)
    let candidate = summaryText.trim()
    // A leading analysis block is reasoning, not the summary, so it is taken off.
    if (candidate.startsWith("<analysis>")) {
      const leadingAnalysisClose = candidate.indexOf("</analysis>")
      if (leadingAnalysisClose !== -1) {
        candidate = candidate.slice(leadingAnalysisClose + "</analysis>".length)
      }
    }
    // A trailing analysis block with no summary inside it is the same reasoning at the end.
    if (candidate.trimEnd().endsWith("</analysis>")) {
      const trailingAnalysisOpen = candidate.lastIndexOf("<analysis>")
      if (
        trailingAnalysisOpen !== -1 &&
        candidate.lastIndexOf("</summary>", trailingAnalysisOpen) !== -1
      ) {
        candidate = candidate.slice(0, trailingAnalysisOpen)
      }
    }
    // What is kept is the tagged summary when the model tagged one, and the whole answer otherwise.
    const openTagIndex = candidate.indexOf("<summary>")
    const closeTagIndex = candidate.lastIndexOf("</summary>")
    const extractedSummaryBody = openTagIndex !== -1 && closeTagIndex > openTagIndex
      ? candidate.slice(openTagIndex + "<summary>".length, closeTagIndex).trim()
      : candidate.trim() || summaryText
    return { text: extractedSummaryBody, inputTokens, outputTokens }
  }

  buildSummaryMessage(
    rawSummary: AnthropicRawSummary,
    partitioned: AnthropicPartition,
    enrichments: SummarizationEnrichments,
  ): { message: RedactedCoreMessage; summaryTextLength: number } {
    const durableBlocks = renderDurableBlocks(
      "anthropic-compaction",
      enrichments as DurableBlockEnrichments,
    )
    // The summary goes back in the tag the provider's compaction reads, with the blocks around it.
    const wrappedContent = `${prependDurableBlocks("anthropic-compaction", durableBlocks)}

<summary>
${rawSummary.text}
</summary>${appendDurableBlocks("anthropic-compaction", durableBlocks)}`
    const lastUserQuery = partitioned.preservedTailMessages[0]
    const privacySource = lastUserQuery ?? partitioned.userInfoMessage ?? partitioned.systemMessage
    const summaryPrivacyMode = privacySource!._privacyMode ?? this.stateHandler.getPrivacyMode()
    return {
      message: toRedactedCoreMessage({
        role: "user",
        content: wrappedContent,
        providerOptions: { cursor: { isSummary: true } },
      }, summaryPrivacyMode),
      summaryTextLength: wrappedContent.length,
    }
  }

  assembleFinalMessages(
    partitioned: AnthropicPartition,
    summaryMessage: RedactedCoreMessage,
  ): readonly RedactedCoreMessage[] {
    if (!partitioned.systemMessage) throw new Error("Expected system message in conversation")
    return [
      partitioned.systemMessage,
      ...(partitioned.userInfoMessage ? [partitioned.userInfoMessage] : []),
      summaryMessage,
    ]
  }

  async summarize(
    ctx: Context,
    messages: readonly RedactedCoreMessage[],
    options: SummarizationPipelineOptions,
  ): Promise<Record<string, unknown>> {
    using spanContext = createSpan(ctx.withName("AnthropicCompactionHandler.summarize"))
    const innerCtx = spanContext.ctx
    const startTime = performance.now()
    logger.info(innerCtx, "[anthropic-compaction] summarize starting", {
      messageCount: messages.length,
      modelId: this.modelId,
      mode: this.compactionMode,
    })
    try {
      const pipelineResult = await runSummarizationPipeline(this, innerCtx, messages, options)
      const summaryCodeString = createRedactedString(
        pipelineResult.rawSummary.text,
        DataClassification.CODE,
        "compaction-summary",
        this.stateHandler.getPrivacyMode(),
      )
      logger.info(innerCtx, "[anthropic-compaction] summarize completed", {
        summaryTextLength: pipelineResult.rawSummary.text.length,
        fullReplacementMessagesCount: pipelineResult.fullReplacementMessages.length,
        messagesActuallySummarizedCount: pipelineResult.messagesActuallySummarized.length,
      })
      compactionStatus.increment(innerCtx, 1, {
        outcome: "success",
        errorKind: "Ok",
        mode: this.compactionMode,
      })
      return {
        ...pipelineResult,
        summary: { summary: summaryCodeString },
        onPersisted: () => { this.stateHandler.incrementSelfSummaryCount() },
      }
    } catch (error) {
      const errorKind = getRetryDirective(error, { transientRetryDelayMs: 0 }).errorType
      compactionStatus.increment(innerCtx, 1, {
        outcome: "failed",
        errorKind,
        mode: this.compactionMode,
      })
      throw error
    } finally {
      compactionTimeTakenMs.histogram(innerCtx, performance.now() - startTime, {
        mode: this.compactionMode,
      })
    }
  }
}

/** The floor is measured the same way the prompt's own budget is: from the text, roughly. */
function estimateAnthropicCompactionTokens(messages: readonly RedactedCoreMessage[]): number {
  const serializedMessages = messages.map(
    message => `${message.role}: ${anthropicCompactionMessageToString(message)}`,
  )
  return Math.round(serializedMessages.join("\n\n").length / APPROX_CHARS_PER_TOKEN)
}

function anthropicCompactionMessageToString(message: RedactedCoreMessage): string {
  const unredactedMessage = fromRedactedCoreMessage(
    message,
    PrivacyCapability.UNSAFE_ALWAYS_ALLOWED,
  )
  const content = unredactedMessage.content
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content.map(part => {
    const typedPart = part as Record<string, unknown>
    if (typedPart.type === "text") return typedPart.text as string
    if (typedPart.type === "reasoning") return typedPart.text as string
    if (typedPart.type === "tool-call") {
      return `[Tool call] ${typedPart.toolName as string} ${JSON.stringify(typedPart.args) ?? "null"}`
    }
    if (typedPart.type === "tool-result") {
      return `[Tool result] ${typedPart.toolName as string} ${JSON.stringify(typedPart.result) ?? "null"}`
    }
    if (typedPart.type === "image") return "[Image]"
    if (typedPart.type === "file") return "[File]"
    return ""
  }).join("\n\n")
}

function assertAnthropicCompactionInputTokens(messages: readonly RedactedCoreMessage[]): void {
  const estimatedTokens = estimateAnthropicCompactionTokens(messages)
  if (estimatedTokens < MIN_ANTHROPIC_COMPACTION_INPUT_TOKENS) {
    throw new Error(
      `Refusing anthropic compaction for fewer than ${MIN_ANTHROPIC_COMPACTION_INPUT_TOKENS} tokens; estimated ${estimatedTokens} tokens in messagesToSummarize.`,
    )
  }
}
