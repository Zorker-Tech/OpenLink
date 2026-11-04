/**
 * Deciding when to summarize, and making the result the conversation.
 *
 * Summarizing is expensive, so it is done when the conversation is close to the model's limit rather than
 * at every turn — and it can be done in the background, while the model is still working, which is why the
 * orchestrator has states at all. A run can be started and left to finish on its own; it can be waited for;
 * it can be waited for only if one was already started; or it can be persisted if it happens to have
 * finished. What those modes share is that the summary is only adopted once its work is complete and its
 * prefix still matches the conversation: a summary written against a conversation that has since changed
 * describes something that no longer exists, so it is discarded and counted as such.
 *
 * The work itself is delegated to a summarizer, and which one depends on what is available: a session that
 * can summarize itself does, and one that cannot uses the platform's own summarizer. Both are asked for the
 * same thing — a summary of the conversation as it stands, with the mode, the plan, the transcript and the
 * todo list attached to it — and the answer is turned into the conversation by replacing the summarized
 * messages with the carrier message and appending whatever arrived while the summary was being written.
 * Those later messages are the reason a background summary is worth the complexity: the work done during
 * it is not thrown away.
 *
 * The summarized messages are written to the blob store and registered as an archive, which is what makes
 * the summary a record rather than a loss: a transcript can be reconstructed from the archives and the
 * messages that are still live. A lifecycle hook may run before compaction, and its message is carried into
 * the summary as the user's own words would be.
 */

import { getBlobId } from "../agent-kv/blob-store.ts"
import {
  BackgroundSummarizationMode,
  shouldStartBackgroundSummarization,
  type BackgroundSummarizationProps,
} from "../agent-summarization/background-summarization.ts"
import { getRetryDirective } from "../agent-summarization/error-handling.ts"
import { prepareMessagesForCompaction } from "../agent-summarization/prepare-messages.ts"
import type { RedactedCoreMessage } from "../agent-summarization/summarization-handler.ts"
import { RedactedUpdates } from "../agent-core/redacted-interaction-updates.ts"
import { Updates } from "../agent-core/interaction-updates.ts"
import { hookExecutorResource } from "../agent-exec/hook-executor.ts"
import { createLogger, createSpan, type Context } from "../context/index.ts"
import { canRootConversationSendToProject } from "../constants/project-send-message.ts"
import { createCounter, createHistogram } from "../metrics/index.ts"
import {
  createPreCompactHookArgsInterop,
  createSummaryArchiveInterop,
  createSummaryCompletedUpdateInterop,
  preCompactHookUserMessageInterop,
} from "../../adapters/interop/agent/summarization-protocol-adapter.ts"
import type {
  SummarizationHookArgsInterop,
  SummarizationHookResultInterop,
  SummaryArchiveInterop,
} from "../../adapters/interop/agent/summarization-protocol-adapter.ts"
import { PrivacyCapability } from "../redaction/classification.ts"
import {
  fromRedactedCoreMessage,
  fromRedactedCoreMessages,
  type CoreMessageLike,
} from "../redaction/message-redaction.ts"
import { PrivacyMode } from "../redaction/privacy-mode.ts"
import type { RedactedString } from "../redaction/redacted-values.ts"
import {
  coreMessageSerde,
  createRedactedCoreMessageSerde,
} from "./serde.ts"
import {
  SlateMode,
  type ModeProcessingConfig,
  type ModeProcessingRequestContext,
  type SlateMode as SlateModeValue,
} from "./mode-processing.ts"
import {
  processModeSystemReminderWithInteropConfig,
  type InteropModeProcessingConfig,
} from "../../adapters/interop/agent/mode-processing-adapter.ts"
import { formatProjectCompactionPrompt } from "./prompts/project-prompts.ts"
import { refreshNamedAgentSelfDocumentInMessages } from "./prompts/cloud-meta-agent/self-document.ts"
import { SELF_SUMMARY_CONTEXT_WINDOW_FRACTION } from "./self-summary/constants.ts"
import { shouldPerformSelfSummary } from "./self-summary/self-summary.ts"
import { estimateTokenCount } from "./self-summary/token-estimate.ts"
import { collectLiveAskQuestionOriginalIds } from "./tools/core/ask-question/replay-horizon.ts"
import { formatTodosForSummarization } from "./tools/core/todo/common.ts"
import { readStoredTodos } from "../../adapters/interop/agent/todo-schema-adapter.ts"
import type { StoredTodoReference } from "../../adapters/interop/agent/todo-schema-adapter.ts"
import { AgentType } from "./utils/agent-config.ts"
import { getContextUsageInfo, isHookStepConfigured } from "./utils/common-helpers.ts"
import { getAgentEventTracker } from "./utils/event-tracking.ts"
import {
  EVAL_ENFORCED_MAX_TOKENS_BEFORE_SUMMARIZATION,
  EVAL_ENFORCED_SELF_SUMMARY_TOKEN_LIMIT,
} from "./utils/config-overrides.ts"
import { resolveSlateProjectConversationContextFromInterop } from "../../adapters/interop/agent/project-conversation-adapter.ts"
import {
  getClientVersionMetricTagsFromContext,
  getConversationId,
  getRequestId,
} from "./utils/request-scope.ts"

type ProjectConversationState = Parameters<typeof resolveSlateProjectConversationContextFromInterop>[1]
type ProjectRootPromptOptions = NonNullable<Parameters<typeof formatProjectCompactionPrompt>[0]>
type SummaryArchive = SummaryArchiveInterop
type SummaryCompletedHookMessage = Parameters<typeof Updates.summaryCompleted>[0]

export interface SummarizationTokenDetails {
  readonly usedTokens: number
  readonly maxTokens: number
}

export interface SummarizationResult {
  readonly messagesActuallySummarized: readonly RedactedCoreMessage[]
  readonly newSummaryMessage: RedactedCoreMessage
  readonly preservedOriginalTailMessages: readonly RedactedCoreMessage[]
  readonly rawSummary: { readonly text: string }
  readonly summary: { readonly summary: RedactedString }
  readonly fullReplacementMessages: readonly RedactedCoreMessage[]
  readonly hadError?: boolean | undefined
  readonly errorKind?: string | undefined
  readonly onPersisted?: (() => void) | undefined
}

export interface Summarizer {
  getMetricsModelLabel(): string
  summarize(
    ctx: Context,
    messageList: readonly RedactedCoreMessage[],
    settings: SummarizerRunOptions,
  ): Promise<SummarizationResult>
}

export interface SummarizerRunOptions {
  readonly fullSummarization: boolean | undefined
  readonly currentPlan: unknown
  readonly modePrompt: string
  readonly projectRootPrompt: string | undefined
  readonly agentTranscriptsFolder: string | undefined
  readonly conversationId: string | undefined
  readonly automationTriggerContext: unknown
  readonly todoContent: string | undefined
  readonly backgroundSummarizationMode: BackgroundSummarizationMode
  readonly triggerReason: string
  readonly enableRetryOutputTokenLimit: true | undefined
  readonly cancellationToken: { cancelled: boolean }
  readonly contextWindowTokens: number
}

export interface BackgroundSummarizationPromiseInfo {
  readonly promise: Promise<SummarizationResult>
  readonly modelId: string
  readonly summarizerType: "external" | "self"
  readonly startInvocationId: string
  readonly startUsedTokens: number
  readonly startMaxTokens: number
}

export interface SummarizationStateHandler extends ProjectConversationState {
  mode?: SlateModeValue | undefined
  isRootProjectConversation?: boolean
  readonly todos: readonly StoredTodoReference[]
  readonly tokenDetails: SummarizationTokenDetails
  readonly summaryArchives: readonly unknown[]
  readonly selfSummaryCount: number
  backgroundSummarizationPromiseInfo: BackgroundSummarizationPromiseInfo | null
  messagesUndergoingSummarization: readonly RedactedCoreMessage[] | null
  readonly backgroundSummarizationHasCompleted: boolean
  readonly backgroundSummarizationGenerationDurationMs: number | null
  tokenDetailsStaleAfterSummarization: boolean
  setBackgroundSummarizationState(
    info: BackgroundSummarizationPromiseInfo,
    messageList: readonly RedactedCoreMessage[],
    cancelSignal: { cancelled: boolean },
  ): void
  setBackgroundSummarizationHasCompleted(generationDurationMs: number): void
  clearBackgroundSummarizationState(): void
  setSelfSummaryInputLimitFailureTokenCount(tokenCount: number): void
  clearSelfSummaryInputLimitFailureTokenCount(): void
  pushSummaryArchive(archive: SummaryArchive): void
  getPrivacyMode(): PrivacyMode
  getBlobStore(): {
    setBlob(ctx: Context, blobId: Uint8Array, data: Uint8Array): Promise<void>
  }
  retainCompletedAskQuestionReceipts(ids: Set<string>): void
}

export interface SummarizationPromptExecutor {
  getMessages(): readonly RedactedCoreMessage[]
  clearMessages(): void
  appendMessages(messageList: readonly RedactedCoreMessage[]): void
}

export interface SummarizationInteractionListener {
  sendUpdate(ctx: Context, update: unknown): Promise<void>
}

export interface SummarizationResourceAccessor {
  get(resource: typeof hookExecutorResource): {
    execute(ctx: Context, args: SummarizationHookArgsInterop): Promise<SummarizationHookResultInterop>
  } | undefined
}

export interface SummarizationRequestContext extends ModeProcessingRequestContext {
  readonly env?: { readonly agentTranscriptsFolder?: string | undefined } | undefined
  readonly hooksConfig?: { readonly configuredSteps?: readonly string[] | undefined } | undefined
}

export interface SummarizationOrchestratorConfig extends InteropModeProcessingConfig {
  readonly onExternalSummarizationStart?: (() => void) | undefined
  readonly projectPromptTextGenerator?: (() => ProjectRootPromptOptions["promptText"]) | undefined
  readonly featureFlags?: (ModeProcessingConfig["featureFlags"] & {
    readonly cloudCoordinatorToolsEnabled?: boolean | undefined
  }) | undefined
  readonly enableTranscriptInSummary?: boolean | undefined
  readonly conversationId?: string | undefined
  readonly agentType: AgentType
  readonly enableExecuteHookExec?: boolean | undefined
  readonly modelId: string
  readonly getNamedAgentSelfDocument?: (() => Promise<string | null | undefined>) | undefined
}

export interface HandleSummarizationOptions {
  readonly forceExternalModel?: boolean | undefined
  readonly tools?: unknown[] | undefined
  readonly extraT?: unknown
  readonly descriptionProps?: Record<string, unknown> | undefined
  readonly backgroundSummarizationMode: BackgroundSummarizationMode
  readonly triggerReason: string
  readonly fullSummarization?: boolean | undefined
  readonly currentPlan?: unknown
  readonly automationTriggerContext?: unknown
  readonly currentInvocationId: string
  readonly isToolCall?: boolean | undefined
  readonly resourceAccessor: SummarizationResourceAccessor
}

export type SelfSummarizerFactory = (
  agentState: SummarizationStateHandler,
  updateListener: SummarizationInteractionListener,
  tools: unknown[],
  extraT: unknown,
  descriptionProps: Record<string, unknown> | undefined,
) => Summarizer

const logger = createLogger("@slate/agent")

function countMessageKinds(messageList: readonly {
  readonly role: string
  readonly content: unknown
}[]): {
  userMessages: number
  systemMessages: number
  assistantMessages: number
  toolMessages: number
  toolCalls: number
} {
  let userMessages = 0
  let systemMessages = 0
  let assistantMessages = 0
  let toolMessages = 0
  let toolCalls = 0
  for (const transcriptMessage of messageList) {
    switch (transcriptMessage.role) {
      case "user": userMessages++; break
      case "system": systemMessages++; break
      case "assistant":
        assistantMessages++
        if (Array.isArray(transcriptMessage.content)) {
          for (const part of transcriptMessage.content) {
            if (part.type === "tool-call") toolCalls++
          }
        }
        break
      case "tool": toolMessages++; break
      // A role nobody defined is a bug in the caller, so it is raised rather than counted.
      default: throw new Error(`Unknown message role: ${String(transcriptMessage)}`)
    }
  }
  return { userMessages, systemMessages, assistantMessages, toolMessages, toolCalls }
}

/** Two messages are the same message when they serialize to the same bytes, which is what a prefix check needs. */
function messagesEqualByValue(
  storedMessage: RedactedCoreMessage,
  liveMessage: CoreMessageLike | undefined,
): boolean {
  if (liveMessage === undefined || storedMessage.role !== liveMessage.role) return false
  const plainBody = fromRedactedCoreMessage(
    storedMessage,
    PrivacyCapability.UNSAFE_ALWAYS_ALLOWED,
  )
  const storedBytes = coreMessageSerde.serialize(plainBody)
  const liveBytes = coreMessageSerde.serialize(liveMessage)
  if (storedBytes.length !== liveBytes.length) return false
  for (let i = 0; i < storedBytes.length; i++) {
    if (storedBytes[i] !== liveBytes[i]) return false
  }
  return true
}

const summarizationTime = createHistogram("agenticComposer.summarizationTime", {
  description: "Time taken for summarization in milliseconds",
  labelNames: ["strategy", "triggerReason", "model", "summarizerType", "isClientAtLeast1Point731"],
})
const summarizationGenerationTime = createHistogram("agenticComposer.summarizationGenerationTime", {
  description: "Time spent generating a summary in milliseconds",
  labelNames: ["strategy", "triggerReason", "model", "summarizerType", "outcome", "isClientAtLeast1Point731"],
})
const summarizationCounter = createCounter("agenticComposer.summarization", {
  description: "Number of summarizations performed",
  labelNames: ["strategy", "requestedStrategy", "triggerReason", "isToolCall", "model", "summarizerType", "isClientAtLeast1Point731", "clientversion", "clienttype"],
})
const backgroundSummarizationStarted = createCounter("agent.background_summarization.started", {
  description: "Background summarizations started",
  labelNames: ["model"],
})
const backgroundSummarizationDiscarded = createCounter("agent.background_summarization.discarded", {
  description: "Background summarizations discarded at end of turn",
  labelNames: ["reason", "model"],
})
const backgroundSummarizationPersisted = createCounter("agent.background_summarization.persisted", {
  description: "Background summarizations persisted",
  labelNames: ["hadError", "errorKind", "model"],
})
const backgroundSummarizationTimeSavedMs = createHistogram("agent.background_summarization.time_saved_ms", {
  description: "Milliseconds saved by running summarization in the background (generation duration minus persist wait)",
  labelNames: ["model"],
})
const backgroundSummarizationPersistedEstimatedTokens = createHistogram("agent.background_summarization.persisted_estimated_tokens", {
  description: "Estimated token count of all messages after background summarization is persisted (replacement + unsummarized)",
  labelNames: ["model"],
})
const backgroundSummarizationPersistedAdditionalMessages = createHistogram("agent.background_summarization.persisted_additional_messages", {
  description: "Number of additional messages (arrived after background summarization started) that are appended when a background summarization is persisted, bucketed by message kind",
  labelNames: ["model", "kind"],
})

export class SummarizationOrchestrator {
  constructor(
    readonly externalSummarizer: Summarizer,
    readonly selfSummarizerFactory?: SelfSummarizerFactory,
    readonly backgroundSummarizationProps?: BackgroundSummarizationProps,
    readonly selfSummaryTokenLimit?: number,
    readonly canUseSelfSummaryNow?: () => boolean,
  ) {}

  /** How many tokens a self-summary may take, from the model's window unless a limit was set. */
  resolveSummaryTokenLimit(maxTokens: number, evalLimit: number | undefined): number | undefined {
    if (evalLimit !== undefined) return evalLimit
    if (this.selfSummaryTokenLimit !== undefined) return this.selfSummaryTokenLimit
    if (maxTokens > 0) return Math.floor(maxTokens * SELF_SUMMARY_CONTEXT_WINDOW_FRACTION)
    return undefined
  }

  shouldStartBackgroundSummarization(
    tokenUsage: SummarizationTokenDetails,
    messageList: readonly RedactedCoreMessage[],
    ctx?: Context,
  ): boolean {
    // A platform run may force summarization at a token count of its own choosing.
    const evalMaxTokens = ctx !== undefined
      ? EVAL_ENFORCED_MAX_TOKENS_BEFORE_SUMMARIZATION(ctx)
      : undefined
    if (
      ctx !== undefined &&
      evalMaxTokens !== undefined &&
      tokenUsage.usedTokens >= evalMaxTokens
    ) {
      logger.info(ctx, "[summarization] using eval override for max tokens before summarization", {
        evalMaxTokens,
        usedTokens: tokenUsage.usedTokens,
        maxTokens: tokenUsage.maxTokens,
      })
      return true
    }
    const evalLimit = ctx !== undefined
      ? EVAL_ENFORCED_SELF_SUMMARY_TOKEN_LIMIT(ctx)
      : undefined
    const backgroundWanted = this.backgroundSummarizationProps && shouldStartBackgroundSummarization(
      tokenUsage.usedTokens,
      tokenUsage.maxTokens,
      this.backgroundSummarizationProps,
    )
    const selfWanted = this.selfSummarizerFactory &&
      (this.canUseSelfSummaryNow?.() ?? true) &&
      shouldPerformSelfSummary(
        messageList as Parameters<typeof shouldPerformSelfSummary>[0],
        tokenUsage,
        ctx,
        this.resolveSummaryTokenLimit(tokenUsage.maxTokens, evalLimit),
      )
    return Boolean(backgroundWanted || selfWanted)
  }

  /** A self-summary needs the tools and the extra request state a self-summarizing turn would have. */
  canUseSelfSummary(settings: HandleSummarizationOptions): boolean {
    return this.selfSummarizerFactory !== undefined &&
      (this.canUseSelfSummaryNow?.() ?? true) &&
      settings.tools !== undefined &&
      settings.extraT !== undefined
  }

  getSummarizer(
    agentState: SummarizationStateHandler,
    updateListener: SummarizationInteractionListener,
    config: SummarizationOrchestratorConfig,
    settings: HandleSummarizationOptions,
  ): Summarizer {
    if (settings.forceExternalModel) {
      config.onExternalSummarizationStart?.()
      return this.externalSummarizer
    }
    if (this.canUseSelfSummary(settings)) {
      return this.selfSummarizerFactory!(
        agentState,
        updateListener,
        settings.tools!,
        settings.extraT,
        settings.descriptionProps,
      )
    }
    config.onExternalSummarizationStart?.()
    return this.externalSummarizer
  }

  async handleSummarization(
    outerCtx: Context,
    agentState: SummarizationStateHandler,
    conversationExecutor: SummarizationPromptExecutor,
    updateListener: SummarizationInteractionListener,
    config: SummarizationOrchestratorConfig,
    requestSettings: SummarizationRequestContext,
    settings: HandleSummarizationOptions,
  ): Promise<RedactedString | undefined> {
    using spanContext = createSpan(outerCtx.withName("handleSummarization"))
    const ctx = spanContext.ctx
    const { lastMode, isRootProject } = await resolveSlateProjectConversationContextFromInterop(ctx, agentState)
    if (isRootProject) agentState.isRootProjectConversation = true
    const modeSystemPrompt = processModeSystemReminderWithInteropConfig(
      lastMode ?? agentState.mode ?? SlateMode.AGENT,
      config,
      requestSettings,
      undefined,
      { isUserTurn: false },
    )
    // A project conversation is reminded what it is being compacted into, since the reminder is not a
    // message and would otherwise be lost with the messages it is attached to.
    const rootProjectPrompt = agentState.isRootProjectConversation
      ? `<system_reminder>\n${formatProjectCompactionPrompt({
          promptText: config.projectPromptTextGenerator?.()!,
          sendMessageEnabled: canRootConversationSendToProject(agentState),
          coordinatorToolsEnabled: config.featureFlags?.cloudCoordinatorToolsEnabled === true,
        })}\n</system_reminder>`
      : undefined
    const conversationMessages = conversationExecutor.getMessages()
    const plainMessages = fromRedactedCoreMessages(
      conversationMessages,
      PrivacyCapability.UNSAFE_ALWAYS_ALLOWED,
    )
    // Without the system message there is nothing to compact against, so this is a caller's bug.
    if (!conversationMessages.find(transcriptMessage => transcriptMessage.role === "system")) {
      logger.warn(ctx, "Compaction skipped due to missing system message", {
        summarization: { allMessagesCount: conversationMessages.length },
      })
      throw new Error("No system prompt found")
    }
    const { messagesForSummarization: summarizationInput } = prepareMessagesForCompaction(conversationMessages)
    const summarizer = this.getSummarizer(agentState, updateListener, config, settings)
    let modelLabel = summarizer.getMetricsModelLabel()
    let logFields = {
      summarizationMode: settings.backgroundSummarizationMode,
      triggerReason: settings.triggerReason,
      model: modelLabel,
    }
    const strategy = settings.fullSummarization ? "v5NalFull" : "v5NalPartial"
    const triggerReason = settings.triggerReason
    const isClientAtLeast1Point731 = "true"
    let summarizerType: "external" | "self" = settings.forceExternalModel === true ||
        !this.canUseSelfSummary(settings)
      ? "external"
      : "self"
    let reuseInFlight = false
    if (
      agentState.backgroundSummarizationPromiseInfo !== null &&
      agentState.messagesUndergoingSummarization !== null
    ) {
      // A summary already underway is only usable while the conversation still starts with the messages it
      // was started for; anything else would summarize a conversation that no longer exists.
      const inFlightMessages = agentState.messagesUndergoingSummarization
      const prefixMatches = inFlightMessages.every((transcriptMessage, index) =>
        messagesEqualByValue(transcriptMessage, plainMessages[index])
      )
      if (prefixMatches) {
        modelLabel = agentState.backgroundSummarizationPromiseInfo.modelId
        summarizerType = agentState.backgroundSummarizationPromiseInfo.summarizerType
        logFields = { ...logFields, model: modelLabel }
        logger.info(ctx, "Summarization with valid prefix is already underway.", {
          summarization: {
            ...logFields,
            messagesInCurrentSummarizeRequestCount: summarizationInput.length,
            messagesAlreadyUndergoingSummarizationCount: inFlightMessages.length,
          },
        })
        reuseInFlight = true
      } else {
        logger.info(ctx, "Summarization prefix invalid. Clearing in-progress state.", {
          summarization: {
            ...logFields,
            messagesInCurrentSummarizeRequestCount: summarizationInput.length,
            messagesAlreadyUndergoingSummarizationCount: inFlightMessages.length,
          },
        })
        if (
          settings.backgroundSummarizationMode ===
            BackgroundSummarizationMode.BackgroundAndPersistIfCompleted
        ) {
          logger.warn(ctx, "Clearing state in mode BackgroundAndPersistIfCompleted", {
            summarization: {
              ...logFields,
              messagesInCurrentSummarizeRequestCount: summarizationInput.length,
              messagesAlreadyUndergoingSummarizationCount: inFlightMessages.length,
            },
          })
        }
        backgroundSummarizationDiscarded.increment(ctx, 1, {
          reason: "prefix_invalid",
          model: agentState.backgroundSummarizationPromiseInfo.modelId,
        })
        agentState.clearBackgroundSummarizationState()
      }
    }
    if (!reuseInFlight) {
      if (
        settings.backgroundSummarizationMode ===
          BackgroundSummarizationMode.WaitForCompletionIfStarted
      ) {
        logger.info(
          ctx,
          "No in-flight background summarization in WaitForCompletionIfStarted mode. Returning without starting one.",
          { summarization: { ...logFields, messagesInCurrentSummarizeRequestCount: summarizationInput.length } },
        )
        return undefined
      }
      if (
        settings.backgroundSummarizationMode ===
          BackgroundSummarizationMode.BackgroundAndPersistIfCompleted
      ) {
        logger.warn(
          ctx,
          "Starting summarization in BackgroundAndPersistIfCompleted mode which should only be called for a completed summarization",
          { summarization: { ...logFields, messagesInCurrentSummarizeRequestCount: summarizationInput.length } },
        )
      }
      const cancelSignal = { cancelled: false }
      const backgroundPromise = (async (): Promise<SummarizationResult> => {
        const generationStartMs = performance.now()
        try {
          logger.info(ctx, "Starting new background summarization", {
            summarization: {
              ...logFields,
              messagesToSummarizeCount: summarizationInput.length,
              summarizerModel: modelLabel,
              summarizationMode: settings.backgroundSummarizationMode,
              triggerReason: settings.triggerReason,
            },
          })
          backgroundSummarizationStarted.increment(ctx, 1, { model: modelLabel })
          const todoEntries = await readStoredTodos(ctx, agentState.todos)
          const todoText = formatTodosForSummarization(todoEntries)
          // The transcript pointer is only worth carrying when the folder is known and this is not a
          // background agent, whose conversation nobody is reading.
          const shouldIncludeTranscript = config.enableTranscriptInSummary === true &&
            requestSettings.env?.agentTranscriptsFolder !== undefined &&
            config.agentType !== AgentType.BACKGROUND
          const summarizationOutcome = await summarizer.summarize(ctx, conversationMessages, {
            fullSummarization: settings.fullSummarization,
            currentPlan: settings.currentPlan,
            modePrompt: modeSystemPrompt,
            projectRootPrompt: rootProjectPrompt,
            agentTranscriptsFolder: shouldIncludeTranscript
              ? requestSettings.env?.agentTranscriptsFolder
              : undefined,
            conversationId: config.conversationId,
            automationTriggerContext: settings.automationTriggerContext,
            todoContent: todoText,
            backgroundSummarizationMode: settings.backgroundSummarizationMode,
            triggerReason: settings.triggerReason,
            // Only a run that is going to wait is allowed to retry an output-token failure, since a
            // background one has nobody waiting for the retry.
            enableRetryOutputTokenLimit:
              settings.backgroundSummarizationMode === BackgroundSummarizationMode.WaitForCompletion
                ? true
                : undefined,
            cancellationToken: cancelSignal,
            contextWindowTokens: agentState.tokenDetails.maxTokens,
          })
          const generationElapsedMs = performance.now() - generationStartMs
          summarizationGenerationTime.histogram(ctx, generationElapsedMs, {
            strategy,
            triggerReason,
            model: modelLabel,
            summarizerType,
            outcome: "success",
            isClientAtLeast1Point731,
          })
          agentState.setBackgroundSummarizationHasCompleted(generationElapsedMs)
          logger.info(ctx, "Background summarization completed", {
            summarization: { ...logFields, messagesToSummarizeCount: summarizationInput.length },
          })
          return summarizationOutcome
        } catch (error) {
          const generationElapsedMs = performance.now() - generationStartMs
          const failureKind = getRetryDirective(error, { transientRetryDelayMs: 0 }).errorType
          summarizationGenerationTime.histogram(ctx, generationElapsedMs, {
            strategy,
            triggerReason,
            model: modelLabel,
            summarizerType,
            outcome: "error",
            isClientAtLeast1Point731,
          })
          logger.error(ctx, "Background summarization failed, clearing state", error, {
            summarization: logFields,
          })
          // A self-summary that did not fit is remembered, so the next attempt does not try again at the
          // same size.
          if (
            summarizerType === "self" &&
            (failureKind === "InputTokenLimitError" || failureKind === "InputTooLargeError")
          ) {
            agentState.setSelfSummaryInputLimitFailureTokenCount(agentState.tokenDetails.usedTokens)
          }
          agentState.clearBackgroundSummarizationState()
          throw error
        }
      })()
      agentState.setBackgroundSummarizationState({
        promise: backgroundPromise,
        modelId: modelLabel,
        summarizerType,
        startInvocationId: settings.currentInvocationId,
        startUsedTokens: agentState.tokenDetails.usedTokens,
        startMaxTokens: agentState.tokenDetails.maxTokens,
      }, conversationMessages, cancelSignal)
    }

    switch (settings.backgroundSummarizationMode) {
      case BackgroundSummarizationMode.Background:
        logger.info(ctx, "Background summarization in progress in Background mode. Returning without awaiting completion.", {
          summarization: logFields,
        })
        return undefined
      case BackgroundSummarizationMode.BackgroundAndPersistIfCompleted:
        // This mode is only reached once the caller knows the summary is done, so not being done is a
        // contradiction rather than a reason to wait.
        if (!agentState.backgroundSummarizationHasCompleted) {
          logger.info(ctx, "Background summarization is not completed yet in BackgroundAndPersistIfCompleted mode. REturning without awaiting completion.", { summarization: logFields })
          return undefined
        }
        logger.info(ctx, "Background summarization has completed in BackgroundAndPersistIfCompleted mode. Going to persist summary.", { summarization: logFields })
        break
      case BackgroundSummarizationMode.WaitForCompletion:
        logger.info(ctx, agentState.backgroundSummarizationHasCompleted
          ? "Background summarization has completed in WaitForCompletion mode. Going to persist summary."
          : "Background summarization is not completed in WaitForCompletion mode. Going to wait for completion and then persist summary.", { summarization: logFields })
        break
      case BackgroundSummarizationMode.WaitForCompletionIfStarted:
        logger.info(ctx, agentState.backgroundSummarizationHasCompleted
          ? "In-flight background summarization has completed in WaitForCompletionIfStarted mode. Going to persist summary."
          : "In-flight background summarization is not completed in WaitForCompletionIfStarted mode. Going to wait for completion and then persist summary.", { summarization: logFields })
        break
      default: throw new Error(`Unknown background summarization mode: ${String(settings.backgroundSummarizationMode)}`)
    }

    const { contextWindowSize, contextTokens, contextUsagePercent } = getContextUsageInfo(
      agentState.tokenDetails,
    )
    const isFirstCompaction = agentState.summaryArchives.length === 0 &&
      agentState.selfSummaryCount === 0
    const hookMode = settings.triggerReason === "force_option" ||
        settings.triggerReason === "force_dev_testing"
      ? "manual"
      : "auto"
    let lifecycleHookMessage: string | undefined
    if (
      config.enableExecuteHookExec &&
      isHookStepConfigured(requestSettings.hooksConfig?.configuredSteps, "preCompact")
    ) {
      try {
        using hookSpan = createSpan(ctx.withName("agent.lifecycleHook.preCompact"))
        const hookContext = hookSpan.ctx
        const hookExecutorInstance = settings.resourceAccessor.get(hookExecutorResource)
        if (hookExecutorInstance) {
          const hookRequest = createPreCompactHookArgsInterop({
            trigger: hookMode,
            contextUsagePercent,
            contextTokens,
            contextWindowSize,
            messageCount: conversationMessages.length,
            messagesToCompact: summarizationInput.length,
            isFirstCompaction,
            conversationId: getConversationId(ctx)!,
            generationId: getRequestId(ctx)!,
            model: modelLabel,
          })
          const summarizationOutcome = await hookExecutorInstance.execute(hookContext, hookRequest)
          const userMessage = preCompactHookUserMessageInterop(summarizationOutcome)
          if (userMessage) {
            lifecycleHookMessage = userMessage
            logger.info(hookContext, "[summarization] preCompact hook message", {
              summarization: { userMessage: lifecycleHookMessage },
            })
          }
        }
      } catch (error) {
        // A hook that fails is not a reason to keep a conversation that no longer fits.
        logger.warn(ctx, "[summarization] preCompact hook execution failed", {
          summarization: { error },
        })
      }
    }

    try {
      await updateListener.sendUpdate(
        ctx,
        RedactedUpdates.summaryStarted(PrivacyMode.UNSPECIFIED),
      )
      const persistStartedAt = performance.now()
      const inFlightSnapshot = agentState.messagesUndergoingSummarization!
      const inFlightInfo = agentState.backgroundSummarizationPromiseInfo!
      const inFlightModelLabel = inFlightInfo.modelId
      const summarizationOutcome = await inFlightInfo.promise
      const {
        messagesActuallySummarized,
        newSummaryMessage,
        preservedOriginalTailMessages,
        rawSummary,
        summary,
        fullReplacementMessages,
        onPersisted,
      } = summarizationOutcome
      const persistWaitMs = performance.now() - persistStartedAt
      const abortedFailure = summarizationOutcome.errorKind?.toLowerCase()?.includes("abort") === true
      // A summary that failed while nobody was waiting is dropped rather than adopted: the conversation it
      // describes is still there, and a failed summary is not an improvement on it.
      if (
        this.backgroundSummarizationProps?.discardOnError !== false &&
        summarizationOutcome.hadError &&
        (
          settings.backgroundSummarizationMode !== BackgroundSummarizationMode.WaitForCompletion &&
            settings.backgroundSummarizationMode !== BackgroundSummarizationMode.WaitForCompletionIfStarted ||
          abortedFailure
        )
      ) {
        agentState.clearBackgroundSummarizationState()
        backgroundSummarizationDiscarded.increment(ctx, 1, {
          reason: abortedFailure ? "abort_error" : "summarization_error",
          model: inFlightModelLabel,
        })
        logger.warn(ctx, "Discarding background summarization due to generation error", {
          summarization: { ...logFields, errorKind: summarizationOutcome.errorKind ?? "unknown" },
        })
        return undefined
      }
      const messageSerde = createRedactedCoreMessageSerde(agentState.getPrivacyMode())
      // The tail is what was in the window but not summarized; a negative one means the summary covered more
      // than the window did, which is clamped rather than trusted.
      const windowTailDelta = summarizationInput.length - messagesActuallySummarized.length
      if (windowTailDelta < 0) {
        logger.warn(ctx, "Clamping negative windowTail during compaction", {
          summarization: {
            messagesForSummarizationCount: summarizationInput.length,
            messagesActuallySummarizedCount: messagesActuallySummarized.length,
            windowTailDelta,
          },
        })
      }
      // Every summarized message is written to the blob store so the archive can point at it, and a carrier
      // message is skipped since it is itself a summary.
      const archiveBlobIds = await Promise.all(
        messagesActuallySummarized
          .filter(transcriptMessage => !(transcriptMessage.providerOptions as {
            readonly cursor?: { readonly isSummary?: unknown } | undefined
          } | undefined)?.cursor?.isSummary)
          .map(async transcriptMessage => {
            const serializedBytes = messageSerde.serialize(transcriptMessage)
            const blobId = await getBlobId(serializedBytes)
            await agentState.getBlobStore().setBlob(ctx, blobId, serializedBytes)
            return blobId
          }),
      )
      const carrierBytes = messageSerde.serialize(newSummaryMessage)
      const carrierBlobId = await getBlobId(carrierBytes)
      await agentState.getBlobStore().setBlob(ctx, carrierBlobId, carrierBytes)
      agentState.pushSummaryArchive(createSummaryArchiveInterop({
        privacyMode: agentState.getPrivacyMode(),
        summarizedMessages: archiveBlobIds,
        summary: summary.summary,
        summaryMessage: carrierBlobId,
        windowTail: Math.max(0, windowTailDelta),
      }))
      const generationDurationMsBeforeClear =
        agentState.backgroundSummarizationGenerationDurationMs
      agentState.clearBackgroundSummarizationState()
      agentState.tokenDetailsStaleAfterSummarization = true
      // A named agent's self document is refreshed in the replacement messages, since it describes the agent
      // and the summary is now what the agent knows about itself.
      const replacementList = config.getNamedAgentSelfDocument !== undefined
        ? await refreshNamedAgentSelfDocumentInMessages(
            ctx,
            fullReplacementMessages,
            config.getNamedAgentSelfDocument,
            agentState.getPrivacyMode(),
          )
        : fullReplacementMessages
      conversationExecutor.clearMessages()
      conversationExecutor.appendMessages(replacementList)
      // What arrived while the summary was being written is kept, which is the point of summarizing in the
      // background rather than at the end.
      const postSummaryMessages = conversationMessages.slice(inFlightSnapshot.length)
      conversationExecutor.appendMessages(postSummaryMessages)
      agentState.retainCompletedAskQuestionReceipts(
        collectLiveAskQuestionOriginalIds(conversationExecutor.getMessages()),
      )
      const persistedTokenEstimate = estimateTokenCount(replacementList) +
        estimateTokenCount(postSummaryMessages)
      const model = modelLabel
      const postSummaryKinds = countMessageKinds(postSummaryMessages)
      logger.info(ctx, "Persisted completed summarization", {
        summarization: {
          ...logFields,
          messagesSummarizedCount: inFlightSnapshot.length,
          messagesNotSummarizedCount: postSummaryMessages.length,
          additionalMessagesUserCount: postSummaryKinds.userMessages,
          additionalMessagesSystemCount: postSummaryKinds.systemMessages,
          additionalMessagesAssistantCount: postSummaryKinds.assistantMessages,
          additionalMessagesToolMessageCount: postSummaryKinds.toolMessages,
          additionalMessagesToolCallCount: postSummaryKinds.toolCalls,
          persistedTokenEstimate,
          hadError: summarizationOutcome.hadError === true,
          errorKind: summarizationOutcome.hadError === true ? summarizationOutcome.errorKind ?? "unknown" : "none",
          model,
        },
      })
      backgroundSummarizationPersisted.increment(ctx, 1, {
        hadError: summarizationOutcome.hadError === true ? "true" : "false",
        errorKind: summarizationOutcome.hadError === true ? summarizationOutcome.errorKind ?? "unknown" : "none",
        model: inFlightModelLabel,
      })
      backgroundSummarizationPersistedEstimatedTokens.histogram(ctx, persistedTokenEstimate, {
        model: inFlightModelLabel,
      })
      const metricRows = [
        [postSummaryKinds.userMessages, "user_message"],
        [postSummaryKinds.systemMessages, "system_message"],
        [postSummaryKinds.assistantMessages, "assistant_message"],
        [postSummaryKinds.toolMessages, "tool_message"],
        [postSummaryKinds.toolCalls, "tool_call"],
      ] as const
      for (const [value, kind] of metricRows) {
        backgroundSummarizationPersistedAdditionalMessages.histogram(ctx, value, {
          model: inFlightModelLabel,
          kind,
        })
      }
      agentState.clearSelfSummaryInputLimitFailureTokenCount()
      onPersisted?.()
      summarizationTime.histogram(ctx, persistWaitMs, {
        strategy,
        triggerReason,
        model,
        summarizerType,
        isClientAtLeast1Point731,
      })
      // What the background run saved is the time it took to write minus the time spent waiting for it.
      if (generationDurationMsBeforeClear !== null) {
        backgroundSummarizationTimeSavedMs.histogram(
          ctx,
          Math.max(0, generationDurationMsBeforeClear - persistWaitMs),
          { model: inFlightModelLabel },
        )
      }
      summarizationCounter.increment(ctx, 1, {
        strategy,
        requestedStrategy: strategy,
        triggerReason,
        isToolCall: settings.isToolCall === true ? "true" : "false",
        model,
        summarizerType,
        isClientAtLeast1Point731,
        ...getClientVersionMetricTagsFromContext(ctx),
      })
      const summarizedKinds = countMessageKinds(messagesActuallySummarized)
      const eventTracker = getAgentEventTracker(ctx)
      eventTracker.trackSummarizationTriggered(ctx, {
        userMessageCountBeforeSummarization: summarizedKinds.userMessages,
        toolCallCountBeforeSummarization: summarizedKinds.toolCalls,
        summaryLengthInChars: summary.summary.length,
        summarizationModelId: inFlightModelLabel,
        mainModelId: config.modelId,
        summarizerType,
        summarizationStartInvocationId: inFlightInfo.startInvocationId,
        summarizationPersistInvocationId: settings.currentInvocationId,
        triggerTokensUsed: inFlightInfo.startUsedTokens,
        triggerTokensMax: inFlightInfo.startMaxTokens,
        additionalMessagesCount: postSummaryMessages.length,
        additionalUserMessageCount: postSummaryKinds.userMessages,
        additionalSystemMessageCount: postSummaryKinds.systemMessages,
        additionalAssistantMessageCount: postSummaryKinds.assistantMessages,
        additionalToolMessageCount: postSummaryKinds.toolMessages,
        additionalToolCallCount: postSummaryKinds.toolCalls,
      })
      // What the conversation is now, as opposed to what was summarized: the carrier message, any other
      // carrier, the preserved tail, and everything that arrived afterwards.
      const gradingTail = [...preservedOriginalTailMessages, ...postSummaryMessages]
      const preservedTailSet = new Set(preservedOriginalTailMessages)
      const preservedTailPositions = new Set(
        fullReplacementMessages.flatMap((transcriptMessage, index) =>
          preservedTailSet.has(transcriptMessage) ? [index] : []
        ),
      )
      const gradingContext = [
        ...replacementList.filter((transcriptMessage, index) =>
          transcriptMessage === newSummaryMessage ||
          (transcriptMessage.providerOptions as {
            readonly cursor?: { readonly isSummary?: unknown } | undefined
          } | undefined)?.cursor?.isSummary === true ||
          preservedTailPositions.has(index)
        ),
        ...postSummaryMessages,
      ]
      eventTracker.trackSummarizationPersistedForQualityGrading?.(ctx, {
        preSummarizationMessages: messagesActuallySummarized,
        modelSummaryText: summary.summary.safeTransform(() => rawSummary.text),
        persistedSummaryMessage: newSummaryMessage,
        gradingContext,
        preservedTailMessages: gradingTail,
        summarizerType,
        summarizationHadError: summarizationOutcome.hadError === true,
        summarizationErrorKind: summarizationOutcome.hadError === true ? summarizationOutcome.errorKind ?? "unknown" : undefined,
        summarizationModelId: inFlightModelLabel,
        mainModelId: config.modelId,
        summarizationStartInvocationId: inFlightInfo.startInvocationId,
        summarizationPersistInvocationId: settings.currentInvocationId,
      })
      if (
        config.enableTranscriptInSummary === true &&
        requestSettings.env?.agentTranscriptsFolder !== undefined &&
        config.agentType !== AgentType.BACKGROUND
      ) {
        logger.info(ctx, "Summary includes transcript pointer", {
          summarization: { conversationId: config.conversationId },
        })
      }
      return summary.summary
    } finally {
      // The turn is told the summary finished whether or not it did, since a listener waiting for an update
      // must not be left waiting.
      await updateListener.sendUpdate(
        ctx,
        createSummaryCompletedUpdateInterop(
          Updates.summaryCompleted(lifecycleHookMessage as SummaryCompletedHookMessage),
          PrivacyMode.UNSPECIFIED,
        ),
      )
    }
  }
}
