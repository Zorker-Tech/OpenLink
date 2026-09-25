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
    promptSession: SelfSummaryPromptSession,
    stateHandler: SelfSummaryStateHandler,
    interactionListener: RedactedInteractionListener,
    tools: SelfSummaryTool[],
    extraT: unknown,
    modelId: string,
    retryOptions?: SelfSummaryRetryOptions,
  ) {
    this.promptSession = promptSession
    this.stateHandler = stateHandler
    this.interactionListener = interactionListener
    this.tools = tools
    this.extraT = extraT
    this.modelId = modelId
    this.retryOptions = retryOptions ?? {}
  }

  getModelId(): string { return this.modelId }
  getMetricsModelLabel(): string { return this.modelId }

  /** Everything is summarized; what is kept is the user's own most recent requests, within a budget. */
  partitionMessages(messages: readonly RedactedCoreMessage[], _options: SummarizationPipelineOptions): OpenAIPartition {
    const { systemMessage, userInfoMessage, messagesForSummarization } = prepareMessagesForCompaction(messages)
    const skillBlocks = collectAllSkillBlocks(messagesForSummarization)
    const preservedTailMessages = collectBudgetedUserMessages(
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
    partitioned: OpenAIPartition,
    _options: SummarizationPipelineOptions,
  ): Promise<OpenAIRawSummary> {
    if (!partitioned.systemMessage) throw new Error("Expected system message in conversation")
    // The privacy of the compaction follows the newest thing that will remain in the conversation.
    const privacySource = partitioned.preservedTailMessages.at(-1) ??
      partitioned.userInfoMessage ?? partitioned.systemMessage
    logger.info(ctx, "[openai-compaction] generating summary via compaction prompt", {
      preservedUserMessageCount: partitioned.preservedTailMessages.length,
    })
    const compactInputMessages: RedactedCoreMessage[] = [
      partitioned.systemMessage,
      ...(partitioned.userInfoMessage ? [partitioned.userInfoMessage] : []),
      ...partitioned.messagesToSummarize,
      {
        _privacyMode: privacySource._privacyMode,
        role: "user",
        content: safeString(OPENAI_COMPACTION_PROMPT),
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
    compactionInputTokens.histogram(ctx, inputTokens)
    compactionOutputTokens.histogram(ctx, outputTokens)
    compactionCacheReadTokens.histogram(ctx, cacheReadTokens!)
    compactionCacheWriteTokens.histogram(ctx, cacheWriteTokens!)
    const summaryText = extractTextContent(
      toRedactedCoreMessage(assistantMessage, this.stateHandler.getPrivacyMode()),
    ).unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED)
    return { text: summaryText, inputTokens, outputTokens }
  }

  buildSummaryMessage(
    rawSummary: OpenAIRawSummary,
    partitioned: OpenAIPartition,
    enrichments: SummarizationEnrichments,
  ): { message: RedactedCoreMessage; summaryTextLength: number } {
    const durableBlocks = renderDurableBlocks(
      "openai-compaction",
      enrichments as DurableBlockEnrichments,
    )
    // The prefix is what tells the next model that the workspace already holds someone else's work.
    const wrappedContent = `${prependDurableBlocks("openai-compaction", durableBlocks)}${appendDurableBlocks("openai-compaction", durableBlocks)}

${SUMMARY_PREFIX}
${rawSummary.text}`
    const lastUserQuery = partitioned.preservedTailMessages.at(-1)
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

  /** The kept user messages come before the summary, since they are what the next model is answering. */
  assembleFinalMessages(
    partitioned: OpenAIPartition,
    summaryMessage: RedactedCoreMessage,
  ): readonly RedactedCoreMessage[] {
    if (!partitioned.systemMessage) throw new Error("Expected system message in conversation")
    return [
      partitioned.systemMessage,
      ...(partitioned.userInfoMessage ? [partitioned.userInfoMessage] : []),
      ...partitioned.preservedTailMessages,
      summaryMessage,
    ]
  }

  async summarize(
    ctx: Context,
    messages: readonly RedactedCoreMessage[],
    options: SummarizationPipelineOptions,
  ): Promise<Record<string, unknown>> {
    using spanContext = createSpan(ctx.withName("OpenAICompactionHandler.summarize"))
    const innerCtx = spanContext.ctx
    const startTime = performance.now()
    logger.info(innerCtx, "[openai-compaction] summarize starting", {
      messageCount: messages.length,
      modelId: this.modelId,
    })
    try {
      const pipelineResult = await runSummarizationPipeline(this, innerCtx, messages, options)
      const summaryCodeString = createRedactedString(
        pipelineResult.rawSummary.text,
        DataClassification.CODE,
        "compaction-summary",
        this.stateHandler.getPrivacyMode(),
      )
      logger.info(innerCtx, "[openai-compaction] summarize completed", {
        summaryTextLength: pipelineResult.rawSummary.text.length,
        fullReplacementMessagesCount: pipelineResult.fullReplacementMessages.length,
        messagesActuallySummarizedCount: pipelineResult.messagesActuallySummarized.length,
      })
      compactionStatus.increment(innerCtx, 1, { outcome: "success", errorKind: "Ok" })
      return {
        ...pipelineResult,
        summary: { summary: summaryCodeString },
        onPersisted: () => { this.stateHandler.incrementSelfSummaryCount() },
      }
    } catch (error) {
      // A failed compaction is counted with the kind of failure it was, since the caller retries by kind.
      const errorKind = getRetryDirective(error, { transientRetryDelayMs: 0 }).errorType
      compactionStatus.increment(innerCtx, 1, { outcome: "failed", errorKind })
      throw error
    } finally {
      compactionTimeTakenMs.histogram(innerCtx, performance.now() - startTime)
    }
  }
}

/** The length of a message's text, counted from the parts that carry text rather than from the whole message. */
function getMessageTextLength(message: RedactedCoreMessage): number {
  const content = message.content
  if (isRedactedString(content)) {
    return content.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED).length
  }
  if (Array.isArray(content)) {
    return content.reduce((accumulator, part) => {
      const typedPart = part as { type?: unknown; text?: unknown }
      if (typedPart.type === "text" && isRedactedString(typedPart.text)) {
        return accumulator + typedPart.text.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED).length
      }
      return accumulator
    }, 0)
  }
  return 0
}

function isSummaryMessage(message: RedactedCoreMessage): boolean {
  const options = message.providerOptions as { cursor?: { isSummary?: unknown } } | undefined
  return options?.cursor?.isSummary === true
}

function isNonSummaryUserMessage(message: RedactedCoreMessage): boolean {
  return message.role === "user" && !isSummaryMessage(message)
}

function extractTextContentForCompaction(message: RedactedCoreMessage): string {
  const content = message.content
  if (isRedactedString(content)) {
    return content.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED)
  }
  if (Array.isArray(content)) {
    return content.map(part => {
      const typedPart = part as { type?: unknown; text?: unknown }
      return typedPart.type === "text" && isRedactedString(typedPart.text)
        ? typedPart.text.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED)
        : ""
    }).join("")
  }
  return ""
}

/** Only the request itself is kept from a user message, not the context the platform wrapped around it. */
function extractUserQuerySegments(messageText: string): string | undefined {
  const userQueryMatches = messageText.match(/<user_query>[\s\S]*?<\/user_query>/g)
  if (userQueryMatches === null) return undefined
  const retained = userQueryMatches.join("\n\n").trim()
  return retained.length > 0 ? retained : undefined
}

function toCompactionUserMessage(message: RedactedCoreMessage): RedactedCoreMessage | undefined {
  const retainedUserQueryText = extractUserQuerySegments(extractTextContentForCompaction(message))
  if (retainedUserQueryText === undefined) return undefined
  return { ...message, content: safeString(retainedUserQueryText) }
}

/**
 * The most recent requests that fit a token budget. Counting is from the newest backwards, since the most
 * recent request is the one being answered, and the first message that does not fit ends the walk rather
 * than being skipped — a gap in the conversation would be worse than an older message left out.
 */
function collectBudgetedUserMessages(
  messages: readonly RedactedCoreMessage[],
  maxTokens: number,
): RedactedCoreMessage[] {
  const userMessages = messages
    .filter(isNonSummaryUserMessage)
    .map(toCompactionUserMessage)
    .filter((message): message is RedactedCoreMessage => message !== undefined)
  const selected: RedactedCoreMessage[] = []
  let remainingTokens = maxTokens
  for (let index = userMessages.length - 1; index >= 0 && remainingTokens > 0; index--) {
    const message = userMessages[index]!
    const approximateTokens = Math.ceil(getMessageTextLength(message) / APPROX_CHARS_PER_TOKEN)
    if (approximateTokens <= remainingTokens) {
      selected.push(message)
      remainingTokens -= approximateTokens
    } else {
      break
    }
  }
  selected.reverse()
  return selected
}
