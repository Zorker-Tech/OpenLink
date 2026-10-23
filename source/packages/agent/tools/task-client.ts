/**
 * The client side of the subagent tool: turning a resolved request into a run, and a run into what the
 * model and the user read.
 *
 * A subagent runs where the request says it should. Here that means handing the request to the local
 * subagent handoffExecutor and letting it start, resume, fork or background the run; the request is assembled
 * from the resolved target rather than from the raw arguments, because by this point the model's intent
 * has already been read into a type name, a model, an environment and a machine.
 *
 * Two things happen around the run rather than inside it. A run that the user has injected into has to
 * hand itself to the background: a turn that is being steered cannot also be a turn that blocks, so the
 * handoff is requested as soon as an injection is admitted, retried while injections are still pending,
 * and abandoned the moment the run finishes. And a run that is resumed keeps the identity of the run it
 * resumes — the agent id it already had — while a cloud run records the box it ran in, so that a
 * follow-up reaches the same machine.
 *
 * What comes back is shaped for reading. A finished run reads as its last assistant message, prefixed by
 * the high-level chosenSummary the subagent itself chose to show when there is one; a run that went to the
 * background reads as a note that it is still going, with the transcript path when there is one and the
 * promise that its answer will arrive on its own. A run that failed reads as its error, and the two
 * errors that are really a retry hint — a follow-up sent to a running subagent, an interrupted one — say
 * so rather than looking like a dead end.
 */

import {
  AssistantMessage,
  ConversationStep,
  SubagentExecutionEnvironment,
  SubagentPersistedState,
  SubagentBackgroundReason,
  TaskError,
  TaskResult,
  TaskSuccess,
  TaskToolCall,
  ToolCall,
  type ConversationStep as ConversationStepValue,
  type SubagentPersistedState as SubagentPersistedStateValue,
} from "../../proto/generated/agent/v1/agent_pb.ts"
import {
  ClientContinuationConfig,
  ForceBackgroundSubagentArgs,
  ForceBackgroundSubagentStatus,
  SubagentArgs,
  type SubagentResult,
} from "../../proto/generated/agent/v1/subagent_exec_pb.ts"
import type { Context } from "../../context/context.ts"
import { PrivacyCapability } from "../../redaction/classification.ts"
import type { PrivacyMode } from "../../redaction/privacy-mode.ts"
import { fromRedactedSelectedContext } from "../../redacted-protos/generated/agent/v1/selected_context_redacted.ts"
import type { ResourceAccessor } from "../../agent-exec/resource-provider.ts"
import type { RemoteExecManager } from "../../agent-exec/executor-resources.ts"
import { forceBackgroundSubagentExecutorResource } from "../../agent-exec/subagent-control.ts"
import { subagentExecutorResource } from "../../agent-exec/subagent.ts"
import { getConversationGroupId, getConversationId } from "../utils/request-scope.ts"
import { isGeminiVideoSubagentType, getSubagentTypeName } from "./core/subagent/subagent-config.ts"
import {
  buildClientSubagentAttachmentsContext,
  type TaskRawArguments,
  type TaskSubagentResolution,
} from "./task-subagent-preparation.ts"
import {
  buildCloudSubagentPersistedState,
  type TaskTargetMachine,
} from "./task-runtime.ts"
import {
  RUNNING_SUBAGENT_FOLLOWUP_ERROR,
  RUNNING_SUBAGENT_INTERRUPT_RETRY_HINT,
} from "../../agent-exec/subagent.ts"
import { createStringResult, type TextResult } from "../../chat-inference/prompt-executor.ts"
import { WriteIterableClosedError } from "../../utils/writable-iterable.ts"

const SUBAGENT_STREAM_CLOSED_ERROR =
  "The subagent's connection closed before it finished (the run was torn down mid-flight). This is usually transient — please try again."

export interface TaskResultRenderingOptions {
  readonly enableJobCompletionNotifications?: boolean
  readonly hideAsyncSubagentTaskNotifications?: boolean
  readonly enableAgentChatLinks?: boolean
}

/** The last chosenSummary the subagent asked to show the user, read back out of its own tool calls. */
function extractFinalSummaryFromSteps(steps: readonly ConversationStepValue[]): string | undefined {
  for (let stepIndex = steps.length - 1; stepIndex >= 0; stepIndex -= 1) {
    const conversationStep = steps[stepIndex]
    if (conversationStep?.message.case !== "toolCall") continue
    const tool = conversationStep.message.value.tool
    if (tool.case !== "sendFinalSummaryToolCall" && tool.case !== "communicateUpdateToolCall") continue
    const chosenSummary = tool.value.args?.finalSummary?.trim()
    if (chosenSummary !== undefined && chosenSummary.length > 0) return chosenSummary
  }
  return undefined
}

function getTaskSuccessResultText(
  successValue: TaskSuccess,
  renderOptions?: TaskResultRenderingOptions,
): string {
  const finalAssistantText = [...successValue.conversationSteps]
    .reverse()
    .map((conversationStep) => (conversationStep.message.case === "assistantMessage" ? conversationStep.message.value?.text : undefined))
    .find((text) => text !== undefined)
  const answerBody = finalAssistantText ?? "No output"
  // The subagent's own chosenSummary is shown above its answer when the platform is showing notifications at all.
  if (renderOptions?.hideAsyncSubagentTaskNotifications !== true) {
    const summaryText = extractFinalSummaryFromSteps(successValue.conversationSteps)
    if (summaryText !== undefined) {
      return [
        "response:",
        "<user_visible_high_level_summary>",
        summaryText,
        "</user_visible_high_level_summary>",
        "<response>",
        answerBody,
        "</response>",
      ].join("\n")
    }
  }
  // An answer that already carries its own response tags is passed through rather than tagged twice.
  if (finalAssistantText !== undefined && finalAssistantText.includes("<response>") && finalAssistantText.includes("</response>")) {
    return ["response:", finalAssistantText].join("\n")
  }
  return ["response:", "<response>", answerBody, "</response>"].join("\n")
}

export function formatSubagentBackgroundMessage(
  reason: SubagentBackgroundReason,
  transcriptPath: string | undefined,
  renderOptions?: TaskResultRenderingOptions,
): string {
  let intro: string
  switch (reason) {
    case SubagentBackgroundReason.USER_REQUEST:
      intro = "The user manually backgrounded the subagent. It is still running; you can continue with other work."
      break
    case SubagentBackgroundReason.QUEUED_FOLLOW_UP:
      intro = RUNNING_SUBAGENT_FOLLOWUP_ERROR
      break
    case SubagentBackgroundReason.AGENT_REQUEST:
    case SubagentBackgroundReason.UNSPECIFIED:
      intro = "Subagent is running in the background."
      break
    default:
      intro = "Subagent is running in the background."
  }
  const displayTranscriptPath = transcriptPath?.trim()
  if (!displayTranscriptPath) return intro
  // With completion notifications on, the answer arrives by itself, so the model is told not to wait for it.
  if (renderOptions?.enableJobCompletionNotifications === true) {
    return `${intro} If needed, you can monitor its output by tailing the transcript at: ${displayTranscriptPath}. When you end your turn, you will be automatically sent the subagent's final response upon its completion, so do not wait for it - either end your turn or work on something else.\nDo NOT mention the transcript path to the user. Do NOT try to predict the subagent's response before it replies.`
  }
  return `${intro} You can monitor its output by tailing the transcript at: ${displayTranscriptPath}. Do not mention the transcript path to the user.`
}

export function renderTaskResultToString(
  resultValue: TaskResult,
  renderOptions?: TaskResultRenderingOptions,
): string {
  const enableAgentChatLinks = renderOptions?.enableAgentChatLinks ?? true
  const chatLinkExample = (agentId: string): string =>
    renderOptions?.hideAsyncSubagentTaskNotifications === true
      ? `\`[Name](${agentId})\`. Don't use a generic label such as \`[agent]\`, \`[worker]\`, or \`[subagent]\`. For cloud subagents, when the agent has edited code, link to \`[Review](${agentId}#changes)\`, or, if you know the exact added and deleted line counts, \`[Review +A −D](${agentId}#changes)\`, replacing A and D with those counts. Never write A or D literally. Use \`[Try Live](${agentId}#desktop)\` only when the agent used computer use`
      : `\`[label](${agentId})\``
  switch (resultValue.result.case) {
    case "success": {
      const successValue = resultValue.result.value
      // The agent id is what makes a follow-up or a link possible, so it is handed over with its uses.
      const agentIdInfo = successValue.agentId
        ? `\n\nAgent ID: ${successValue.agentId} (can be used with the \`resume\` parameter to send a follow-up after it completes${enableAgentChatLinks ? `, or to link to this agent/subagent in user-facing text with ${chatLinkExample(successValue.agentId)}` : ""})`
        : ""
      const suffixInfo = successValue.resultSuffix ? `\n\n${successValue.resultSuffix}` : ""
      if (successValue.backgroundReason !== SubagentBackgroundReason.UNSPECIFIED) {
        return `${formatSubagentBackgroundMessage(successValue.backgroundReason, successValue.transcriptPath, renderOptions)}${agentIdInfo}${suffixInfo}`
      }
      return `This is the output of the subagent:\n\n${getTaskSuccessResultText(successValue, renderOptions)}${agentIdInfo}${suffixInfo}`
    }
    case "error":
      return `Error: ${resultValue.result.value.error}`
    case undefined:
      return "Unknown error"
    default:
      throw new Error(`Unhandled result case: ${resultValue.result}`)
  }
}

export function createTaskToolCall(taskTool: TaskToolCall): ToolCall {
  return new ToolCall({ tool: { case: "taskToolCall", value: taskTool } })
}

export function serializeError(error: unknown): ToolCall {
  const failureMessage = error instanceof Error ? error.message : String(error)
  return createTaskToolCall(new TaskToolCall({
    result: new TaskResult({ result: { case: "error", value: new TaskError({ error: failureMessage }) } }),
  }))
}

export interface ClientContinuationPolicy {
  readonly idleThreshold: number
  readonly maxLoops?: number
  readonly continuationMessage: string | ((args: { isEscapeHatch: boolean; idleCount: number; escapeToken: string }) => string)
}

interface ContinuationSubagentConfig {
  readonly subagent_type: Parameters<typeof getSubagentTypeName>[0]
  readonly continuationPolicy?: ClientContinuationPolicy
}

export function buildClientContinuationConfig(
  subagentConfig: ContinuationSubagentConfig,
): ClientContinuationConfig | undefined {
  const continuationPolicy = subagentConfig.continuationPolicy
  if (!continuationPolicy) return undefined
  const continuationMessage = continuationPolicy.continuationMessage
  const nudgeText = typeof continuationMessage === "function" ? continuationMessage({ isEscapeHatch: false, idleCount: 0, escapeToken: "" }) : continuationMessage
  // A message written as a function is asked for its escape-hatch form with sentinels in place, and the
  // sentinels become the placeholders the platform fills in per run.
  const sentinelIdle = 99999
  const sentinelToken = "___ESCAPE_TOKEN_PLACEHOLDER___"
  const escapeTextTemplate = typeof continuationMessage === "function"
    ? continuationMessage({ isEscapeHatch: true, idleCount: sentinelIdle, escapeToken: sentinelToken })
      .replace(String(sentinelIdle), "{idle_count}")
      .replace(sentinelToken, "{escape_token}")
    : "You've made {idle_count} responses without tool calls. If you're done, respond with exactly: {escape_token}\nIf not, continue working."
  const isCoordinator = getSubagentTypeName(subagentConfig.subagent_type) === "coordinator-agent"
  return new ClientContinuationConfig({
    idleThreshold: continuationPolicy.idleThreshold,
    maxLoops: continuationPolicy.maxLoops ?? 0,
    nudgeMessage: nudgeText,
    escapeMessageTemplate: escapeTextTemplate,
    // Only a coordinator is told about its background children: it is the one expected to collect them.
    collectBackgroundChildren: isCoordinator,
    childrenCompletedMessageTemplate: isCoordinator
      ? "The following background agents have completed:\n\n{summaries}\n\nReview their results. If more work is needed, spawn additional workers. Otherwise, wrap up."
      : "",
  })
}

export function maybeAppendInterruptRetryHint(
  error: string,
  enableSubagentInterrupt: boolean,
  interruptAlreadyRequested: boolean,
): string {
  if (!enableSubagentInterrupt || interruptAlreadyRequested || error !== RUNNING_SUBAGENT_FOLLOWUP_ERROR) return error
  return `${error}\n${RUNNING_SUBAGENT_INTERRUPT_RETRY_HINT}`
}

export interface ClientTaskStateHandler {
  readonly turns: readonly ClientTaskTurnHandle[]
  getPrivacyMode(): PrivacyMode
  persistSubagentState(ctx: Context, subagentId: string, subagentType: Parameters<typeof getSubagentTypeName>[0], state: SubagentPersistedStateValue): void
}

export interface ClientTaskTurnHandle {
  get(ctx: Context): Promise<{ readonly userMessage?: { get(ctx: Context): Promise<{ readonly isSimulatedMsg?: boolean; readonly selectedContext?: unknown }> } }>
}

export interface ClientTaskContextInjectionSignal {
  hasPendingUserInjections(): boolean
  onUserInjectionAdmitted(listener: () => void): () => void
}

export interface ClientTaskExecutionArgs {
  readonly ctx: Context
  readonly toolCallId: string
  readonly rawArgs: TaskRawArguments
  readonly resolved: TaskSubagentResolution
  readonly resourceAccessor: ResourceAccessor<RemoteExecManager>
  readonly stateHandler: ClientTaskStateHandler
  readonly parentModelName: string
  readonly subagentCredentials?: SubagentArgs["credentials"]
  readonly attachedMediaUrlProvider?: import("../context/video-attachment.ts").AttachedMediaUrlProvider
  readonly geminiVideoAttachedMediaUrlProvider?: ClientTaskExecutionArgs["attachedMediaUrlProvider"]
  readonly inlineVideoMaxBytes?: number
  readonly signedUrlVideoMaxBytes?: number
  readonly trustedVideoAttachmentRoots?: readonly string[]
  readonly enableSubagentInterrupt?: boolean
  readonly interrupt?: boolean
  readonly contextInjectionSignal?: ClientTaskContextInjectionSignal
}

/** The videos the user attached to this conversation, which a subagent may be asked about. */
function getUserAttachedVideoPaths(ctx: Context, stateHandler: ClientTaskStateHandler): Promise<string[]> {
  return (async () => {
    const videoPaths = new Set<string>()
    for (const turnHandle of stateHandler.turns) {
      const turn = await turnHandle.get(ctx)
      const userMessage = turn.userMessage === undefined ? undefined : await turn.userMessage.get(ctx)
      if (userMessage?.isSimulatedMsg === true || userMessage?.selectedContext === undefined) continue
      const attachedContext = fromRedactedSelectedContext(userMessage.selectedContext, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED, {})
      for (const selectedVideo of attachedContext.selectedVideos) {
        const videoPath = selectedVideo.path.trim()
        if (videoPath.length > 0) videoPaths.add(videoPath)
      }
    }
    return [...videoPaths]
  })()
}

/** A stream torn down mid-flight reaches the caller as either the class or its message. */
function isWritableIterableClosedError(error: unknown): boolean {
  return error instanceof WriteIterableClosedError || error instanceof Error && error.message.includes("WritableIterable is closed")
}

function modelParameters(value: readonly unknown[] | undefined): Array<{ id: string; value: string }> | undefined {
  if (value === undefined) return undefined
  return value.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return []
    const record = Object.fromEntries(Object.entries(entry))
    return typeof record.id === "string" && typeof record.value === "string"
      ? [{ id: record.id, value: record.value }]
      : []
  })
}

export async function executeClientSideTaskSubagent(args: ClientTaskExecutionArgs): Promise<TaskResult> {
  const {
    ctx,
    rawArgs: rawInput,
    resolved,
    resourceAccessor,
    stateHandler,
    parentModelName,
    contextInjectionSignal,
  } = args
  const startedAt = Date.now()
  const executorResource = resourceAccessor.get(subagentExecutorResource)
  const continuationConfig = buildClientContinuationConfig(resolved.subagentConfig)
  const parentConversation = getConversationId(ctx)
  const rootParentConversation = getConversationGroupId(ctx)
  const backgroundRun = rawInput.run_in_background ?? resolved.subagentConfig.isBackground
  let attachedContext
  if ((rawInput.file_attachments?.length ?? 0) > 0) {
    const videoPaths = await getUserAttachedVideoPaths(ctx, stateHandler)
    const mediaOptions = {
      resolvedModelId: resolved.resolvedModelId,
      privacyMode: stateHandler.getPrivacyMode(),
      // A model that watches video gets the bytes or a signed URL; which provider can do that depends on
      // the subagent type, so the gemini-specific provider is preferred for the types that need it.
      ...(isGeminiVideoSubagentType(resolved.subagentConfig.subagent_type)
        ? (args.geminiVideoAttachedMediaUrlProvider ?? args.attachedMediaUrlProvider) !== undefined
          ? { attachedMediaUrlProvider: args.geminiVideoAttachedMediaUrlProvider ?? args.attachedMediaUrlProvider }
          : {}
        : args.attachedMediaUrlProvider !== undefined ? { attachedMediaUrlProvider: args.attachedMediaUrlProvider } : {}),
      ...(parentConversation !== undefined ? { conversationId: parentConversation } : {}),
      ...(args.inlineVideoMaxBytes !== undefined ? { inlineVideoMaxBytes: args.inlineVideoMaxBytes } : {}),
      ...(args.signedUrlVideoMaxBytes !== undefined ? { signedUrlVideoMaxBytes: args.signedUrlVideoMaxBytes } : {}),
      videoPaths,
      ...(args.trustedVideoAttachmentRoots !== undefined ? { trustedVideoAttachmentRoots: args.trustedVideoAttachmentRoots } : {}),
    }
    attachedContext = await buildClientSubagentAttachmentsContext(ctx, rawInput.file_attachments!, resourceAccessor, args.toolCallId, mediaOptions)
  }
  let stopHandoff: (() => void) | undefined
  if (contextInjectionSignal !== undefined && backgroundRun !== true) {
    let stopped = false
    let handoffRunning = false
    let handoffGranted = false
    let retryHandle: ReturnType<typeof setTimeout> | undefined
    let unsubscribeInjection: (() => void) | undefined
    const requestHandoff = (): void => {
      if (stopped || handoffRunning || handoffGranted) return
      handoffRunning = true
      void (async () => {
        try {
          const handoffExecutor = resourceAccessor.get(forceBackgroundSubagentExecutorResource)
          const result = await handoffExecutor.execute(ctx, new ForceBackgroundSubagentArgs({ toolCallId: args.toolCallId }))
          if (result.status === ForceBackgroundSubagentStatus.ACCEPTED) handoffGranted = true
        } catch {
          // A missing or torn-down handoff resource is intentionally fail-closed.
        } finally {
          handoffRunning = false
          // An injection that is still waiting keeps asking, since the first request may have been refused.
          if (!stopped && !handoffGranted && retryHandle === undefined && contextInjectionSignal.hasPendingUserInjections()) {
            retryHandle = setTimeout(() => {
              retryHandle = undefined
              requestHandoff()
            }, 500)
          }
        }
      })()
    }
    stopHandoff = () => {
      stopped = true
      if (retryHandle !== undefined) clearTimeout(retryHandle)
      unsubscribeInjection?.()
    }
    unsubscribeInjection = contextInjectionSignal.onUserInjectionAdmitted(requestHandoff)
    if (contextInjectionSignal.hasPendingUserInjections()) requestHandoff()
  }
  try {
    let result: SubagentResult
    try {
      result = await executorResource.execute(ctx, new SubagentArgs({
        toolCallId: args.toolCallId,
        subagentType: resolved.typeName,
        modelId: resolved.resolvedModelId,
        prompt: rawInput.prompt,
        readonly: resolved.useAskModeForSubagent,
        // Resuming and forking are two different identities, so only one of them is ever sent.
        ...(resolved.isSelfForkRequested ? {} : resolved.subagentIdToResume !== undefined ? { resumeAgentId: resolved.subagentIdToResume } : {}),
        ...(resolved.isSelfForkRequested && parentConversation !== undefined ? { forkAgentId: parentConversation } : {}),
        ...(args.enableSubagentInterrupt === true && args.interrupt === true ? { interrupt: true } : {}),
        ...(backgroundRun !== undefined ? { runInBackground: backgroundRun } : {}),
        ...(continuationConfig !== undefined ? { continuationConfig } : {}),
        ...(rootParentConversation !== undefined ? { rootParentConversationId: rootParentConversation } : {}),
        ...(parentConversation !== undefined ? { parentConversationId: parentConversation } : {}),
        ...(attachedContext !== undefined ? { selectedContext: attachedContext } : {}),
        environment: resolved.effectiveEnvironment,
        // A resumed run keeps its own base branch; a fresh cloud run takes the one the request or the
        // target machine asked for.
        ...(resolved.subagentIdToResume === undefined
          ? rawInput.cloud_base_branch !== undefined
            ? { cloudBaseBranch: rawInput.cloud_base_branch }
            : resolved.effectiveTargetMachine.type === "new_cloud_vm" && resolved.effectiveTargetMachine.base_branch !== undefined
              ? { cloudBaseBranch: resolved.effectiveTargetMachine.base_branch }
              : {}
          : rawInput.cloud_base_branch !== undefined ? { cloudBaseBranch: rawInput.cloud_base_branch } : {}),
        ...(modelParameters(resolved.resolvedModelParameters) !== undefined ? { modelParameters: modelParameters(resolved.resolvedModelParameters)! } : {}),
        ...(args.subagentCredentials !== undefined ? { credentials: args.subagentCredentials } : {}),
      }))
    } finally {
      stopHandoff?.()
    }
    if (result.result.case === "error") {
      throw new Error(maybeAppendInterruptRetryHint(result.result.value.error || "Unknown subagent error", args.enableSubagentInterrupt === true, args.interrupt === true))
    }
    if (result.result.case !== "success") throw new Error("Unknown subagent result")
    const successResult = result.result.value
    // A follow-up that arrived while the subagent was still running is an error the model should read as
    // one, since the run it meant to steer never took it.
    if (successResult.backgroundReason === SubagentBackgroundReason.QUEUED_FOLLOW_UP) {
      return new TaskResult({ result: { case: "error", value: new TaskError({ error: maybeAppendInterruptRetryHint(RUNNING_SUBAGENT_FOLLOWUP_ERROR, args.enableSubagentInterrupt === true, args.interrupt === true) }) } })
    }
    // A cloud run's identity is the box it ran in; a local one keeps the id it already had.
    const runAgentId = resolved.effectiveEnvironment === SubagentExecutionEnvironment.CLOUD
      ? successResult.agentId
      : successResult.agentId ?? resolved.subagentId
    if (runAgentId !== undefined && runAgentId.length > 0) {
      const savedState = resolved.effectiveEnvironment === SubagentExecutionEnvironment.CLOUD
        ? buildCloudSubagentPersistedState({ bcId: runAgentId, modelId: resolved.resolvedModelId, ...(successResult.transcriptPath !== undefined ? { transcriptPath: successResult.transcriptPath } : {}), machine: resolved.effectiveTargetMachine })
        : new SubagentPersistedState({ modelId: resolved.resolvedModelId })
      stateHandler.persistSubagentState(ctx, runAgentId, resolved.subagentConfig.subagent_type, savedState)
    }
    const wentToBackground = successResult.backgroundReason !== SubagentBackgroundReason.UNSPECIFIED
    const conversationSteps: ConversationStep[] = []
    // A background run has not answered yet, so its final message is not an answer to show.
    if (!wentToBackground && successResult.finalMessage) {
      conversationSteps.push(new ConversationStep({ message: { case: "assistantMessage", value: new AssistantMessage({ text: successResult.finalMessage }) } }))
    }
    return new TaskResult({ result: { case: "success", value: new TaskSuccess({ conversationSteps, durationMs: BigInt(Date.now() - startedAt), ...(runAgentId !== undefined ? { agentId: runAgentId } : {}), isBackground: wentToBackground, backgroundReason: successResult.backgroundReason, ...(successResult.transcriptPath !== undefined ? { transcriptPath: successResult.transcriptPath } : {}) }) } })
  } catch (error) {
    const failureMessage = isWritableIterableClosedError(error)
      ? SUBAGENT_STREAM_CLOSED_ERROR
      : error instanceof Error ? error.message : String(error)
    return new TaskResult({ result: { case: "error", value: new TaskError({ error: failureMessage }) } })
  }
}

export function renderClientTaskResult(result: TaskResult, renderOptions?: TaskResultRenderingOptions): TextResult {
  return createStringResult(renderTaskResultToString(result, renderOptions), result.result.case === "error")
}
