/**
 * Turning a conversation into a summary, and putting back what a summary cannot carry.
 *
 * Summarizing is a prompt like any other, and it fails like one: the input can exceed the model's limit,
 * the output can be cut off at its own cap, and the provider can be transiently unavailable. So the work
 * is a retry loop with a directive per failure — retry after a delay, ask for a shorter summary, or shrink
 * the input — and the input shrinking is done by halving the prompt budget and, on the last attempt,
 * removing characters the provider cannot print. The prompt itself is assembled from the messages as a
 * transcript, and if it does not fit the budget it is truncated fairly: every message keeps a share rather
 * than the tail winning outright, and what was dropped is named in the prompt.
 *
 * What is summarized is a decision of its own. The system message and the user's profile are not part of
 * the conversation and are kept aside; the messages up to the last user message are summarized; the tail
 * after it is preserved, because the model is about to answer it. The summary replaces the summarized
 * stretch as a single carrier message, with the mode, the root, the plan, the transcript and the todo list
 * put back around it, since those are not messages and a summary would lose them.
 *
 * When every attempt has failed there is one more answer: a summary built without a model at all, which is
 * the transcript itself truncated to a share of the context window. It is worse than a written summary and
 * better than losing the conversation, and it is only used when the caller asked for it and the failure was
 * not a cancellation.
 *
 * Everything about a run is measured — attempts, failures by kind, tokens, the length of what was written,
 * how much was compressed, and how long the conversation was blocked — because summarization is where a
 * session's cost and latency concentrate.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { InputTokenLimitError } from "../chat-inference/prompt-executor.ts"
import type { Context } from "../context/context.ts"
import { createLogger } from "../context/logging.ts"
import { createCounter, createHistogram } from "../metrics/index.ts"
import { DataClassification, PrivacyCapability } from "../redaction/classification.ts"
import {
  fromRedactedCoreMessage,
  toRedactedCoreMessage,
  type CoreMessageLike,
} from "../redaction/message-redaction.ts"
import { createRedactedString } from "../redaction/create.ts"
import { PrivacyMode } from "../redaction/privacy-mode.ts"
import { isRedactedString, type RedactedString } from "../redaction/redacted-values.ts"
import { BackgroundSummarizationMode } from "./background-summarization.ts"
import {
  composeTranscriptSnapshot,
  maximumTranscriptSnapshotChars,
  DEFAULT_TRANSCRIPT_SNAPSHOT_SHARE,
} from "./deterministic-summary-builder.ts"
import {
  appendDurableBlocks,
  renderDurableBlocks,
  type DurableBlockEnrichments,
} from "./durable-blocks.ts"
import { CannotTruncatePromptError, getRetryDirective } from "./error-handling.ts"
import {
  findLatestImagePart,
  toUserMessageImagePart,
  type SummarizationImageMessage,
} from "./latest-image.ts"
import {
  runSummaryPass,
  type SummaryCarryData,
  type SummaryRunOptions,
} from "./pipeline.ts"
import { prepareMessagesForCompaction } from "./prepare-messages.ts"
import {
  formatOmittedMessagesPreamble,
  MAX_SUMMARIZATION_PROMPT_CHARS,
  truncatePromptFairly,
} from "./prompt-truncation.ts"
import { collectAttachedSkillBlocksFromConversation } from "../../adapters/interop/agent/compaction-skill-message-adapter.ts"

export type RedactedCoreMessage = ReturnType<typeof toRedactedCoreMessage>

interface ResponseMessageLike {
  readonly role: string
  readonly content: string | { readonly type: string; readonly text?: string | undefined }[]
}

interface StreamingCallResult {
  readonly fullStream: AsyncIterable<unknown>
  readonly extendedUsage: Promise<{ readonly inputTokens?: number | undefined; readonly outputTokens?: number | undefined }>
  readonly usage: Promise<unknown>
  readonly providerMetadata: Promise<unknown>
  readonly invocationId: Promise<unknown>
  readonly response: Promise<{ readonly messages: readonly ResponseMessageLike[] }>
}

interface PromptExecutor {
  stream(
    context: Context,
    request?: unknown,
    tools?: unknown,
    options?: { readonly maxTokens?: number | undefined },
  ): StreamingCallResult
}

export interface SummarizationPromptSession {
  getExecutor(messages: readonly CoreMessageLike[]): PromptExecutor
  getModelId(): string
}

export interface SummarizationCancellationToken {
  readonly cancelled: boolean
}

export interface SummarizationHandlerOptions {
  readonly enableReduceInputsRetry?: boolean | undefined
  readonly enableRetryUncategorizedErrors?: boolean | undefined
  readonly throwOnRetryExhaustion?: boolean | undefined
  readonly maxPromptChars?: number | undefined
  readonly useRelaxedSplitIndexGuard?: boolean | undefined
  readonly preserveLastUserMessage?: boolean | undefined
  readonly alwaysRetryOutputTokenLimit?: boolean | undefined
  readonly preserveLatestImage?: boolean | undefined
  readonly promptSuffix?: string | undefined
  readonly metricsModelLabel?: string | undefined
  readonly enableDeterministicFallback?: boolean | undefined
  readonly deterministicFallbackWindowRatio?: number | undefined
  readonly maxOutputTokens?: number | undefined
}

export interface SummarizationRunOptions extends SummaryRunOptions {
  readonly backgroundSummarizationMode: BackgroundSummarizationMode
  readonly triggerReason: string
  readonly contextWindowTokens?: number | undefined
  readonly enableRetryOutputTokenLimit?: boolean | undefined
  readonly cancellationToken?: SummarizationCancellationToken | undefined
}

export interface SummarizationRawResult {
  readonly text: string
  readonly inputTokens: number | undefined
  readonly outputTokens: number | undefined
  readonly hadError: boolean
  readonly errorKind?: string | undefined
}

interface PartitionedConversation {
  readonly systemMessage: RedactedCoreMessage | undefined
  readonly userInfoMessage: RedactedCoreMessage | undefined
  readonly messagesToSummarize: readonly RedactedCoreMessage[]
  readonly preservedTailMessages: readonly RedactedCoreMessage[]
  readonly skillBlocks: readonly string[]
}

const handlerLog = createLogger("summarization-handler")
const TOOL_PART_CHAR_LIMIT = 100_000
const PROMPT_BYTE_LIMIT = 9 * 1024 * 1024
const PROMPT_BYTE_CAP = PROMPT_BYTE_LIMIT
const MAX_ATTEMPTS = 3
const TRANSIENT_RETRY_DELAY_MS = 2_000
const MIN_PROMPT_CHARS = 50_000
const INPUT_TOKEN_WARN = 900_000
const OUTPUT_TOKEN_WARN = 18_000
export const SHORTER_OUTPUT_RETRY_PROMPT = `
	
Additional instruction: Write a shorter summary that focuses on the highest-signal context. Avoid long code snippets and avoid unnecessarily exhaustive detail. Prioritize the most recent user intent, recent implementation work, and unresolved blockers.
IMPORTANT: When listing user messages, you do not need to repeat each message verbatim. Concisely capture user intent.`
export const SUMMARIZATION_PROVIDER_OPTIONS = {
  slate: {
    inferenceReason: "agent-summarization",
    featureType: "agenticComposerSummary",
  },
}

/**
 * One summarization call, with every promise the executor hands back consumed so a rejection cannot go
 * unhandled — the answer itself comes from the last assistant message, since a provider that emits several
 * would otherwise have them concatenated.
 */
async function runSummarizationCall(
  context: Context,
  session: SummarizationPromptSession,
  prompt: string,
  outputCap: number | undefined,
): Promise<{ text: string; inputTokens: number | undefined; outputTokens: number | undefined }> {
  const promptExecutor = session.getExecutor([
    { role: "system", content: SYSTEM_PROMPT_TEXT },
    {
      role: "user",
      content: prompt,
      providerOptions: SUMMARIZATION_PROVIDER_OPTIONS,
    },
  ])
  const callOptions = outputCap !== undefined ? { maxTokens: outputCap } : {}
  const call = promptExecutor.stream(context, undefined, undefined, callOptions)
  const fields = { promptLength: prompt.length, maxOutputTokens: outputCap }
  call.extendedUsage.catch(error => {
    handlerLog.error(context, "[summarization-handler] Error getting extended usage", error, {
      summarization: fields,
    })
  })
  call.usage.catch(error => {
    handlerLog.error(context, "[summarization-handler] Error getting usage", error, {
      summarization: fields,
    })
  })
  call.providerMetadata.catch(error => {
    handlerLog.error(context, "[summarization-handler] Error getting provider metadata", error, {
      summarization: fields,
    })
  })
  call.invocationId.catch(error => {
    handlerLog.error(context, "[summarization-handler] Error getting invocation id", error, {
      summarization: fields,
    })
  })
  call.response.catch(error => {
    handlerLog.error(context, "[summarization-handler] Error getting response", error, {
      summarization: fields,
    })
  })
  for await (const _chunk of call.fullStream) {
    // The stream must be consumed before its response promises settle.
  }
  const response = await call.response
  const assistantReplies = response.messages.filter(message => message.role === "assistant")
  if (assistantReplies.length > 1) {
    handlerLog.warn(
      context,
      "[summarization-handler] Summarization response contained more than one assistant message; using only the last to avoid duplicated summaries",
      {
        summarization: {
          ...fields,
          assistantMessageCount: assistantReplies.length,
        },
      },
    )
  }
  const lastReply = assistantReplies.at(-1)
  const replyText = lastReply === undefined
    ? ""
    : Array.isArray(lastReply.content)
      ? lastReply.content.map(content => content.type === "text" ? content.text : "").join("")
      : lastReply.content
  let inputTokens: number | undefined
  let outputTokens: number | undefined
  try {
    const extendedUsage = await call.extendedUsage
    inputTokens = extendedUsage.inputTokens
    outputTokens = extendedUsage.outputTokens
  } catch {
    // Usage is optional and has already been logged above.
  }
  if (replyText.trim().length === 0) throw new Error("Summarization returned empty text")
  return { text: replyText, inputTokens, outputTokens }
}

/** A tool call or result is bounded before it reaches the prompt, since one of them can be enormous. */
function guardToolPart(prefix: string, serializedValue: string): string {
  if (serializedValue.length > TOOL_PART_CHAR_LIMIT) {
    const truncated = serializedValue.slice(0, TOOL_PART_CHAR_LIMIT)
    return `${prefix} ${truncated}\n[... truncated, ${serializedValue.length} total chars]`
  }
  return `${prefix} ${serializedValue}`
}

export function turnMessageToString(
  redactedSource: RedactedCoreMessage,
  guarded: boolean,
): string {
  const message = fromRedactedCoreMessage(
    redactedSource,
    PrivacyCapability.UNSAFE_ALWAYS_ALLOWED,
  )
  const body = message.content
  if (!Array.isArray(body)) return body as string
  return body.map(piece => {
    if (piece.type === "text") return piece.text as string
    if (piece.type === "image") return "[Image]"
    if (piece.type === "file") return "[File]"
    if (piece.type === "reasoning") return `[Thinking] ${piece.text as string}`
    if (piece.type === "redacted-reasoning") return "[Thinking]"
    if (piece.type === "tool-call") {
      const argsText = JSON.stringify(piece.args) ?? "null"
      return guarded
        ? guardToolPart(`[Tool call] ${piece.toolName as string}`, argsText)
        : `[Tool call] ${piece.toolName as string} ${argsText}`
    }
    if (piece.type === "tool-result") {
      const resultText = JSON.stringify(piece.result) ?? "null"
      return guarded
        ? guardToolPart(`[Tool result] ${piece.toolName as string}`, resultText)
        : `[Tool result] ${piece.toolName as string} ${resultText}`
    }
    return ""
  }).join("\n\n")
}

interface PromptBudgetOptions {
  readonly requestShorterOutput?: boolean | undefined
  readonly promptSuffix?: string | undefined
  readonly maxPromptChars?: number | undefined
}

/**
 * The prompt the summarizer reads, truncated when it does not fit.
 *
 * The budget is in characters, but the provider's limit is in bytes, so a prompt that is close to the byte
 * limit is given a smaller character budget first — with the ratio measured from the prompt itself, since a
 * conversation of one script is not the same size as another. Truncation only happens when the caller asked
 * for a budget at all; a prompt that fits is sent as it is.
 */
function assemblePrompt(
  context: Context,
  conversation: readonly RedactedCoreMessage[],
  settings?: PromptBudgetOptions,
): { prompt: string; didTruncate: boolean } {
  const closingTag = `\n<summarization_request>${SUMMARY_INSTRUCTIONS}${settings?.requestShorterOutput ? SHORTER_OUTPUT_RETRY_PROMPT : ""}${settings?.promptSuffix ?? ""}</summarization_request>`
  const lines = conversation.map(message => `${message.role}: ${turnMessageToString(message, true)}`)
  const wholePrompt = lines.join("\n\n") + closingTag
  let budget = settings?.maxPromptChars ?? MAX_SUMMARIZATION_PROMPT_CHARS
  const wholeBytes = Buffer.byteLength(wholePrompt, "utf-8")
  let byteAdjusted = false
  let previousBudget = -1
  if (wholeBytes > PROMPT_BYTE_CAP) {
    const estimatedRatio = wholeBytes / wholePrompt.length
    const budgetRatio = PROMPT_BYTE_CAP / budget
    if (estimatedRatio > budgetRatio * 0.95) {
      const nextBudget = Math.floor(PROMPT_BYTE_CAP / estimatedRatio * 0.8)
      handlerLog.info(context, "[summarization-handler] Reducing prompt budget due to byte limit", {
        summarization: {
          byteAdjustment: {
            anticipatedBytesPerChar: estimatedRatio,
            currentBytesPerChar: budgetRatio,
            oldPromptBudget: budget,
            newPromptBudget: nextBudget,
          },
        },
      })
      previousBudget = budget
      budget = nextBudget
      byteAdjusted = true
    }
  }
  if (wholePrompt.length > budget) {
    handlerLog.info(context, "[summarization-handler] Would truncate summarization prompt", {
      summarization: {
        promptTruncation: {
          totalMessages: conversation.length,
          fullPromptLength: wholePrompt.length,
          lastSerializedMessageLength: lines.at(-1)?.length ?? 0,
          didByteAdjust: byteAdjusted,
          promptBudget: budget,
        },
      },
    })
  }
  const mayTruncate = settings?.maxPromptChars !== undefined
  if (!mayTruncate || wholePrompt.length <= budget) {
    return { prompt: wholePrompt, didTruncate: false }
  }
  const speakerRoles = conversation.map(message => message.role)
  const fairResult = truncatePromptFairly({
    ctx: context,
    serialized: lines,
    roles: speakerRoles,
    suffix: closingTag,
    charBudget: budget,
  })
  // A prompt that cannot hold even one message is not a prompt, so the caller is told rather than sent one.
  if (fairResult === null) {
    handlerLog.warn(context, "[summarization-handler] failed to build summarization prompt", {
      summarization: {
        totalMessages: conversation.length,
        originalChars: wholePrompt.length,
        promptBudget: budget,
      },
    })
    throw new CannotTruncatePromptError(
      "Cannot fit any summarization message within prompt char budget",
      { totalMessages: conversation.length, originalChars: wholePrompt.length, budgetChars: budget },
    )
  }
  const { resultParts: keptParts, droppedCount: dropped, truncatedCount: shortened, fullCount: keptWhole } = fairResult
  const joiner = "\n\n"
  const omittedNote = dropped > 0 ? formatOmittedMessagesPreamble(dropped) : ""
  const body = keptParts.join(joiner)
  const fitted = omittedNote + body + closingTag
  if (body.length < 500) {
    handlerLog.warn(context, "[summarization-handler] Suspiciously short joined result length for summarization", {
      summarization: { joinedResultLength: body.length },
    })
  }
  const fittedBytes = Buffer.byteLength(fitted, "utf-8")
  if (fittedBytes > PROMPT_BYTE_CAP) {
    handlerLog.warn(context, "[summarization-handler] Final prompt exceeded byte budget", {
      summarization: {
        adjustmentInfo: {
          promptBudget: budget,
          originalPromptBytes: wholeBytes,
          originalPromptLength: wholePrompt.length,
          finalPromptLength: fitted.length,
          fittedBytes,
          maxPromptBytes: PROMPT_BYTE_CAP,
          didByteAdjust: byteAdjusted,
          oldPromptBudget: previousBudget,
        },
      },
    })
  }
  handlerLog.info(context, "[summarization-handler] Summarization prompt exceeded char budget; truncated", {
    summarization: {
      promptTruncation: {
        totalMessages: conversation.length,
        fullyDroppedMessages: dropped,
        truncatedMessages: shortened,
        originalMessagesCount: keptWhole,
        originalPromptLength: wholePrompt.length,
        originalPromptBytes: wholeBytes,
        originalLastMessageLength: lines.at(-1)?.length ?? 0,
        finalPromptBytes: fittedBytes,
        finalPromptLength: fitted.length,
        promptBudget: budget,
        didByteAdjust: byteAdjusted,
      },
    },
  })
  return { prompt: fitted, didTruncate: true }
}

/** A control character that is not a newline, a carriage return or a tab is not text a provider can read. */
function dropNonPrintable(input: string): string {
  return input.replace(/[^\P{Cc}\n\r\t]/gu, "")
}

/** Each attempt shrinks the budget harder, and never below what a prompt needs to be useful. */
function shrinkPromptBudget(options: {
  readonly current: number
  readonly attempt: number
  readonly originalPromptLength?: number | undefined
}): number {
  const divisor = options.attempt >= 2 ? 3 : 2
  let next = Math.floor(options.current / divisor)
  if (options.originalPromptLength !== undefined) {
    next = Math.min(next, Math.floor(options.originalPromptLength * 0.75))
  }
  return Math.max(MIN_PROMPT_CHARS, next)
}

interface AttemptOptions {
  readonly metricsModelLabel?: string | undefined
  readonly backgroundSummarizationMode: BackgroundSummarizationMode
  readonly triggerReason: string
  readonly maxPromptChars?: number | undefined
  readonly maxOutputTokens?: number | undefined
  readonly promptSuffix?: string | undefined
  readonly cancellationToken?: SummarizationCancellationToken | undefined
  readonly isFallbackToMainModel: boolean
  readonly enableReduceInputsRetry?: boolean | undefined
  readonly enableRetryUncategorizedErrors?: boolean | undefined
  readonly enableRetryOutputTokenLimit?: boolean | undefined
  readonly throwOnRetryExhaustion?: boolean | undefined
}

/**
 * The retry loop. Each attempt may be told to ask for a shorter answer, to send a smaller prompt, or to wait
 * before trying again, and the loop ends when the attempts run out, when the caller cancels, or when the
 * failure is one the platform does not retry. Running out of attempts is not thrown unless the caller asked
 * for that: a summary that could not be written is reported as a result with the error kind on it.
 */
async function runSummarizationAttempts(
  context: Context,
  session: SummarizationPromptSession,
  conversation: readonly RedactedCoreMessage[],
  settings: AttemptOptions,
): Promise<SummarizationRawResult> {
  const metricsLabel = settings.metricsModelLabel ?? session.getModelId()
  const runFields = {
    summarizationMode: settings.backgroundSummarizationMode,
    triggerReason: settings.triggerReason,
    model: metricsLabel,
  }
  let budget = settings.maxPromptChars ?? MAX_SUMMARIZATION_PROMPT_CHARS
  let askShorter = false
  let lastKind: string | undefined
  const kinds: string[] = []
  let attemptsRun = 0
  let lastPromptLength: number | undefined
  let expectTruncation = false

  for (let tryNumber = 1; tryNumber <= MAX_ATTEMPTS; tryNumber++) {
    if (settings.cancellationToken?.cancelled) break
    attemptsRun++
    try {
      handlerLog.info(context, "[summarization-handler] Attempt started", {
        summarization: {
          ...runFields,
          attempt: tryNumber,
          maxRetries: MAX_ATTEMPTS,
          promptBudget: budget,
          requestShorterOutput: askShorter,
        },
      })
      tryAttemptsCounter.increment(context)
      const promptOptions: PromptBudgetOptions = {
        requestShorterOutput: askShorter,
        promptSuffix: settings.promptSuffix,
        maxPromptChars: Math.min(budget, MAX_SUMMARIZATION_PROMPT_CHARS),
      }
      let { prompt, didTruncate: truncated } = assemblePrompt(
        context,
        conversation,
        promptOptions,
      )
      // The last tryNumber after an input-limit failure is the one that strips what the provider choked on.
      if (expectTruncation && tryNumber === MAX_ATTEMPTS) {
        const originalLength = prompt.length
        prompt = dropNonPrintable(prompt)
        const strippedChars = originalLength - prompt.length
        if (strippedChars > 0) {
          handlerLog.info(
            context,
            "[summarization-handler] Stripped non-printable characters from prompt on final input-limit retry",
            {
              summarization: {
                attempt: tryNumber,
                originalLength,
                strippedLength: prompt.length,
                strippedChars,
              },
            },
          )
        }
      }
      if (expectTruncation && !truncated) {
        handlerLog.warn(
          context,
          "[summarization-handler] Expected prompt truncation after input limit reduction but prompt fit within reduced budget",
          { summarization: { attempt: tryNumber, promptBudget: budget, promptLength: prompt.length, lastFailedPromptLength: lastPromptLength } },
        )
      }
      expectTruncation = false
      lastPromptLength = prompt.length
      const callResult = await runSummarizationCall(
        context,
        session,
        prompt,
        settings.maxOutputTokens,
      )
      handlerLog.info(context, "[summarization-handler] Attempt succeeded", {
        summarization: {
          ...runFields,
          attempt: tryNumber,
          contentLength: callResult.text.length,
          fullPromptLength: prompt.length,
          promptBudget: budget,
          didTruncate: truncated,
        },
      })
      trySuccessCounter.increment(context)
      attemptsCounter.increment(context, 1, {
        invocation: settings.backgroundSummarizationMode,
        triggerReason: settings.triggerReason,
      })
      successCounter.increment(context, 1, {
        invocation: settings.backgroundSummarizationMode,
        triggerReason: settings.triggerReason,
      })
      if (settings.isFallbackToMainModel) fallbackAttemptsCounter.increment(context)
      return { ...callResult, hadError: false }
    } catch (failure) {
      const allowInputShrink = settings.enableReduceInputsRetry ?? false
      const allowUnknownRetry = settings.enableRetryUncategorizedErrors ?? true
      const allowOutputLimitRetry = settings.enableRetryOutputTokenLimit ?? true
      const directive = getRetryDirective(failure, {
        transientRetryDelayMs: TRANSIENT_RETRY_DELAY_MS,
        enableReduceInputsRetry: allowInputShrink,
        enableRetryUncategorizedErrors: allowUnknownRetry,
        enableRetryOutputTokenLimit: allowOutputLimitRetry,
      })
      if (directive.reduceInputs) {
        handlerLog.info(context, "[summarization-handler] prompt guard did not reduce inputs enough", {
          summarization: {
            attempt: tryNumber,
            promptBudget: budget,
            lastFailedPromptLength: lastPromptLength,
            summarizationMode: settings.backgroundSummarizationMode,
            triggerReason: settings.triggerReason,
          },
        })
      }
      lastKind = directive.errorType
      kinds.push(directive.errorType)
      const retrying = directive.shouldRetry && tryNumber < MAX_ATTEMPTS
      tryFailuresCounter.increment(context, 1, {
        errorKind: directive.errorType,
        invocation: settings.backgroundSummarizationMode,
        triggerReason: settings.triggerReason,
      })
      handlerLog.error(context, "[summarization-handler] Error summarizing messages", failure, {
        summarization: {
          ...runFields,
          attempt: tryNumber,
          maxRetries: MAX_ATTEMPTS,
          errorType: directive.errorType,
          willRetry: retrying,
          retryDelayMs: directive.retryDelayMs,
          requestShorterOutput: directive.requestShorterOutput,
          reduceInputs: directive.reduceInputs,
          options: {
            enableReduceInputsRetry: allowInputShrink,
            enableRetryUncategorizedErrors: allowUnknownRetry,
            enableRetryOutputTokenLimit: allowOutputLimitRetry,
          },
        },
      })
      if (!retrying) break
      retriesCounter.increment(context, 1, { errorKind: directive.errorType })
      if (directive.requestShorterOutput) {
        askShorter = true
        handlerLog.info(context, "[summarization-handler] Retrying with shorter-output instruction", {
          summarization: { ...runFields, attempt: tryNumber },
        })
      }
      if (directive.reduceInputs) {
        const nextBudget = shrinkPromptBudget({
          current: budget,
          attempt: tryNumber,
          originalPromptLength: lastPromptLength,
        })
        handlerLog.info(context, "[summarization-handler] Retrying with reduced input budget", {
          summarization: {
            ...runFields,
            attempt: tryNumber,
            previousPromptBudget: budget,
            nextPromptBudget: nextBudget,
            lastFailedPromptLength: lastPromptLength,
          },
        })
        budget = nextBudget
        expectTruncation = true
      }
      if (directive.retryDelayMs > 0) {
        handlerLog.info(context, "[summarization-handler] Retrying after delay", {
          summarization: { ...runFields, attempt: tryNumber, retryDelayMs: directive.retryDelayMs },
        })
        await new Promise(resolve => setTimeout(resolve, directive.retryDelayMs))
        if (settings.cancellationToken?.cancelled) break
      }
    }
  }

  // A cancellation is reported as its own kind rather than as a failure of the model.
  const wasCancelled = settings.cancellationToken?.cancelled === true
  const kind = wasCancelled ? "Cancelled" : (lastKind ?? "UnknownError")
  if (wasCancelled) {
    handlerLog.info(context, "[summarization-handler] Summarization retries cancelled", {
      summarization: {
        ...runFields,
        attempts: attemptsRun,
        maxRetries: MAX_ATTEMPTS,
        errorKind: kind,
        errorKinds: kinds,
      },
    })
  } else {
    handlerLog.warn(context, "[summarization-handler] All retries exhausted", {
      summarization: {
        ...runFields,
        attempts: attemptsRun,
        maxRetries: MAX_ATTEMPTS,
        errorKind: kind,
        errorKinds: kinds,
      },
    })
  }
  attemptsCounter.increment(context, 1, {
    invocation: settings.backgroundSummarizationMode,
    triggerReason: settings.triggerReason,
  })
  failuresCounter.increment(context, 1, {
    errorKind: kind,
    invocation: settings.backgroundSummarizationMode,
    triggerReason: settings.triggerReason,
  })
  if (settings.isFallbackToMainModel) {
    fallbackAttemptsCounter.increment(context)
    fallbackFailuresCounter.increment(context, 1, {
      errorKind: kind,
      invocation: settings.backgroundSummarizationMode,
      triggerReason: settings.triggerReason,
    })
  }
  if (settings.throwOnRetryExhaustion && !wasCancelled) {
    throw new Error(`Summarization failed after ${attemptsRun} attempts (${kinds.join(", ")})`)
  }
  return {
    text: "No summary generated",
    inputTokens: undefined,
    outputTokens: undefined,
    hadError: true,
    errorKind: kind,
  }
}

const successCounter = createCounter("agent.summarization.success", {
  description: "Successful summarizations",
  labelNames: ["invocation", "triggerReason"],
})
const attemptsCounter = createCounter("agent.summarization.attempts", {
  description: "Total summarization attempts",
  labelNames: ["invocation", "triggerReason"],
})
const failuresCounter = createCounter("agent.summarization.failures", {
  description: "Failed summarizations",
  labelNames: ["errorKind", "invocation", "triggerReason"],
})
const tryAttemptsCounter = createCounter("agent.summarization.try.attempts", {
  description: "Per-try summarization attempts within the retry loop",
})
const trySuccessCounter = createCounter("agent.summarization.try.success", {
  description: "Per-try successful summarization attempts",
})
const tryFailuresCounter = createCounter("agent.summarization.try.failures", {
  description: "Per-try failed summarization attempts",
  labelNames: ["errorKind", "invocation", "triggerReason"],
})
const retriesCounter = createCounter("agent.summarization.retries", {
  description: "Total retries (attempts beyond the first) that actually executed",
  labelNames: ["errorKind"],
})
const summaryLengthHistogram = createHistogram("agent.summarization.summary_length_chars", {
  description: "Summary length in characters",
})
const blockingDurationHistogram = createHistogram("agent.summarization.summary_blocking_duration_ms", {
  description: "Blocking duration of summarization",
})
const inputTokensHistogram = createHistogram("agent.summarization.input_tokens", {
  description: "Input tokens consumed during summarization",
  labelNames: ["model"],
})
const outputTokensHistogram = createHistogram("agent.summarization.output_tokens", {
  description: "Output tokens generated during summarization",
  labelNames: ["model"],
})
const compressionHistogram = createHistogram("agent.summarization.compression_percent", {
  description: "Percentage of tokens removed by summarization: (input - output) / input * 100",
  labelNames: ["model"],
})
const originalLengthHistogram = createHistogram("agent.summarization.original_length_chars", {
  description: "Total character length of all messages before summarization",
  labelNames: ["model"],
})
const persistedLengthHistogram = createHistogram("agent.summarization.persisted_length_chars", {
  description: "Total character length of all messages persisted after summarization (system + userInfo + summary + preserved tail)",
  labelNames: ["model"],
})
const totalCompressionHistogram = createHistogram("agent.summarization.total_compression_percent", {
  description: "End-to-end compression percentage including preserved tail messages: (1 - persisted/original) * 100",
  labelNames: ["model"],
})
const deterministicFallbackCounter = createCounter(
  "agent.summarization.deterministic_fallback.used",
  {
    description: "WaitForCompletion summarizations that fell back to deterministic compaction after LLM retries exhausted",
    labelNames: ["errorKind", "triggerReason", "model"],
  },
)
const fallbackAttemptsCounter = createCounter("agent.summarization.fallback_attempts", {
  description: "Summarization attempts where all summarization models are blocked and the main model is used as fallback",
})
const fallbackFailuresCounter = createCounter("agent.summarization.fallback_failures", {
  description: "Failed summarizations where all summarization models are blocked and the main model is used as fallback",
  labelNames: ["errorKind", "invocation", "triggerReason"],
})
const lastTwoGapHistogram = createHistogram("agent.summarization.time_between_last_two_messages_ms", {
  description: "Time between last two messages in conversation",
})

const DEBUG_STRATEGY_FILE = path.join(os.homedir(), "debug-summarization-strategy.txt")

function hasToolInvocation(entry: CoreMessageLike): boolean {
  const body = entry.content
  if (!Array.isArray(body)) return false
  return body.some(part => part.type === "tool-call")
}

function isToolResult(entry: CoreMessageLike): boolean {
  if (entry.role !== "tool") return false
  const body = entry.content
  if (!Array.isArray(body)) return false
  return body.some(part => part.type === "tool-result")
}

/**
 * How a run can be forced to summarize, for the platform's own tests and evals.
 *
 * It is off in production unless the process says it is an evals service, and then a file in the home
 * directory says when to summarize: on the next human message, on the next tool result, or every N of
 * either. The file is removed once the strategy has fired, so a forced run does not repeat forever.
 */
export function shouldForceSummarizationForTesting(
  conversation: readonly CoreMessageLike[],
  evalMode: string | undefined,
): BackgroundSummarizationMode | undefined {
  if (process.env.NODE_ENV === "production" && process.env.IS_EVALS_SERVICE !== "true") return undefined
  if (conversation.length === 0) return undefined
  const newest = conversation[conversation.length - 1]!
  const newestIsUser = newest.role === "user"
  const newestIsToolResult = isToolResult(newest)
  const toolCallCount = conversation.filter(hasToolInvocation).length
  if (evalMode === "next-human") {
    return newestIsUser ? BackgroundSummarizationMode.WaitForCompletion : undefined
  }
  if (evalMode === "in-flight") {
    return BackgroundSummarizationMode.WaitForCompletionIfStarted
  }
  try {
    const rule = fs.readFileSync(DEBUG_STRATEGY_FILE, "utf8").trim()
    if (rule.startsWith("every-human")) {
      const humanCount = conversation.filter(message => message.role === "user").length
      const humanEvery = Number.parseInt(
        rule.includes(":") ? (rule.split(":")[1] ?? "1") : "1",
        10,
      )
      return Number.isFinite(humanEvery) &&
        humanEvery > 0 &&
        newestIsUser &&
        humanCount % humanEvery === 0
        ? BackgroundSummarizationMode.WaitForCompletion
        : undefined
    }
    if (rule === "next-human") {
      if (newestIsUser) fs.rmSync(DEBUG_STRATEGY_FILE)
      return newestIsUser ? BackgroundSummarizationMode.WaitForCompletion : undefined
    }
    if (rule === "next-tool") {
      if (newestIsToolResult) fs.rmSync(DEBUG_STRATEGY_FILE)
      return newestIsToolResult ? BackgroundSummarizationMode.WaitForCompletion : undefined
    }
    if (rule.startsWith("every-tool")) {
      const toolEvery = Number.parseInt(
        rule.includes(":") ? (rule.split(":")[1] ?? "1") : "1",
        10,
      )
      return Number.isFinite(toolEvery) &&
        toolEvery > 0 &&
        newestIsToolResult &&
        toolCallCount % toolEvery === 0
        ? BackgroundSummarizationMode.WaitForCompletion
        : undefined
    }
  } catch {
    // Debug forcing is deliberately best-effort.
  }
  return undefined
}

const SYSTEM_PROMPT_TEXT = "You are an intelligent assistant, tasked with summarizing the following conversation. You MUST follow the instructions given in the <summarization_request> tags and summarize the conversation. This summary will be provided to another AI assistant to continue the task at hand, so you should align the summary with the task in the conversation."
const SUMMARY_CARRIER_PREFIX = "[Previous conversation summary]:"
const PRESERVED_IMAGE_NOTE = "[Latest screenshot]: The image below is the most recent screenshot from the summarized conversation, captured before the summary above was created. Use it to continue from the last known visual state; take a fresh screenshot if you need to confirm the current state."
const SUMMARY_INSTRUCTIONS = `What you see above is the conversation so far, rendered as a transcript. Previous user messages, previous assistant messages, and tool calls are shown in tags, while the original system prompt has been removed. The content in the tags has been rendered exactly as it was in the original conversation.

Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions. This summary will be provided to another AI assistant to continue the task at hand, so you should align the summary with the task in the conversation above. So you should NEVER refer to summarization in your summary, just an output that could be used to continue the task.

This summary should be thorough in capturing technical details, code patterns, and architectural decisions
that would be essential for continuing development work without losing context.

1. Chronologically analyze each message and section of the conversation. For each section thoroughly identify:
   - The user's explicit requests and intents
   - Your approach to addressing the user's requests
   - Key decisions, technical concepts and code patterns
   - Specific details like:
   - file names
   - full code snippets
   - function signatures
   - file edits
- Errors that you ran into and how you fixed them
- Pay special attention to specific user feedback that you received, especially if the user told you to do
something differently.
2. Double-check for technical accuracy and completeness, addressing each required element thoroughly.

Your summary should include the following sections:

1. Primary Request and Intent: Capture all of the user's explicit requests and intents in detail
2. Key Technical Concepts: List all important technical concepts, technologies, and frameworks discussed.
3. Files and Code Sections: Enumerate specific files and code sections examined, modified, or created. Pay special attention to the most recent messages and include full code snippets where applicable and include a summary of why this file read or edit is important.
4. Errors and fixes: List all errors that you ran into, and how you fixed them. Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
5. Problem Solving: Document problems solved and any ongoing troubleshooting efforts.
6. All user messages: List ALL user messages that are not tool results or subagent prompts/results. These are critical for understanding the users' feedback and changing intent.
7. Pending Tasks: Outline any pending tasks that you have explicitly been asked to work on.
8. Current Work: Describe in detail precisely what was being worked on immediately before this summary request, paying special attention to the most recent messages from both user and assistant. Include file names and code snippets where applicable.
9. Optional Next Step: List the next step that you will take that is related to the most recent work you were doing. IMPORTANT: ensure that this step is DIRECTLY in line with the user's explicit requests, and the task you were working on immediately before this summary request. If your last task was concluded, then only list next steps if they are explicitly in line with the users request. Do not start on tangential requests or really old requests that were already completed.

If there is a next step, include direct quotes from the most recent conversation
showing exactly what task you were working on and where you left off. This should be verbatim to ensure
there's no drift in task interpretation.

Here's an example of how your output should be structured:

<example>
Summary:
1. Primary Request and Intent:
   [Detailed description]

2. Key Technical Concepts:
   - [Concept 1]
   - [Concept 2]
   - [...]

3. Files and Code Sections:
   - [File Name 1]
      - [Summary of why this file is important]
      - [Summary of the changes made to this file, if any]
      - [Important Code Snippet]
   - [File Name 2]
      - [Important Code Snippet]
   - [...]

4. Errors and fixes:
   - [Detailed description of error 1]:
      - [How you fixed the error]
      - [User feedback on the error if any]
   - [...]

5. Problem Solving:
   [Description of solved problems and ongoing troubleshooting]

6. All user messages:
   - [Detailed non tool use, non subagent user message]
   - [...]

7. Pending Tasks:
   - [Task 1]
   - [Task 2]
   - [...]

8. Current Work:
   [Precise description of current work]

9. Optional Next Step:
   [Optional Next step to take]
</example>

Please provide your summary based on the conversation so far, following this structure and ensuring precision and thoroughness in your response.`

export class SummarizationHandler {
  declare readonly promptSession: SummarizationPromptSession
  declare readonly isFallbackToMainModel: boolean
  declare readonly enableReduceInputsRetry: boolean
  declare readonly enableRetryUncategorizedErrors: boolean
  declare readonly throwOnRetryExhaustion: boolean
  declare readonly maxPromptChars: number | undefined
  declare readonly useRelaxedSplitIndexGuard: boolean
  declare readonly preserveLastUserMessage: boolean
  declare readonly alwaysRetryOutputTokenLimit: boolean
  declare readonly preserveLatestImage: boolean
  declare readonly promptSuffix: string | undefined
  declare readonly metricsModelLabel: string | undefined
  declare readonly enableDeterministicFallback: boolean
  declare readonly deterministicFallbackWindowRatio: number
  declare readonly maxOutputTokens: number | undefined

  constructor(
    promptSession: SummarizationPromptSession,
    isFallbackToMainModel = false,
    options?: SummarizationHandlerOptions,
  ) {
    this.promptSession = promptSession
    this.isFallbackToMainModel = isFallbackToMainModel
    this.enableReduceInputsRetry = options?.enableReduceInputsRetry ?? false
    this.enableRetryUncategorizedErrors = options?.enableRetryUncategorizedErrors ?? true
    this.throwOnRetryExhaustion = options?.throwOnRetryExhaustion ?? false
    this.maxPromptChars = options?.maxPromptChars
    this.useRelaxedSplitIndexGuard = options?.useRelaxedSplitIndexGuard ?? false
    this.preserveLastUserMessage = options?.preserveLastUserMessage ?? true
    this.alwaysRetryOutputTokenLimit = options?.alwaysRetryOutputTokenLimit ?? true
    this.preserveLatestImage = options?.preserveLatestImage ?? false
    this.promptSuffix = options?.promptSuffix
    this.metricsModelLabel = options?.metricsModelLabel
    this.enableDeterministicFallback = options?.enableDeterministicFallback ?? false
    this.deterministicFallbackWindowRatio = options?.deterministicFallbackWindowRatio ??
      DEFAULT_TRANSCRIPT_SNAPSHOT_SHARE
    // A fallback to the main model is not given its own output cap, since the main model's limits apply.
    this.maxOutputTokens = this.isFallbackToMainModel ? undefined : options?.maxOutputTokens
  }

  getModelId(): string {
    return this.promptSession.getModelId()
  }

  getMetricsModelLabel(): string {
    return this.metricsModelLabel ?? this.promptSession.getModelId()
  }

  /**
   * What is summarized, what is kept, and what is set aside.
   *
   * The conversation is split at its last user message: everything up to and including it is summarized —
   * a summary that does not contain the request the model is about to answer is not worth writing — and
   * everything after it is preserved as the tail. Two guards apply. A split that lands at the very start is
   * not a split, so the whole conversation is summarized instead; and when the split leaves no tail at all,
   * the last user message is moved into the tail rather than being summarized away with everything else.
   */
  separateMessages(
    conversation: readonly RedactedCoreMessage[],
    runOptions: SummarizationRunOptions,
  ): PartitionedConversation {
    const { systemMessage, userInfoMessage, messagesForSummarization: candidates } =
      prepareMessagesForCompaction(conversation)
    let splitAt = -1
    for (let index = candidates.length - 1; index >= 0; index--) {
      if (candidates[index]!.role === "user") {
        splitAt = index
        break
      }
    }
    const guard = this.useRelaxedSplitIndexGuard ? 0 : 1
    if (splitAt <= guard || runOptions.fullSummarization) {
      splitAt = candidates.length
    }
    const keepLastUser = this.preserveLastUserMessage && runOptions.fullSummarization !== true
    const summarizeThrough = keepLastUser ? splitAt + 1 : splitAt
    const summarized = candidates.slice(0, summarizeThrough)
    let tail = candidates.slice(splitAt)
    if (keepLastUser && tail.length === 0 && summarized.length > 0) {
      let lastUserAt = -1
      for (let index = summarized.length - 1; index >= 0; index--) {
        const entry = summarized[index]!
        // A carrier entry is the platform's own text, not something the user said.
        const providerOptions = (entry.providerOptions as { slate?: { isSummary?: unknown } } | undefined)?.slate
        if (entry.role === "user" && providerOptions?.isSummary !== true) {
          lastUserAt = index
          break
        }
      }
      if (lastUserAt !== -1 && lastUserAt !== summarized.length - 1) {
        tail = [summarized[lastUserAt]!]
      }
    }
    const skills = collectAttachedSkillBlocksFromConversation(candidates)
    return {
      systemMessage,
      userInfoMessage,
      messagesToSummarize: summarized,
      preservedTailMessages: tail,
      skillBlocks: skills,
    }
  }

  async generateSummary(
    context: Context,
    conversationParts: PartitionedConversation,
    runOptions: SummarizationRunOptions,
  ): Promise<SummarizationRawResult> {
    const raw = await runSummarizationAttempts(
      context,
      this.promptSession,
      conversationParts.messagesToSummarize,
      {
        isFallbackToMainModel: this.isFallbackToMainModel,
        enableReduceInputsRetry: this.enableReduceInputsRetry,
        enableRetryUncategorizedErrors: this.enableRetryUncategorizedErrors,
        enableRetryOutputTokenLimit: runOptions.enableRetryOutputTokenLimit ?? this.alwaysRetryOutputTokenLimit,
        throwOnRetryExhaustion: this.throwOnRetryExhaustion,
        maxPromptChars: this.maxPromptChars,
        backgroundSummarizationMode: runOptions.backgroundSummarizationMode,
        triggerReason: runOptions.triggerReason,
        maxOutputTokens: this.maxOutputTokens,
        cancellationToken: runOptions.cancellationToken,
        promptSuffix: this.promptSuffix,
        metricsModelLabel: this.metricsModelLabel,
      },
    )
    // A summary nobody could write is still better than losing the conversation, when the caller allows it.
    if (this.shouldUseDeterministicFallback(raw) && conversationParts.messagesToSummarize.length > 0) {
      const fallbackText = this.buildDeterministicFallbackText(
        context,
        conversationParts,
        runOptions,
        raw.errorKind,
      )
      if (fallbackText !== null) return { ...raw, text: fallbackText }
    }
    return raw
  }

  /** A cancellation is the caller's own decision, so it is not answered with a substitute summary. */
  shouldUseDeterministicFallback(raw: SummarizationRawResult): boolean {
    if (!this.enableDeterministicFallback || !raw.hadError) return false
    const errorKind = raw.errorKind
    if (errorKind === "Cancelled") return false
    if (errorKind?.toLowerCase().includes("abort")) return false
    return true
  }

  buildDeterministicFallbackText(
    ctx: Context,
    conversationParts: PartitionedConversation,
    runOptions: SummarizationRunOptions,
    kind: string | undefined,
  ): string | null {
    const metricsLabel = this.getMetricsModelLabel()
    const charBudget = maximumTranscriptSnapshotChars(
      runOptions.contextWindowTokens,
      this.deterministicFallbackWindowRatio,
    )
    const fallback = composeTranscriptSnapshot(ctx, conversationParts.messagesToSummarize, charBudget)
    if (fallback === null) {
      handlerLog.warn(
        ctx,
        "[summarization-handler] Deterministic fallback could not fit within budget; falling through to placeholder",
        {
          summarization: {
            model: metricsLabel,
            triggerReason: runOptions.triggerReason,
            backgroundSummarizationMode: runOptions.backgroundSummarizationMode,
            kind: kind ?? "unknown",
            contextWindowTokens: runOptions.contextWindowTokens,
            windowRatio: this.deterministicFallbackWindowRatio,
            charBudget,
            totalMessages: conversationParts.messagesToSummarize.length,
          },
        },
      )
      return null
    }
    deterministicFallbackCounter.increment(ctx, 1, {
      kind: kind ?? "unknown",
      triggerReason: runOptions.triggerReason,
      model: metricsLabel,
    })
    handlerLog.info(ctx, "[summarization-handler] Deterministic fallback produced summary", {
      summarization: {
        model: metricsLabel,
        triggerReason: runOptions.triggerReason,
        backgroundSummarizationMode: runOptions.backgroundSummarizationMode,
        kind: kind ?? "unknown",
        contextWindowTokens: runOptions.contextWindowTokens,
        windowRatio: this.deterministicFallbackWindowRatio,
        charBudget,
        fallbackTextLength: fallback.text.length,
        fullyPreservedMessageCount: fallback.wholeMessages,
        truncatedCount: fallback.shortenedMessages,
        droppedCount: fallback.omittedMessages,
        totalMessages: conversationParts.messagesToSummarize.length,
      },
    })
    return fallback.text
  }

  /**
   * The message that carries the summary in place of the conversation it replaced. It is marked as a
   * summary so the platform can tell it apart from something the user said, and the mode, root, plan,
   * transcript and todo list are appended to it, since those are not messages and would otherwise be lost.
   */
  formatSummaryCarrier(
    raw: SummarizationRawResult,
    conversationParts: PartitionedConversation,
    extra: SummaryCarryData,
  ): { message: RedactedCoreMessage; summaryTextLength: number } {
    const durableText = renderDurableBlocks(
      "external",
      extra as DurableBlockEnrichments,
    )
    const summaryBody = raw.text + appendDurableBlocks("external", durableText)
    const carrier = `${SUMMARY_CARRIER_PREFIX} ${summaryBody}`
    // The carrier is redacted like the conversation it replaces, using the first privacy mode it can find.
    const mode = conversationParts.systemMessage?._privacyMode ??
      conversationParts.messagesToSummarize[0]?._privacyMode ??
      PrivacyMode.UNSPECIFIED
    // The latest image is carried into the summaryBody only when the tail does not already have one.
    const image = this.preserveLatestImage &&
      findLatestImagePart(conversationParts.preservedTailMessages as readonly SummarizationImageMessage[]) === null
      ? findLatestImagePart(conversationParts.messagesToSummarize as readonly SummarizationImageMessage[])
      : null
    const carrierMessage: CoreMessageLike = image === null
      ? {
          role: "user",
          content: carrier,
          providerOptions: { slate: { isSummary: true } },
        }
      : {
          role: "user",
          content: [
            { type: "text", text: carrier },
            { type: "text", text: PRESERVED_IMAGE_NOTE },
            toUserMessageImagePart(image),
          ],
          providerOptions: { slate: { isSummary: true } },
        }
    return {
      message: toRedactedCoreMessage(carrierMessage, mode),
      summaryTextLength: carrier.length,
    }
  }

  /** What the conversation becomes: the two messages that were set aside, the summaryBody, and the tail. */
  rebuildConversation(
    conversationParts: PartitionedConversation,
    carrier: RedactedCoreMessage,
  ): readonly RedactedCoreMessage[] {
    return [
      ...(conversationParts.systemMessage ? [conversationParts.systemMessage] : []),
      ...(conversationParts.userInfoMessage ? [conversationParts.userInfoMessage] : []),
      carrier,
      ...conversationParts.preservedTailMessages,
    ]
  }

  async summarize(
    context: Context,
    conversation: readonly RedactedCoreMessage[],
    runOptions: SummarizationRunOptions,
  ): Promise<{
    messagesActuallySummarized: readonly RedactedCoreMessage[]
    newSummaryMessage: RedactedCoreMessage
    preservedOriginalTailMessages: readonly RedactedCoreMessage[]
    fullReplacementMessages: readonly RedactedCoreMessage[]
    rawSummary: SummarizationRawResult
    summaryTextLength: number
    summary: { summary: RedactedString }
    hadError: boolean
    errorKind: string | undefined
  }> {
    // Both of these are warnings rather than failures: the summary is still worth writing.
    if (!conversation.find(message => message.role === "system")) {
      handlerLog.warn(context, "Compaction input has no system message", {
        summarization: { messagesCount: conversation.length },
      })
    }
    const { userInfoMessage } = prepareMessagesForCompaction(conversation)
    if (!userInfoMessage) {
      handlerLog.warn(context, "Compaction input has no userInfo message", {
        summarization: { messagesCount: conversation.length },
      })
    }
    const runFields = {
      summarizationMode: runOptions.backgroundSummarizationMode,
      triggerReason: runOptions.triggerReason,
      model: this.getMetricsModelLabel(),
    }
    const startedAt = performance.now()
    let gapMs: number | undefined
    if (conversation.length >= 2) {
      const newest = conversation[conversation.length - 1]!
      const previous = conversation[conversation.length - 2]!
      if ("timestamp" in newest && "timestamp" in previous) {
        const newestAt = newest.timestamp
        const previousAt = previous.timestamp
        if (typeof newestAt === "number" && typeof previousAt === "number") {
          gapMs = newestAt - previousAt
        }
      }
    }
    try {
      const outcome = await runSummaryPass(this, context, conversation, runOptions)
      const { rawSummary, summaryTextLength } = outcome
      const durationMs = performance.now() - startedAt
      this.recordMetrics(context, {
        rawSummary,
        durationMs,
        timeBetweenMessages: gapMs,
        originalMessages: conversation,
        fullReplacementMessages: outcome.fullReplacementMessages,
        summaryTextLength,
      })
      // The summaryValue is read back off the carrier message so what is reported is what was stored.
      const carrierContent = outcome.newSummaryMessage.content
      let text: RedactedString | undefined
      if (isRedactedString(carrierContent)) {
        text = carrierContent
      } else if (Array.isArray(carrierContent)) {
        for (const part of carrierContent) {
          if (part.type === "text" && isRedactedString(part.text)) {
            text = part.text
            break
          }
        }
      }
      const prefix = `${SUMMARY_CARRIER_PREFIX} `
      const summaryValue = text !== undefined
        ? text.safeTransform(summaryText =>
            summaryText.startsWith(prefix)
              ? summaryText.slice(prefix.length)
              : summaryText)
        : createRedactedString(
            outcome.rawSummary.text,
            DataClassification.CODE,
            "summary",
            conversation[0]?._privacyMode ?? PrivacyMode.UNSPECIFIED,
          )
      const failed = outcome.rawSummary.hadError === true
      handlerLog.info(context, "[summarization-handler] Summarization completed", {
        summarization: {
          ...runFields,
          durationMs,
          hadError: failed,
          errorKind: outcome.rawSummary.errorKind,
        },
      })
      return {
        ...outcome,
        summary: { summary: summaryValue },
        hadError: failed,
        errorKind: outcome.rawSummary.errorKind,
      }
    } catch (failure) {
      const durationMs = performance.now() - startedAt
      blockingDurationHistogram.histogram(context, durationMs)
      if (gapMs !== undefined) {
        lastTwoGapHistogram.histogram(context, gapMs)
      }
      handlerLog.error(context, "[summarization-handler] Summarize pipeline failed", failure, {
        summarization: runFields,
      })
      throw failure
    }
  }

  recordMetrics(
    context: Context,
    measurements: {
      readonly rawSummary: SummarizationRawResult
      readonly durationMs: number
      readonly timeBetweenMessages: number | undefined
      readonly originalMessages: readonly RedactedCoreMessage[]
      readonly fullReplacementMessages: readonly RedactedCoreMessage[]
      readonly summaryTextLength: number
    },
  ): void {
    const { rawSummary: raw, durationMs: elapsed, timeBetweenMessages: gapMs } = measurements
    blockingDurationHistogram.histogram(context, elapsed)
    summaryLengthHistogram.histogram(context, measurements.summaryTextLength)
    const modelLabel = this.getMetricsModelLabel()
    if (raw.inputTokens !== undefined) {
      inputTokensHistogram.histogram(context, raw.inputTokens, { model: modelLabel })
      if (raw.inputTokens > INPUT_TOKEN_WARN) {
        handlerLog.warn(context, "[summarization-handler] Summarization input tokens are very high", {
          summarization: {
            inputTokens: raw.inputTokens,
            outputTokens: raw.outputTokens,
            elapsed,
            modelLabel,
          },
        })
      }
    }
    if (raw.outputTokens !== undefined) {
      outputTokensHistogram.histogram(context, raw.outputTokens, { model: modelLabel })
      if (raw.outputTokens > OUTPUT_TOKEN_WARN) {
        handlerLog.warn(context, "[summarization-handler] Summarization output tokens are very high", {
          summarization: {
            inputTokens: raw.inputTokens,
            outputTokens: raw.outputTokens,
            elapsed,
            modelLabel,
          },
        })
      }
    }
    if (
      raw.inputTokens !== undefined &&
      raw.outputTokens !== undefined &&
      raw.inputTokens > 0
    ) {
      const percentRemoved = (raw.inputTokens - raw.outputTokens) /
        raw.inputTokens * 100
      compressionHistogram.histogram(context, percentRemoved, { model: modelLabel })
    }
    if (gapMs !== undefined) {
      lastTwoGapHistogram.histogram(context, gapMs)
    }
    // The end-to-end figure counts the tail that was kept, since that is what the conversation costs.
    const originalLengthChars = this.totalRawSerializedCharLength(measurements.originalMessages)
    const persistedLengthChars = this.totalRawSerializedCharLength(measurements.fullReplacementMessages)
    originalLengthHistogram.histogram(context, originalLengthChars, { model: modelLabel })
    persistedLengthHistogram.histogram(context, persistedLengthChars, { model: modelLabel })
    if (originalLengthChars > 0) {
      const compressionPercent = (originalLengthChars - persistedLengthChars) /
        originalLengthChars * 100
      totalCompressionHistogram.histogram(context, compressionPercent, { model: modelLabel })
    }
  }

  totalRawSerializedCharLength(conversation: readonly RedactedCoreMessage[]): number {
    let chars = 0
    for (const message of conversation) chars += turnMessageToString(message, false).length
    return chars
  }

  static isTokenLimitError(cause: unknown): boolean {
    return cause instanceof InputTokenLimitError
  }
}
