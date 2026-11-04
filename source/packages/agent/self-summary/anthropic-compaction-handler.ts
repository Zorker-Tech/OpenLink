/**
 * Compacting a conversation the way this provider's own compaction is asked for.
 *
 * The provider offers two ways to be asked, and they are not the same request. The beta path is the one the
 * provider recognizes by itself: the conversation is sent as it stands with one line telling the model to
 * continue, and the provider is expected to write the checkpoint. The explicit path asks the same exchange in
 * words — the instructions this platform ships, or the ones the caller supplied — and takes the answer as the
 * summary.
 *
 * The beta path has a floor: the provider's own compaction is only worth asking for on a conversation that is
 * already large, so a small one is refused with the estimate rather than sent. A refusal the caller can read is
 * better than a request that quietly does nothing.
 *
 * What the model writes back is not the summary alone — it reasons first, and it may wrap the answer in its own
 * tags — so the reasoning around it is taken off, and what is kept is the tagged summary, or the whole answer
 * when the model tagged nothing.
 */

import {
  appendDurableBlocks,
  prependDurableBlocks,
  renderDurableBlocks,
  type DurableBlockEnrichments,
} from "../../agent-summarization/durable-blocks.ts"
import { getRetryDirective } from "../../agent-summarization/error-handling.ts"
import {
  runSummaryPass,
  type SummaryCarryData,
  type SummaryRunOptions,
} from "../../agent-summarization/pipeline.ts"
import { prepareMessagesForCompaction } from "../../agent-summarization/prepare-messages.ts"
import { collectAttachedSkillBlocksFromConversation } from "../../../adapters/interop/agent/compaction-skill-message-adapter.ts"
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
type CompactionMode = "explicit" | "beta"

/** The conversation split the way compaction needs it: framing, the user's profile, what is summarized, what stays. */
interface CompactionPartition {
  readonly systemMessage: RedactedCoreMessage | undefined
  readonly userInfoMessage: RedactedCoreMessage | undefined
  readonly messagesToSummarize: readonly RedactedCoreMessage[]
  readonly preservedTailMessages: readonly RedactedCoreMessage[]
  readonly skillBlocks: readonly string[]
}

/** What the model answered, and what the exchange cost. */
interface CompactionSummary {
  readonly text: string
  readonly inputTokens: number
  readonly outputTokens: number
}

/** What a caller may tell the handler beyond the conversation itself. */
export interface AnthropicCompactionOptions extends SelfSummaryRetryOptions {
  readonly explicit?: boolean | undefined
  readonly anthropicCompactionInstructions?: string | undefined
}

const logger = createLogger("@slate/agent")

/** The provider's own compaction is only worth asking for above this many estimated input tokens. */
const MIN_COMPACTION_INPUT_TOKENS = 50_000
/** The platform's rough characters-per-token figure, used only for the floor estimate. */
const CHARS_PER_TOKEN = 4

/** The tags the model writes, which the summary is read out of and the reasoning is taken from. */
const ANALYSIS_TAG = "<analysis>"
const ANALYSIS_CLOSE_TAG = "</analysis>"
const SUMMARY_TAG = "<summary>"
const SUMMARY_CLOSE_TAG = "</summary>"
/** The durable-block namespace and the provider name this compaction reports under. */
const COMPACTION_NAMESPACE = "anthropic-compaction"

/** How this compaction reports itself: what it cost, how long it took and how it ended. */
const compactionMetrics = {
  inputTokens: createHistogram("anthropic_compaction.input_token", {
    description: "Input tokens consumed during Anthropic compaction",
    labelNames: ["mode"],
  }),
  outputTokens: createHistogram("anthropic_compaction.output_token", {
    description: "Output tokens generated during Anthropic compaction",
    labelNames: ["mode"],
  }),
  cacheReadTokens: createHistogram("anthropic_compaction.cache_read_token", {
    description: "Cache read tokens during Anthropic compaction",
    labelNames: ["mode"],
  }),
  cacheWriteTokens: createHistogram("anthropic_compaction.cache_write_token", {
    description: "Cache write tokens during Anthropic compaction",
    labelNames: ["mode"],
  }),
  timeTakenMs: createHistogram("anthropic_compaction.time_taken_ms", {
    description: "Time taken for Anthropic compaction in milliseconds",
    labelNames: ["mode"],
  }),
  status: createCounter("anthropic_compaction.status", {
    description: "Count of Anthropic compaction attempts and their outcomes",
    labelNames: ["outcome", "errorKind", "mode"],
  }),
} as const

/** The system message a compaction cannot run without, or the refusal that says so. */
function requireSystemMessage(partitioned: CompactionPartition): RedactedCoreMessage {
  if (partitioned.systemMessage === undefined) throw new Error("Expected system message in conversation")
  return partitioned.systemMessage
}

/** The framing a compacted conversation begins with: the system message and, when it exists, the user's profile. */
function conversationPreface(systemMessage: RedactedCoreMessage, userInfoMessage: RedactedCoreMessage | undefined): RedactedCoreMessage[] {
  return [systemMessage, ...(userInfoMessage ? [userInfoMessage] : [])]
}

/** The line that tells a beta compaction to continue, or the instructions an explicit one asks in words. */
function finalCompactionPrompt(mode: CompactionMode, instructions: string | undefined): string {
  if (mode === "explicit") return instructions ?? TAGGED_COMPACTION_INSTRUCTIONS
  return "Continue from where you left off."
}

/** The log line that says which way the compaction was asked for. */
function summaryRequestLogLine(mode: CompactionMode): string {
  return mode === "explicit"
    ? "[anthropic-compaction] generating summary via explicit user prompt"
    : "[anthropic-compaction] generating summary via compact beta"
}

/** The messages a compaction request is made of: framing, the conversation, and one last user turn that asks. */
function compactionRequestMessages(
  partitioned: CompactionPartition,
  systemMessage: RedactedCoreMessage,
  finalPrompt: string,
  privacySource: RedactedCoreMessage,
): RedactedCoreMessage[] {
  return [
    ...conversationPreface(systemMessage, partitioned.userInfoMessage),
    ...partitioned.messagesToSummarize,
    {
      _privacyMode: privacySource._privacyMode,
      role: "user",
      content: safeString(finalPrompt),
      providerOptions: SUMMARIZATION_CURSOR_PROVIDER_OPTIONS,
    },
  ]
}

/** A leading analysis block is reasoning rather than summary, so it is taken off before the answer is read. */
function withoutLeadingAnalysis(text: string): string {
  if (!text.startsWith(ANALYSIS_TAG)) return text
  const analysisEnd = text.indexOf(ANALYSIS_CLOSE_TAG)
  return analysisEnd === -1 ? text : text.slice(analysisEnd + ANALYSIS_CLOSE_TAG.length)
}

/** A trailing analysis block with no summary inside it is the same reasoning at the other end. */
function withoutTrailingAnalysis(text: string): string {
  if (!text.trimEnd().endsWith(ANALYSIS_CLOSE_TAG)) return text
  const analysisStart = text.lastIndexOf(ANALYSIS_TAG)
  if (analysisStart === -1) return text
  if (text.lastIndexOf(SUMMARY_CLOSE_TAG, analysisStart) === -1) return text
  return text.slice(0, analysisStart)
}

/** The summary body the model wrote: the tagged summary when it tagged one, and the whole answer otherwise. */
function summaryBodyFromAnswer(answer: string): string {
  const candidate = withoutTrailingAnalysis(withoutLeadingAnalysis(answer.trim()))
  const summaryStart = candidate.indexOf(SUMMARY_TAG)
  const summaryEnd = candidate.lastIndexOf(SUMMARY_CLOSE_TAG)
  if (summaryStart !== -1 && summaryEnd > summaryStart) {
    return candidate.slice(summaryStart + SUMMARY_TAG.length, summaryEnd).trim()
  }
  return candidate.trim() || answer
}

/** The text a compacted conversation is continued from: the summary in its tag, with durable blocks around it. */
function summaryEnvelope(summary: string, durableBlocks: ReturnType<typeof renderDurableBlocks>): string {
  return `${prependDurableBlocks(COMPACTION_NAMESPACE, durableBlocks)}

<summary>
${summary}
</summary>${appendDurableBlocks(COMPACTION_NAMESPACE, durableBlocks)}`
}

/** Report what one compaction exchange cost, in the labels the metrics keep. */
function recordCompactionUsage(
  ctx: Context,
  mode: CompactionMode,
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number | undefined; cacheWriteTokens: number | undefined },
): void {
  const labels = { mode }
  compactionMetrics.inputTokens.histogram(ctx, usage.inputTokens, labels)
  compactionMetrics.outputTokens.histogram(ctx, usage.outputTokens, labels)
  compactionMetrics.cacheReadTokens.histogram(ctx, usage.cacheReadTokens!, labels)
  compactionMetrics.cacheWriteTokens.histogram(ctx, usage.cacheWriteTokens!, labels)
}

/** One renderer per content part the estimate knows: the words it read, its thinking, and the calls it made. */
const CONTENT_PART_RENDERERS: ReadonlyMap<string, (part: Record<string, unknown>) => string> = new Map([
  ["text", (part: Record<string, unknown>) => part.text as string],
  ["reasoning", (part: Record<string, unknown>) => part.text as string],
  ["tool-call", (part: Record<string, unknown>) => `[Tool call] ${part.toolName as string} ${JSON.stringify(part.args) ?? "null"}`],
  ["tool-result", (part: Record<string, unknown>) => `[Tool result] ${part.toolName as string} ${JSON.stringify(part.result) ?? "null"}`],
  ["image", () => "[Image]"],
  ["file", () => "[File]"],
])

/** What one content part of a message is worth reading for the estimate. */
function renderContentPart(part: unknown): string {
  const typedPart = part as Record<string, unknown>
  const renderer = typeof typedPart.type === "string" ? CONTENT_PART_RENDERERS.get(typedPart.type) : undefined
  return renderer === undefined ? "" : renderer(typedPart)
}

/** One message as the estimate reads it: who said it, and what of it counts. */
function renderMessageForEstimate(message: RedactedCoreMessage): string {
  const content = fromRedactedCoreMessage(message, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED).content
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content.map(renderContentPart).join("\n\n")
}

/** How large a conversation is, roughly, for the beta floor. */
function estimateCompactionTokens(messages: readonly RedactedCoreMessage[]): number {
  const renderedMessages = messages.map(message => `${message.role}: ${renderMessageForEstimate(message)}`)
  return Math.round(renderedMessages.join("\n\n").length / CHARS_PER_TOKEN)
}

/** Refuse the provider's own compaction on a conversation too small to be worth it, naming the estimate. */
function assertCompactionFloor(messages: readonly RedactedCoreMessage[]): void {
  const estimatedTokens = estimateCompactionTokens(messages)
  if (estimatedTokens >= MIN_COMPACTION_INPUT_TOKENS) return
  throw new Error(
    `Refusing anthropic compaction for fewer than ${MIN_COMPACTION_INPUT_TOKENS} tokens; estimated ${estimatedTokens} tokens in messagesToSummarize.`,
  )
}

/** The provider's compaction, run against one conversation at a time. */
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
    // These two options are this handler's own; everything else belongs to the retry the exchange runs with.
    const { explicit, anthropicCompactionInstructions, ...retryOptions } = options ?? {}
    this.promptSession = promptSession
    this.stateHandler = stateHandler
    this.interactionListener = interactionListener
    this.tools = tools
    this.extraT = extraT
    this.modelId = modelId
    this.compactionMode = explicit === true ? "explicit" : "beta"
    this.anthropicCompactionInstructions = anthropicCompactionInstructions
    this.retryOptions = retryOptions
  }

  getModelId(): string { return this.modelId }
  getMetricsModelLabel(): string { return this.modelId }

  /** Nothing is kept back: this compaction replaces the whole conversation. */
  separateMessages(messages: readonly RedactedCoreMessage[], _options: SummaryRunOptions): CompactionPartition {
    const { systemMessage, userInfoMessage, messagesForSummarization } = prepareMessagesForCompaction(messages)
    return {
      systemMessage,
      userInfoMessage,
      messagesToSummarize: messagesForSummarization,
      preservedTailMessages: [],
      skillBlocks: collectAttachedSkillBlocksFromConversation(messagesForSummarization),
    }
  }

  /** Ask the model for the summary: the provider's own request on beta, the instructions on explicit. */
  async generateSummary(ctx: Context, partitioned: CompactionPartition, _options: SummaryRunOptions): Promise<CompactionSummary> {
    if (this.compactionMode === "beta") assertCompactionFloor(partitioned.messagesToSummarize)
    const systemMessage = requireSystemMessage(partitioned)
    const privacySource = partitioned.preservedTailMessages[0] ?? partitioned.userInfoMessage ?? systemMessage
    const finalPrompt = finalCompactionPrompt(this.compactionMode, this.anthropicCompactionInstructions)
    logger.info(ctx, summaryRequestLogLine(this.compactionMode), { mode: this.compactionMode })
    const requestMessages = compactionRequestMessages(partitioned, systemMessage, finalPrompt, privacySource)
    const exchange = await executeSelfSummaryWithRetry(
      ctx,
      this.promptSession,
      this.stateHandler,
      this.interactionListener,
      requestMessages.map(message => fromRedactedCoreMessage(message, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED)),
      this.tools,
      this.extraT,
      {
        preservedPrefixMessageCount: 1 + (partitioned.userInfoMessage !== undefined ? 1 : 0),
        ...this.retryOptions,
      },
    )
    recordCompactionUsage(ctx, this.compactionMode, exchange)
    const answer = extractTextContent(
      toRedactedCoreMessage(exchange.assistantMessage, this.stateHandler.getPrivacyMode()),
    ).unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED)
    return { text: summaryBodyFromAnswer(answer), inputTokens: exchange.inputTokens, outputTokens: exchange.outputTokens }
  }

  /** Write the summary back in the shape the next turn reads it in. */
  formatSummaryCarrier(
    rawSummary: CompactionSummary,
    partitioned: CompactionPartition,
    enrichments: SummaryCarryData,
  ): { message: RedactedCoreMessage; summaryTextLength: number } {
    const durableBlocks = renderDurableBlocks(COMPACTION_NAMESPACE, enrichments as DurableBlockEnrichments)
    const wrappedContent = summaryEnvelope(rawSummary.text, durableBlocks)
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

  /** The conversation the next turn continues from: its framing, then the summary. */
  rebuildConversation(partitioned: CompactionPartition, summaryMessage: RedactedCoreMessage): readonly RedactedCoreMessage[] {
    const systemMessage = requireSystemMessage(partitioned)
    return [...conversationPreface(systemMessage, partitioned.userInfoMessage), summaryMessage]
  }

  /** Run the whole compaction, reporting how it ended and how long it took. */
  async summarize(ctx: Context, messages: readonly RedactedCoreMessage[], options: SummaryRunOptions): Promise<Record<string, unknown>> {
    using spanContext = createSpan(ctx.withName("AnthropicCompactionHandler.summarize"))
    const scopedCtx = spanContext.ctx
    const startedAt = performance.now()
    logger.info(scopedCtx, "[anthropic-compaction] summarize starting", {
      messageCount: messages.length,
      modelId: this.modelId,
      mode: this.compactionMode,
    })
    try {
      const pipelineResult = await runSummaryPass(this, scopedCtx, messages, options)
      // The summary is redacted before the completion is reported, because the report describes its length.
      const summaryCodeString = createRedactedString(
        pipelineResult.rawSummary.text,
        DataClassification.CODE,
        "compaction-summary",
        this.stateHandler.getPrivacyMode(),
      )
      logger.info(scopedCtx, "[anthropic-compaction] summarize completed", {
        summaryTextLength: pipelineResult.rawSummary.text.length,
        fullReplacementMessagesCount: pipelineResult.fullReplacementMessages.length,
        messagesActuallySummarizedCount: pipelineResult.messagesActuallySummarized.length,
      })
      compactionMetrics.status.increment(scopedCtx, 1, {
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
      compactionMetrics.status.increment(scopedCtx, 1, {
        outcome: "failed",
        errorKind: getRetryDirective(error, { transientRetryDelayMs: 0 }).errorType,
        mode: this.compactionMode,
      })
      throw error
    } finally {
      compactionMetrics.timeTakenMs.histogram(scopedCtx, performance.now() - startedAt, {
        mode: this.compactionMode,
      })
    }
  }
}
