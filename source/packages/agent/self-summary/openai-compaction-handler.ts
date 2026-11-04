/**
 * Compacting a conversation the way the provider's own compaction expects.
 *
 * A provider that offers context compaction has its own idea of what a checkpoint looks like, and this is
 * the shape it asks for: a handoff summary written by the same model, wrapped in a prefix that tells the
 * next model that the workspace already reflects someone else's work — so it inspects the state rather than
 * trusting the summary, and builds on what was done instead of repeating it.
 *
 * What survives compaction here is chosen rather than cut. The user's own messages are kept, but only the
 * part of each that was the actual request, and only as many of the most recent ones as a token budget
 * allows — because the user's words are what the next model is answering, and the platform's framing around
 * them is not. That budget is counted from the messages' own text, with the same rough characters-per-token
 * figure the rest of the platform uses.
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
import { isRedactedString } from "../../redaction/redacted-values.ts"
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

interface OpenAIPartition {
  readonly systemMessage: RedactedCoreMessage | undefined
  readonly userInfoMessage: RedactedCoreMessage | undefined
  readonly messagesToSummarize: readonly RedactedCoreMessage[]
  readonly preservedTailMessages: readonly RedactedCoreMessage[]
  readonly skillBlocks: readonly string[]
}

interface OpenAIRawSummary {
  readonly text: string
  readonly inputTokens: number
  readonly outputTokens: number
}

const logger = createLogger("@slate/agent")
const compactionInputTokens = createHistogram("openai_compaction.input_token", {
  description: "Input tokens consumed during OpenAI compaction",
})
const compactionOutputTokens = createHistogram("openai_compaction.output_token", {
  description: "Output tokens generated during OpenAI compaction",
})
const compactionCacheReadTokens = createHistogram("openai_compaction.cache_read_token", {
  description: "Cache read tokens during OpenAI compaction",
})
const compactionCacheWriteTokens = createHistogram("openai_compaction.cache_write_token", {
  description: "Cache write tokens during OpenAI compaction",
})
const compactionTimeTakenMs = createHistogram("openai_compaction.time_taken_ms", {
  description: "Time taken for OpenAI compaction in milliseconds",
})
const compactionStatus = createCounter("openai_compaction.status", {
  description: "Count of OpenAI compaction attempts and their outcomes",
  labelNames: ["outcome", "errorKind"],
})
const OPENAI_COMPACTION_PROMPT = `You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue

Be concise, structured, and focused on helping the next LLM seamlessly continue the work.
Do not make any tool calls.`
const SUMMARY_PREFIX = "Another language model started to solve this problem and produced a summary of its thinking process. The workspace and transcript reflects changes made by the previous model — use your tools to inspect the current state of files, terminals, and other resources. Build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:"
const APPROX_CHARS_PER_TOKEN = 4
const COMPACT_USER_MESSAGE_MAX_TOKENS = 10_000

export class OpenAICompactionHandler {
  declare readonly promptSession: SelfSummaryPromptSession
  declare readonly stateHandler: SelfSummaryStateHandler
  declare readonly interactionListener: RedactedInteractionListener
  declare readonly tools: SelfSummaryTool[]
  declare readonly extraT: unknown
  declare readonly modelId: string
  declare readonly retryOptions: SelfSummaryRetryOptions

  constructor(
    session: SelfSummaryPromptSession,
    state: SelfSummaryStateHandler,
    listener: RedactedInteractionListener,
    toolset: SelfSummaryTool[],
    extraTranslation: unknown,
    modelName: string,
    retrySettings?: SelfSummaryRetryOptions,
  ) {
    this.promptSession = session
    this.stateHandler = state
    this.interactionListener = listener
    this.tools = toolset
    this.extraT = extraTranslation
    this.modelId = modelName
    this.retryOptions = retrySettings ?? {}
  }

  getModelId(): string { return this.modelId }
  getMetricsModelLabel(): string { return this.modelId }

  /** Everything is summarized; what is kept is the user's own most recent requests, within a budget. */
  separateMessages(conversationMessages: readonly RedactedCoreMessage[], _pipelineOptions: SummaryRunOptions): OpenAIPartition {
    const { systemMessage, userInfoMessage, messagesForSummarization } = prepareMessagesForCompaction(conversationMessages)
    const skillBlocks = collectAttachedSkillBlocksFromConversation(messagesForSummarization)
    const preservedTailMessages = recentRequestsWithinBudget(
      messagesForSummarization,
      COMPACT_USER_MESSAGE_MAX_TOKENS,
    )
    return {
      systemMessage,
      userInfoMessage,
      messagesToSummarize: messagesForSummarization,
      preservedTailMessages,
      skillBlocks,
    }
  }

  async generateSummary(
    ctx: Context,
    partition: OpenAIPartition,
    _pipelineOptions: SummaryRunOptions,
  ): Promise<OpenAIRawSummary> {
    if (!partition.systemMessage) throw new Error("Expected system message in conversation")
    // The privacy of the compaction follows the newest thing that will remain in the conversation.
    const privacyAnchor = partition.preservedTailMessages.at(-1) ??
      partition.userInfoMessage ?? partition.systemMessage
    logger.info(ctx, "[openai-compaction] generating summary via compaction prompt", {
      preservedUserMessageCount: partition.preservedTailMessages.length,
    })
    const inputMessages: RedactedCoreMessage[] = [
      partition.systemMessage,
      ...(partition.userInfoMessage ? [partition.userInfoMessage] : []),
      ...partition.messagesToSummarize,
      {
        _privacyMode: privacyAnchor._privacyMode,
        role: "user",
        content: safeString(OPENAI_COMPACTION_PROMPT),
        providerOptions: SUMMARIZATION_CURSOR_PROVIDER_OPTIONS,
      },
    ]
    const unredacted = (message: RedactedCoreMessage) =>
      fromRedactedCoreMessage(message, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED)
    const { assistantMessage: assistantEntry, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } =
      await executeSelfSummaryWithRetry(
        ctx,
        this.promptSession,
        this.stateHandler,
        this.interactionListener,
        inputMessages.map(unredacted),
        this.tools,
        this.extraT,
        {
          preservedPrefixMessageCount: 1 + (partition.userInfoMessage !== undefined ? 1 : 0),
          ...this.retryOptions,
        },
      )
    compactionInputTokens.histogram(ctx, inputTokens)
    compactionOutputTokens.histogram(ctx, outputTokens)
    compactionCacheReadTokens.histogram(ctx, cacheReadTokens!)
    compactionCacheWriteTokens.histogram(ctx, cacheWriteTokens!)
    const summaryText = extractTextContent(
      toRedactedCoreMessage(assistantEntry, this.stateHandler.getPrivacyMode()),
    ).unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED)
    return { text: summaryText, inputTokens, outputTokens }
  }

  formatSummaryCarrier(
    raw: OpenAIRawSummary,
    partition: OpenAIPartition,
    enrichment: SummaryCarryData,
  ): { message: RedactedCoreMessage; summaryTextLength: number } {
    const blocks = renderDurableBlocks(
      "openai-compaction",
      enrichment as DurableBlockEnrichments,
    )
    // The prefix is what tells the next model that the workspace already holds someone else's work.
    const wrappedText = `${prependDurableBlocks("openai-compaction", blocks)}${appendDurableBlocks("openai-compaction", blocks)}

${SUMMARY_PREFIX}
${raw.text}`
    const lastRequest = partition.preservedTailMessages.at(-1)
    const privacyAnchor = lastRequest ?? partition.userInfoMessage ?? partition.systemMessage
    const privacyMode = privacyAnchor!._privacyMode ?? this.stateHandler.getPrivacyMode()
    return {
      message: toRedactedCoreMessage({
        role: "user",
        content: wrappedText,
        providerOptions: { cursor: { isSummary: true } },
      }, privacyMode),
      summaryTextLength: wrappedText.length,
    }
  }

  /** The kept user messages come before the summary, since they are what the next model is answering. */
  rebuildConversation(
    partition: OpenAIPartition,
    summaryMessage: RedactedCoreMessage,
  ): readonly RedactedCoreMessage[] {
    if (!partition.systemMessage) throw new Error("Expected system message in conversation")
    return [
      partition.systemMessage,
      ...(partition.userInfoMessage ? [partition.userInfoMessage] : []),
      ...partition.preservedTailMessages,
      summaryMessage,
    ]
  }

  async summarize(
    ctx: Context,
    conversationMessages: readonly RedactedCoreMessage[],
    pipelineOptions: SummaryRunOptions,
  ): Promise<Record<string, unknown>> {
    using span = createSpan(ctx.withName("OpenAICompactionHandler.summarize"))
    const scopedContext = span.ctx
    const startedAt = performance.now()
    logger.info(scopedContext, "[openai-compaction] summarize starting", {
      messageCount: conversationMessages.length,
      modelId: this.modelId,
    })
    try {
      const pipelineOutcome = await runSummaryPass(this, scopedContext, conversationMessages, pipelineOptions)
      const summaryValue = createRedactedString(
        pipelineOutcome.rawSummary.text,
        DataClassification.CODE,
        "compaction-summary",
        this.stateHandler.getPrivacyMode(),
      )
      logger.info(scopedContext, "[openai-compaction] summarize completed", {
        summaryTextLength: pipelineOutcome.rawSummary.text.length,
        fullReplacementMessagesCount: pipelineOutcome.fullReplacementMessages.length,
        messagesActuallySummarizedCount: pipelineOutcome.messagesActuallySummarized.length,
      })
      compactionStatus.increment(scopedContext, 1, { outcome: "success", errorKind: "Ok" })
      return {
        ...pipelineOutcome,
        summary: { summary: summaryValue },
        onPersisted: () => { this.stateHandler.incrementSelfSummaryCount() },
      }
    } catch (error) {
      // A failed compaction is counted with the kind of failure it was, since the caller retries by kind.
      const failureKind = getRetryDirective(error, { transientRetryDelayMs: 0 }).errorType
      compactionStatus.increment(scopedContext, 1, { outcome: "failed", failureKind })
      throw error
    } finally {
      compactionTimeTakenMs.histogram(scopedContext, performance.now() - startedAt)
    }
  }
}

/** The length of a message's text, counted from the parts that carry text rather than from the whole message. */
function textLengthOf(message: RedactedCoreMessage): number {
  const content = message.content
  if (isRedactedString(content)) {
    return content.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED).length
  }
  if (Array.isArray(content)) {
    return content.reduce((total, part) => {
      const typedFragment = part as { type?: unknown; text?: unknown }
      if (typedFragment.type === "text" && isRedactedString(typedFragment.text)) {
        return total + typedFragment.text.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED).length
      }
      return total
    }, 0)
  }
  return 0
}

function isCompactionSummary(message: RedactedCoreMessage): boolean {
  const pipelineOptions = message.providerOptions as { cursor?: { isSummary?: unknown } } | undefined
  return pipelineOptions?.cursor?.isSummary === true
}

function isRequestMessage(message: RedactedCoreMessage): boolean {
  return message.role === "user" && !isCompactionSummary(message)
}

function compactionTextOf(message: RedactedCoreMessage): string {
  const content = message.content
  if (isRedactedString(content)) {
    return content.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED)
  }
  if (Array.isArray(content)) {
    return content.map(part => {
      const typedFragment = part as { type?: unknown; text?: unknown }
      return typedFragment.type === "text" && isRedactedString(typedFragment.text)
        ? typedFragment.text.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED)
        : ""
    }).join("")
  }
  return ""
}

/** Only the request itself is kept from a user message, not the context the platform wrapped around it. */
function requestSegmentsOf(text: string): string | undefined {
  const segmentMatches = text.match(/<user_query>[\s\S]*?<\/user_query>/g)
  if (segmentMatches === null) return undefined
  const retained = segmentMatches.join("\n\n").trim()
  return retained.length > 0 ? retained : undefined
}

function requestOnlyMessage(message: RedactedCoreMessage): RedactedCoreMessage | undefined {
  const requestText = requestSegmentsOf(compactionTextOf(message))
  if (requestText === undefined) return undefined
  return { ...message, content: safeString(requestText) }
}

/**
 * The most recent requests that fit a token budget. Counting is from the newest backwards, since the most
 * recent request is the one being answered, and the first message that does not fit ends the walk rather
 * than being skipped — a gap in the conversation would be worse than an older message left out.
 */
function recentRequestsWithinBudget(
  conversationMessages: readonly RedactedCoreMessage[],
  tokenBudget: number,
): RedactedCoreMessage[] {
  const requestMessages = conversationMessages
    .filter(isRequestMessage)
    .map(requestOnlyMessage)
    .filter((message): message is RedactedCoreMessage => message !== undefined)
  const kept: RedactedCoreMessage[] = []
  let remainingBudget = tokenBudget
  for (let index = requestMessages.length - 1; index >= 0 && remainingBudget > 0; index--) {
    const message = requestMessages[index]!
    const estimatedTokens = Math.ceil(textLengthOf(message) / APPROX_CHARS_PER_TOKEN)
    if (estimatedTokens <= remainingBudget) {
      kept.push(message)
      remainingBudget -= estimatedTokens
    } else {
      break
    }
  }
  kept.reverse()
  return kept
}
