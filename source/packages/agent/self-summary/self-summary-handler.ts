/**
 * Summarizing a conversation with the model that is already in it.
 *
 * A summary written by another model is a translation: the conversation is handed over, a stranger writes
 * it down, and the model continues from that. A self-summary is the same conversation asking the same model
 * to write it down, which is why it is preferred when the session can afford it — nothing about the task is
 * lost in the handover, and the model keeps its own working memory.
 *
 * The shape of the exchange is what makes it work: the conversation is sent as it stands, followed by one
 * instruction to summarize, and the answer is the summary. That answer has to be text: a tool call in it
 * means the model kept working instead of summarizing, which is counted and reported rather than adopted,
 * and a response that is not an assistant message at all is an error of its own.
 *
 * Retrying is the same discipline as the platform's own summarizer with two differences. An empty answer is
 * a failure worth retrying, since a model that wrote nothing has not summarized; and when the input is too
 * large, what is dropped is chosen rather than truncated — a conversation that is mostly tool traffic loses
 * its tool messages and the assistant calls that asked for them, because those are the bulkiest and least
 * load-bearing part of it, while the prompt and the messages before it are kept.
 *
 * The summary replaces the conversation as a carrier message marked as a summary, with the mode, the root,
 * the plan, the transcript and the todo list put back around it, and it tells the model how many summaries
 * have been written for this request, because a conversation that keeps summarizing is a conversation that
 * is not converging.
 */

import {
  appendDurableBlocks,
  prependDurableBlocks,
  renderDurableBlocks,
  type DurableBlockEnrichments,
} from "../../agent-summarization/durable-blocks.ts"
import {
  getRetryDirective,
  NoSummaryResponseError,
} from "../../agent-summarization/error-handling.ts"
import {
  runSummaryPass,
  type SummaryCarryData,
  type SummaryRunOptions,
} from "../../agent-summarization/pipeline.ts"
import { prepareMessagesForCompaction } from "../../agent-summarization/prepare-messages.ts"
import { collectAttachedSkillBlocksFromConversation } from "../../../adapters/interop/agent/compaction-skill-message-adapter.ts"
import {
  SHORTER_OUTPUT_RETRY_PROMPT,
  SUMMARIZATION_PROVIDER_OPTIONS,
} from "../../agent-summarization/summarization-handler.ts"
import { toUnredactedInteractionListener } from "../../../adapters/interop/agent/redacted-interaction-listener-adapter.ts"
import type { Context } from "../../context/context.ts"
import { createLogger, createSpan } from "../../context/index.ts"
import { createCounter, createHistogram } from "../../metrics/index.ts"
import { DataClassification, PrivacyCapability } from "../../redaction/classification.ts"
import { fromRedactedCoreMessage, toRedactedCoreMessage, type CoreMessageLike } from "../../redaction/message-redaction.ts"
import { createRedactedString, safeString } from "../../redaction/create.ts"
import type { PrivacyMode } from "../../redaction/privacy-mode.ts"
import { InteractionHandler } from "../interaction-handler.ts"
import { buildDescriptionGeneratorProps } from "../tools/tool-execution.ts"
import { getInvocationId } from "../utils/invocation-id.ts"
import {
  getMaxModeFromContext,
  getMembershipTypeMetricTagsFromContext,
} from "../utils/request-scope.ts"
import { MAX_SELF_SUMMARY_RETRIES, SELF_SUMMARIZATION_PROMPT } from "./constants.ts"
import { extractTextContent } from "./token-estimate.ts"
import { findLastUserMessageIndex, type SelfSummaryMessage } from "./self-summary.ts"

type RedactedCoreMessage = Parameters<typeof fromRedactedCoreMessage>[0]
type RedactedInteractionListener = Parameters<typeof toUnredactedInteractionListener<Context>>[0]

export interface SelfSummaryExtendedUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens?: number | undefined
  readonly cacheWriteTokens?: number | undefined
  readonly reasoningTokens?: number | undefined
}

export interface SelfSummaryResponse {
  readonly messages: readonly CoreMessageLike[]
  readonly error?: unknown
}

export interface SelfSummaryStreamResult {
  readonly fullStream: AsyncIterable<unknown>
  readonly extendedUsage: Promise<SelfSummaryExtendedUsage>
  readonly usage: Promise<unknown>
  readonly providerMetadata: Promise<unknown>
  readonly invocationId: Promise<unknown>
  readonly response: Promise<SelfSummaryResponse>
}

export interface SelfSummaryToolStreamExecutor {
  appendMessages(messages: readonly CoreMessageLike[]): unknown
  executeToolStream(
    ctx: Context,
    stateHandler: SelfSummaryStateHandler,
    interactionHandler: InteractionHandler,
    tools: SelfSummaryTool[],
    extra: unknown,
    onToolCall: () => Promise<void>,
    toolDescriptionProps: Record<string, unknown>,
  ): SelfSummaryStreamResult
}

export interface SelfSummaryPromptSession {
  getExecutor(): SelfSummaryToolStreamExecutor
}

export interface SelfSummaryTool {
  readonly name: string
  readonly toolIdentifier: string
  readonly parameters: unknown
  readonly [key: string]: unknown
}

export interface SelfSummaryStateHandler {
  readonly selfSummaryCount: number
  getPrivacyMode(): PrivacyMode
  addTurnUsage(usage: {
    readonly inputTokens: number
    readonly outputTokens: number
    readonly cacheReadTokens?: number | undefined
    readonly cacheWriteTokens?: number | undefined
    readonly reasoningTokens?: number | undefined
  }): void
  incrementSelfSummaryCount(): void
}

export interface SelfSummaryRetryOptions {
  readonly toolDescriptionProps?: Record<string, unknown> | undefined
  readonly enableRetryNoSummaryResponse?: boolean | undefined
  readonly enableReduceInputsRetry?: boolean | undefined
  readonly enableRetryUncategorizedErrors?: boolean | undefined
}

interface SelfSummaryPartition {
  readonly systemMessage: RedactedCoreMessage | undefined
  readonly userInfoMessage: RedactedCoreMessage | undefined
  readonly messagesToSummarize: readonly RedactedCoreMessage[]
  readonly preservedTailMessages: readonly RedactedCoreMessage[]
  readonly skillBlocks: readonly string[]
}

interface SelfSummaryRawResult {
  readonly text: string
}

const logger = createLogger("@slate/agent")
const TRANSIENT_SELF_SUMMARY_RETRY_DELAY_MS = 2_000
const TOOL_MESSAGE_DROP_THRESHOLD = 0.25
const selfSummaryInputTokens = createHistogram("self_summary.input_token", {
  description: "Input tokens consumed during self-summarization",
  labelNames: ["membershiptype"],
})
const selfSummaryOutputTokens = createHistogram("self_summary.output_token", {
  description: "Output tokens generated during self-summarization",
  labelNames: ["membershiptype"],
})
const selfSummaryTimeTakenMs = createHistogram("self_summary.time_taken_ms", {
  description: "Time taken for self-summarization in milliseconds",
  labelNames: ["membershiptype"],
})
const selfSummaryStatus = createCounter("self_summary.status", {
  description: "Count of self-summary attempts and their outcomes",
  labelNames: ["outcome", "errorKind", "membershiptype", "maxmode"],
})
const selfSummaryTryAttempts = createCounter("self_summary.try.attempts", {
  description: "Per-try self-summary attempts within the retry loop",
  labelNames: ["membershiptype"],
})
const selfSummaryTrySuccess = createCounter("self_summary.try.success", {
  description: "Per-try successful self-summary attempts",
  labelNames: ["membershiptype"],
})
const selfSummaryTryFailures = createCounter("self_summary.try.failures", {
  description: "Per-try failed self-summary attempts",
  labelNames: ["errorKind", "membershiptype"],
})
const selfSummaryRetries = createCounter("self_summary.retries", {
  description: "Total retries (attempts beyond the first) that actually executed",
  labelNames: ["errorKind", "membershiptype"],
})
const selfSummaryUnexpectedToolCalls = createCounter("self_summary.unexpected_tool_calls", {
  description: "Count of unexpected tool calls detected in self-summary response",
  labelNames: ["membershiptype"],
})

/**
 * One self-summary exchange. The interaction handler is a no-op one: the summary is being written, not
 * carried out, so nothing the model says here is delivered to the user.
 */
async function executeSelfSummaryStream(
  outerCtx: Context,
  toolExecutor: SelfSummaryToolStreamExecutor,
  stateHandler: SelfSummaryStateHandler,
  redactedListener: RedactedInteractionListener,
  tools: SelfSummaryTool[],
  extra: unknown,
  toolDescriptionProps: Record<string, unknown> | undefined,
): Promise<{
  assistantMessage: CoreMessageLike
  textContent: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number | undefined
  cacheWriteTokens: number | undefined
}> {
  using spanContext = createSpan(outerCtx.withName("executeSelfSummaryStream"))
  const ctx = spanContext.ctx
  const invocationId = getInvocationId(ctx)
  const silentToolRecorder = { recordToolCall: () => {} }
  const silentHandler = new InteractionHandler(
    toUnredactedInteractionListener(redactedListener, stateHandler.getPrivacyMode()),
    silentToolRecorder,
    invocationId,
  )
  const result = toolExecutor.executeToolStream(
    ctx,
    stateHandler,
    silentHandler,
    tools,
    extra,
    async () => {},
    toolDescriptionProps ?? buildDescriptionGeneratorProps(tools),
  )
  result.extendedUsage.catch(error => {
    logger.error(ctx, "[self-summary] Error getting extended usage", error, { summarization: { invocationId } })
  })
  result.usage.catch(error => {
    logger.error(ctx, "[self-summary] Error getting usage", error, { summarization: { invocationId } })
  })
  result.providerMetadata.catch(error => {
    logger.error(ctx, "[self-summary] Error getting provider metadata", error, { summarization: { invocationId } })
  })
  result.invocationId.catch(error => {
    logger.error(ctx, "[self-summary] Error getting invocation id", error, { summarization: { invocationId } })
  })
  result.response.catch(error => {
    logger.error(ctx, "[self-summary] Error getting response", error, { summarization: { invocationId } })
  })
  for await (const _chunk of result.fullStream) {}
  const response = await result.response
  const extendedUsage = await result.extendedUsage
  const metricTags = getMembershipTypeMetricTagsFromContext(ctx)
  selfSummaryInputTokens.histogram(ctx, extendedUsage.inputTokens, metricTags)
  selfSummaryOutputTokens.histogram(ctx, extendedUsage.outputTokens, metricTags)
  if (response.error) throw response.error
  // The usage is the turn's usage: a self-summary is part of the conversation it summarizes.
  stateHandler.addTurnUsage({
    inputTokens: extendedUsage.inputTokens,
    outputTokens: extendedUsage.outputTokens,
    cacheReadTokens: extendedUsage.cacheReadTokens,
    cacheWriteTokens: extendedUsage.cacheWriteTokens,
    reasoningTokens: extendedUsage.reasoningTokens,
  })
  let toolCallsSeen = false
  for (const message of response.messages) {
    const toolCallPart = message.role === "assistant" && Array.isArray(message.content) &&
      message.content.some(part => (part as { type?: unknown }).type === "tool-call")
    if (toolCallPart) {
      toolCallsSeen = true
      selfSummaryUnexpectedToolCalls.increment(ctx, 1, metricTags)
    }
  }
  // A model that kept calling tools instead of summarizing has not summarized, so it is reported loudly.
  if (toolCallsSeen) {
    logger.error(ctx, "[self-summary] unexpected tool calls detected in summarization response", {
      summarization: { invocationId },
    })
  }
  if (response.messages.length > 1) {
    logger.info(ctx, "[self-summary] self summary response stream contained more than one message", {
      summarization: { messageCount: response.messages.length, invocationId },
    })
  }
  const finalAssistant = response.messages.at(-1)
  if (finalAssistant?.role !== "assistant") throw new NoSummaryResponseError()
  const answerText = extractTextContent(
    toRedactedCoreMessage(finalAssistant, stateHandler.getPrivacyMode()) as SelfSummaryMessage,
  ).unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED)
  return {
    assistantMessage: finalAssistant,
    textContent: answerText,
    inputTokens: extendedUsage.inputTokens,
    outputTokens: extendedUsage.outputTokens,
    cacheReadTokens: extendedUsage.cacheReadTokens,
    cacheWriteTokens: extendedUsage.cacheWriteTokens,
  }
}

/** Asking for a shorter summary means asking the same question again with that instruction appended. */
function appendShorterOutputRetryInstruction(sourceMessages: readonly CoreMessageLike[]): readonly CoreMessageLike[] {
  const updatedMessages = sourceMessages.slice()
  const lastMessage = updatedMessages.at(-1)
  // A prompt that is not a string message cannot be appended to, so the input is left as it was.
  if (lastMessage === undefined || lastMessage.role === "tool" || typeof lastMessage.content !== "string") {
    return sourceMessages
  }
  updatedMessages[updatedMessages.length - 1] = {
    ...lastMessage,
    content: `${lastMessage.content}${SHORTER_OUTPUT_RETRY_PROMPT}`,
  }
  return updatedMessages
}

/**
 * A smaller version of the same question.
 *
 * What is dropped is chosen by what the conversation is made of. A conversation that is mostly tool traffic
 * loses its tool messages and the assistant calls that asked for them, since they are the bulkiest part and
 * the summary is about the task rather than about the tools; the prompt and the messages before it are
 * always kept. A conversation that is not mostly tool traffic loses its older half instead, and the cut is
 * moved forward off a tool message so the shortened conversation does not start with a result whose call
 * was dropped.
 */
function reduceSelfSummaryInputMessages(
  sourceMessages: readonly CoreMessageLike[],
  preservedPrefixMessageCount: number,
): readonly CoreMessageLike[] {
  // Nothing between the prefix and the prompt means there is nothing to drop.
  if (sourceMessages.length <= preservedPrefixMessageCount + 1) return sourceMessages
  const keptPrefix = sourceMessages.slice(0, preservedPrefixMessageCount)
  const lastMessage = sourceMessages.at(-1)
  const bodyMessages = sourceMessages.slice(preservedPrefixMessageCount, -1)
  const isAssistantToolCallMessage = (message: CoreMessageLike) =>
    message.role === "assistant" && Array.isArray(message.content) &&
    message.content.some(part => (part as { type?: unknown }).type === "tool-call")
  if (lastMessage === undefined || bodyMessages.length === 0) return sourceMessages
  const toolMessageCount = bodyMessages.filter(message => message.role === "tool").length
  if (toolMessageCount > 0 && toolMessageCount / bodyMessages.length >= TOOL_MESSAGE_DROP_THRESHOLD) {
    const survivingMessages = bodyMessages.filter(
      message => message.role !== "tool" && !isAssistantToolCallMessage(message),
    )
    return [...keptPrefix, ...survivingMessages, lastMessage]
  }
  if (bodyMessages.length === 1) {
    // A single message is halved, and one too short to halve is left alone rather than emptied.
    const singleMessage = bodyMessages[0]!
    if (singleMessage.role === "tool" || typeof singleMessage.content !== "string" || singleMessage.content.length < 2) {
      return sourceMessages
    }
    const halvedContent = singleMessage.content.slice(Math.floor(singleMessage.content.length / 2))
    return [...keptPrefix, { ...singleMessage, content: halvedContent }, lastMessage]
  }
  let keptMiddleMessageStartIndex = Math.floor(bodyMessages.length / 2)
  while (
    keptMiddleMessageStartIndex < bodyMessages.length &&
    bodyMessages[keptMiddleMessageStartIndex]?.role === "tool"
  ) {
    keptMiddleMessageStartIndex++
  }
  const survivingMessages = bodyMessages.slice(keptMiddleMessageStartIndex)
  return [...keptPrefix, ...survivingMessages, lastMessage]
}

export async function executeSelfSummaryWithRetry(
  outerCtx: Context,
  promptSessionSource: SelfSummaryPromptSession,
  stateHandler: SelfSummaryStateHandler,
  redactedListener: RedactedInteractionListener,
  summarizationSource: readonly CoreMessageLike[],
  tools: SelfSummaryTool[],
  extra: unknown,
  options: SelfSummaryRetryOptions & { readonly preservedPrefixMessageCount: number },
): Promise<Awaited<ReturnType<typeof executeSelfSummaryStream>>> {
  using spanContext = createSpan(outerCtx.withName("executeSelfSummaryWithRetry"))
  const ctx = spanContext.ctx
  const metricTags = getMembershipTypeMetricTagsFromContext(ctx)
  const maxmode = getMaxModeFromContext(ctx) ? "true" : "false"
  let workingMessages = summarizationSource
  let requestShorterOutput = false
  let finalErrorKind: string | undefined
  for (let attempt = 1; attempt <= MAX_SELF_SUMMARY_RETRIES; attempt++) {
    logger.info(ctx, "[self-summary] attempt started", {
      summarization: {
        attempt,
        maxRetries: MAX_SELF_SUMMARY_RETRIES,
        inputMessageCount: workingMessages.length,
        requestShorterOutput,
      },
    })
    selfSummaryTryAttempts.increment(ctx, 1, metricTags)
    try {
      const toolExecutor = promptSessionSource.getExecutor()
      toolExecutor.appendMessages(workingMessages)
      const result = await executeSelfSummaryStream(
        ctx,
        toolExecutor,
        stateHandler,
        redactedListener,
        tools,
        extra,
        options.toolDescriptionProps,
      )
      const answerNonEmpty = result.textContent.trim().length > 0
      if (answerNonEmpty) {
        logger.info(ctx, "[self-summary] attempt succeeded", {
          summarization: { attempt, contentLength: result.textContent.length },
        })
        selfSummaryTrySuccess.increment(ctx, 1, metricTags)
        selfSummaryStatus.increment(ctx, 1, {
          outcome: "success",
          errorKind: "Ok",
          ...metricTags,
          maxmode,
        })
        return result
      }
      // An answer with nothing in it is a failure, not a summary of nothing.
      const retryAllowed = attempt < MAX_SELF_SUMMARY_RETRIES
      finalErrorKind = "EmptyContent"
      selfSummaryTryFailures.increment(ctx, 1, { errorKind: "EmptyContent", ...metricTags })
      logger.warn(ctx, "[self-summary] empty content received", {
        summarization: { attempt, maxRetries: MAX_SELF_SUMMARY_RETRIES, retryAllowed },
      })
      if (!retryAllowed) break
      selfSummaryRetries.increment(ctx, 1, { errorKind: "EmptyContent", ...metricTags })
    } catch (error) {
      const enableRetryNoSummaryResponse = options.enableRetryNoSummaryResponse ?? false
      const enableReduceInputsRetry = options.enableReduceInputsRetry ?? true
      const enableRetryUncategorizedErrors = options.enableRetryUncategorizedErrors ?? true
      const directive = getRetryDirective(error, {
        transientRetryDelayMs: TRANSIENT_SELF_SUMMARY_RETRY_DELAY_MS,
        enableRetryNoSummaryResponse,
        enableReduceInputsRetry,
        enableRetryUncategorizedErrors,
      })
      const retryAllowed = directive.shouldRetry && attempt < MAX_SELF_SUMMARY_RETRIES
      finalErrorKind = directive.errorType
      selfSummaryTryFailures.increment(ctx, 1, { errorKind: directive.errorType, ...metricTags })
      logger.error(ctx, "[self-summary] attempt failed with error", error, {
        summarization: {
          attempt,
          maxRetries: MAX_SELF_SUMMARY_RETRIES,
          errorType: directive.errorType,
          retryAllowed,
          retryDelayMs: directive.retryDelayMs,
          requestShorterOutput: directive.requestShorterOutput,
          reduceInputs: directive.reduceInputs,
          options: {
            enableReduceInputsRetry,
            enableRetryNoSummaryResponse,
            enableRetryUncategorizedErrors,
          },
        },
      })
      if (!retryAllowed) {
        selfSummaryStatus.increment(ctx, 1, {
          outcome: "failed",
          errorKind: directive.errorType,
          ...metricTags,
          maxmode,
        })
        throw error
      }
      selfSummaryRetries.increment(ctx, 1, { errorKind: directive.errorType, ...metricTags })
      if (directive.requestShorterOutput && !requestShorterOutput) {
        workingMessages = appendShorterOutputRetryInstruction(workingMessages)
        requestShorterOutput = true
        logger.info(ctx, "[self-summary] retrying with shorter-output instruction", {
          summarization: { attempt, nextAttempt: attempt + 1 },
        })
      }
      if (directive.reduceInputs) {
        const nextInputMessages = reduceSelfSummaryInputMessages(
          workingMessages,
          options.preservedPrefixMessageCount,
        )
        logger.info(ctx, "[self-summary] retrying with reduced inputs", {
          summarization: {
            attempt,
            previousInputMessageCount: workingMessages.length,
            nextInputMessageCount: nextInputMessages.length,
          },
        })
        workingMessages = nextInputMessages
      }
      if (directive.retryDelayMs > 0) {
        logger.info(ctx, "[self-summary] retrying after delay", {
          summarization: { attempt, retryDelayMs: directive.retryDelayMs },
        })
        await new Promise(resolve => setTimeout(resolve, directive.retryDelayMs))
      }
    }
  }
  logger.error(ctx, "[self-summary] all retries exhausted", {
    summarization: { maxRetries: MAX_SELF_SUMMARY_RETRIES },
  })
  selfSummaryStatus.increment(ctx, 1, {
    outcome: "failed",
    errorKind: finalErrorKind ?? "EmptyContent",
    ...metricTags,
    maxmode,
  })
  throw new Error("[self-summary] all retries exhausted without valid content")
}

export class SelfSummarizer {
  declare readonly promptSession: SelfSummaryPromptSession
  declare readonly stateHandler: SelfSummaryStateHandler
  declare readonly redactedListener: RedactedInteractionListener
  declare readonly tools: SelfSummaryTool[]
  declare readonly extraT: unknown
  declare readonly modelId: string
  declare readonly retryOptions: SelfSummaryRetryOptions
  declare readonly enableTranscriptEnrichment: boolean

  constructor(
    promptSession: SelfSummaryPromptSession,
    stateHandler: SelfSummaryStateHandler,
    redactedListener: RedactedInteractionListener,
    tools: SelfSummaryTool[],
    extraT: unknown,
    modelId: string,
    retryOptions?: SelfSummaryRetryOptions,
    enableTranscriptEnrichment?: boolean,
  ) {
    this.promptSession = promptSession
    this.stateHandler = stateHandler
    this.redactedListener = redactedListener
    this.tools = tools
    this.extraT = extraT
    this.modelId = modelId
    this.retryOptions = retryOptions ?? {}
    this.enableTranscriptEnrichment = enableTranscriptEnrichment ?? false
  }

  getModelId(): string { return this.modelId }
  getMetricsModelLabel(): string { return this.modelId }

  /**
   * What is summarized and what is kept. The whole conversation is summarized except the last user message,
   * which is kept because the model is about to answer it — a self-summary that swallowed the question would
   * leave the model with nothing to do.
   */
  separateMessages(messages: readonly RedactedCoreMessage[], _options: SummaryRunOptions): SelfSummaryPartition {
    if (messages.length < 3) {
      throw new Error(`Self-summary requires at least 3 messages, got ${messages.length}`)
    }
    const { systemMessage, userInfoMessage, messagesForSummarization } = prepareMessagesForCompaction(messages)
    if (!systemMessage || systemMessage.role !== "system") {
      throw new Error("Expected system message in conversation")
    }
    const lastUserIndex = findLastUserMessageIndex(messages as SelfSummaryMessage[])
    const lastUserQuery = messages[lastUserIndex]
    const skillBlocks = collectAttachedSkillBlocksFromConversation(messagesForSummarization)
    return {
      systemMessage,
      userInfoMessage,
      messagesToSummarize: messagesForSummarization,
      preservedTailMessages: lastUserQuery ? [lastUserQuery] : [],
      skillBlocks,
    }
  }

  async generateSummary(
    ctx: Context,
    partitioned: SelfSummaryPartition,
    _options: SummaryRunOptions,
  ): Promise<SelfSummaryRawResult> {
    if (!partitioned.systemMessage) throw new Error("Expected system message in conversation")
    // The instruction is the last message, so the model reads the conversation and then the request to
    // summarize it, which is the shape it was trained on.
    const privacyCarrier = partitioned.preservedTailMessages[0] ?? partitioned.userInfoMessage ?? partitioned.systemMessage
    const summarizationSource: RedactedCoreMessage[] = [
      partitioned.systemMessage,
      ...(partitioned.userInfoMessage ? [partitioned.userInfoMessage] : []),
      ...partitioned.messagesToSummarize,
      {
        _privacyMode: privacyCarrier._privacyMode,
        role: "user",
        content: safeString(SELF_SUMMARIZATION_PROMPT),
        providerOptions: SUMMARIZATION_PROVIDER_OPTIONS,
      },
    ]
    const unredactMessage = (message: RedactedCoreMessage) =>
      fromRedactedCoreMessage(message, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED)
    const { assistantMessage: finalAssistant } = await executeSelfSummaryWithRetry(
      ctx,
      this.promptSession,
      this.stateHandler,
      this.redactedListener,
      summarizationSource.map(unredactMessage),
      this.tools,
      this.extraT,
      {
        // The system message and the user's profile are never dropped, however small the prompt has to be.
        preservedPrefixMessageCount: 1 + (partitioned.userInfoMessage !== undefined ? 1 : 0),
        ...this.retryOptions,
      },
    )
    const summaryText = extractTextContent(
      toRedactedCoreMessage(finalAssistant, this.stateHandler.getPrivacyMode()) as SelfSummaryMessage,
    ).unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED)
    return { text: summaryText }
  }

  formatSummaryCarrier(
    rawSummary: SelfSummaryRawResult,
    partitioned: SelfSummaryPartition,
    enrichments: SummaryCarryData,
  ): { message: RedactedCoreMessage; summaryTextLength: number } {
    const summaryNumber = this.stateHandler.selfSummaryCount + 1
    const blocks = renderDurableBlocks("self-summary", enrichments as DurableBlockEnrichments, {
      includeTranscript: this.enableTranscriptEnrichment,
    })
    // The blocks that go in front are what the session is, and the ones that follow are what it was doing.
    const summaryBody = `${prependDurableBlocks("self-summary", blocks)}

Your conversation was summarized due to context constraints. Here is the summary of the conversation so far:

<summary_content>
${rawSummary.text}
</summary_content>${appendDurableBlocks("self-summary", blocks)}

Total summaries generated so far for this user query: ${summaryNumber}

If the task is complete, respond to the user. Otherwise, continue working on the task.`
    const lastUserQuery = partitioned.preservedTailMessages[0]
    const privacyCarrier = lastUserQuery ?? partitioned.userInfoMessage ?? partitioned.systemMessage
    const summaryPrivacyMode = privacyCarrier!._privacyMode ?? this.stateHandler.getPrivacyMode()
    return {
      message: toRedactedCoreMessage({
        role: "user",
        content: summaryBody,
        providerOptions: { slate: { isSummary: true } },
      }, summaryPrivacyMode),
      summaryTextLength: summaryBody.length,
    }
  }

  /** The summary goes last: the preserved tail is what the model was about to answer, and it answers it. */
  rebuildConversation(
    partitioned: SelfSummaryPartition,
    summaryEntry: RedactedCoreMessage,
  ): readonly RedactedCoreMessage[] {
    if (!partitioned.systemMessage) throw new Error("Expected system message in conversation")
    return [
      partitioned.systemMessage,
      ...(partitioned.userInfoMessage ? [partitioned.userInfoMessage] : []),
      ...partitioned.preservedTailMessages,
      summaryEntry,
    ]
  }

  async summarize(
    ctx: Context,
    messages: readonly RedactedCoreMessage[],
    options: SummaryRunOptions,
  ): Promise<Record<string, unknown>> {
    using spanContext = createSpan(ctx.withName("SelfSummarizer.summarize"))
    const workCtx = spanContext.ctx
    const startTime = performance.now()
    logger.info(workCtx, "[self-summary] SelfSummarizer.summarize starting", {
      summarization: { messageCount: messages.length, modelId: this.modelId },
    })
    try {
      const pipelineOutcome = await runSummaryPass(this, workCtx, messages, options)
      const summaryCode = createRedactedString(
        pipelineOutcome.rawSummary.text,
        DataClassification.CODE,
        "summary",
        this.stateHandler.getPrivacyMode(),
      )
      logger.info(workCtx, "[self-summary] SelfSummarizer.summarize completed", {
        summarization: {
          summaryTextLength: pipelineOutcome.rawSummary.text.length,
          fullReplacementMessagesCount: pipelineOutcome.fullReplacementMessages.length,
          messagesActuallySummarizedCount: pipelineOutcome.messagesActuallySummarized.length,
        },
      })
      return {
        ...pipelineOutcome,
        summary: { summary: summaryCode },
        // The count is what tells the model how many times this request has been summarized.
        onPersisted: () => { this.stateHandler.incrementSelfSummaryCount() },
      }
    } finally {
      selfSummaryTimeTakenMs.histogram(
        workCtx,
        performance.now() - startTime,
        getMembershipTypeMetricTagsFromContext(workCtx),
      )
    }
  }
}
