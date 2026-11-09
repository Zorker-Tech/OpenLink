/**
 * The one place a turn talks to the outside while it runs.
 *
 * Everything the user sees during a turn passes through here — the text as it arrives, the thinking before
 * it, the tool calls and their results — and so does everything the turn needs back: the abort signal, the
 * recorder that keeps the conversation's tool calls, the queries the tools ask. Having it in one place is
 * what makes the stream observable rather than assumed, and it is why the small accounting lives here too:
 * tokenCount are estimated as they stream (four characters to a token, with the remainder carried to the next
 * chunk so the estimate does not drift), tool-call latency and output size are measured, and a send that
 * takes suspiciously long is logged, because a stalled stream is the failure that looks like nothing
 * happening.
 *
 * Two behaviours here are subtler than they look. A tool call's arguments can arrive in pieces, and when a
 * call fails the arguments that did arrive are worth keeping: a call marked for preservation has its latest
 * version remembered, and an error is reported with those arguments merged back in, so the user sees what
 * the model was trying to do rather than an empty call. And the stream is watched for a model repeating
 * itself: a single message looping is detected as the text arrives and ends the turn with an error the
 * client can explain, while an input-token-limit failure is not an error at all but a signal to summarize,
 * so it is swallowed here and left to the caller. A failure that came from the consumer — the thing
 * receiving updates, not the model — is passed on, because swallowing it would hide a broken client.
 */

import { createLogger, createSpan } from "../context/index.ts"
import { createCounter, createHistogram } from "../metrics/index.ts"
import { SlateInteractionUpdates, Updates } from "../agent-core/interaction-updates.ts"
import type { SlateToolCallUpdatePhase } from "../agent-core/interaction-update-contracts.ts"
import type { SlateTaskProgressUpdate } from "./tools/task-progress-state.ts"
import { InputTokenLimitError } from "../chat-inference/prompt-executor.ts"
import { PrivacyMode } from "../redaction/privacy-mode.ts"
import {
  appendEditToolCallDeltaInterop,
  hookAdditionalContextsToInterop,
  isAskQuestionToolCallInterop,
  mergeLatestToolCallArgsInterop,
  redactInteractionToolCallInterop,
  slateInteractionToolCallValueFromInterop,
  stampToolCallMetadataInterop,
  toolCallNameInterop,
} from "../../adapters/interop/agent/interaction-tool-call-adapter.ts"
import { ToolCallAbortedError } from "./tools/tool-errors.ts"
import { AgentLoopError } from "../../adapters/interop/agent/agent-loop-presentation-adapter.ts"
import { checkAgentLoop, AgentTextLoopDetector } from "./loop-detection/agent-loop-detector.ts"

type Loose = any;

/** A promise whose settling is decided elsewhere: how a tool call is raced against an abort. */
function makeDeferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(reason: unknown): void } {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

/**
 * Whether an error is a single-message loop the turn should end with.
 *
 * The check is by name and shape rather than by `instanceof`: the connect error this class extends defines a
 * `Symbol.hasInstance` that only recognizes its own name, so a subclass instance is not an instance of its
 * own class. Reading the fields the error carries is what the check was always meant to be.
 */
function isLoopError(error: unknown): error is AgentLoopError {
  return error instanceof Error &&
    error.name === "AgentLoopError" &&
    (error as { loopType?: unknown }).loopType === "singleMessage"
}

const logger = createLogger("interaction-handler");
const THINKING_CHUNK_TYPES = ["reasoning", "reasoning-signature", "redacted-reasoning"];
const toolCallLatency = createHistogram("agent.tool_call.latency_ms", {
  description: "Latency of tool calls in milliseconds",
  labelNames: ["tool_name"],
});
const toolCallCount = createCounter("agent.tool_call.count", {
  description: "Total number of tool calls executed",
  labelNames: ["tool_name"],
});
const toolCallOutputTokens = createHistogram("agent.tool_call.output_tokens", {
  description: "Approximate number of tokenCount in tool call output (text.length / 4)",
  labelNames: ["tool_name"],
});
const toolCallResultTokens = createHistogram("agent.tool_call_result_tokens", {
  description: "Number of tokenCount in tool call result content",
  labelNames: ["tool_name", "success"],
});

export class InteractionHandler {
  declare readonly interactionProvider: Loose;
  declare readonly toolCallRecorder: Loose;
  declare readonly invocationId: string;
  declare readonly overrideSignal: AbortSignal | undefined;
  declare readonly thinkingStyle: Loose;
  declare readonly enableSingleMessageLoopDetection: boolean;
  declare readonly onThinkingCompleted: Loose;
  declare readonly latestToolCallsById: Map<string, Loose>;
  declare readonly shouldPreserveArgsOnErrorCallIds: Set<string>;
  declare readonly toolCallStartedAtMsByCallId: Map<string, number>;
  declare leftoverTokenCharCount: number;

  constructor(
    interactionProvider: Loose,
    toolCallRecorder: Loose,
    invocationId: string,
    overrideSignal?: AbortSignal,
    thinkingStyle?: Loose,
    enableSingleMessageLoopDetection = false,
    onThinkingCompleted?: Loose,
  ) {
    this.interactionProvider = interactionProvider;
    this.toolCallRecorder = toolCallRecorder;
    this.invocationId = invocationId;
    this.overrideSignal = overrideSignal;
    this.thinkingStyle = thinkingStyle;
    this.enableSingleMessageLoopDetection = enableSingleMessageLoopDetection;
    this.onThinkingCompleted = onThinkingCompleted;
    this.latestToolCallsById = new Map();
    this.shouldPreserveArgsOnErrorCallIds = new Set();
    this.toolCallStartedAtMsByCallId = new Map();
    this.leftoverTokenCharCount = 0;
  }

  get listener(): Loose {
    return this.interactionProvider;
  }

  /** A caller may supply its own signal, which then stands in for the context's. */
  getAbortSignal(context: Loose): AbortSignal {
    return this.overrideSignal ?? context.signal;
  }

  /** From here on, the latest version of this call is remembered so an error can carry its arguments. */
  markToolCallForArgPreservation(callId: string): void {
    this.shouldPreserveArgsOnErrorCallIds.add(callId);
  }

  rememberToolCallForArgPreservation(callId: string, pendingCall: Loose): void {
    this.rememberLatestToolCall(callId, pendingCall);
  }

  applyArgsFromLatestToolCall(callId: string, incomingCall: Loose): Loose {
    const previousCall = this.latestToolCallsById.get(callId);
    return previousCall === undefined
      ? incomingCall
      : mergeLatestToolCallArgsInterop(previousCall, incomingCall);
  }

  rememberLatestToolCall(callId: string, pendingCall: Loose): void {
    if (!this.shouldPreserveArgsOnErrorCallIds.has(callId)) return;
    this.latestToolCallsById.set(callId, this.applyArgsFromLatestToolCall(callId, pendingCall));
  }

  async upsertRecordedToolCall(context: Loose, callId: string, pendingCall: Loose): Promise<void> {
    if (this.toolCallRecorder.upsertToolCall !== undefined) {
      await this.toolCallRecorder.upsertToolCall(context, pendingCall, callId);
      return;
    }
    this.toolCallRecorder.recordToolCall(pendingCall, callId);
  }

  applyDeltaToLatestToolCall(callId: string, callDelta: Loose): void {
    if (!this.shouldPreserveArgsOnErrorCallIds.has(callId)) return;
    appendEditToolCallDeltaInterop(this.latestToolCallsById.get(callId), callDelta);
  }

  withToolCallMetadata(callId: string, value: Loose, timestamps?: { startedAtMs?: number | undefined; completedAtMs?: number | undefined }): Loose {
    return stampToolCallMetadataInterop(callId, value, timestamps) as Loose;
  }

  async emitTokenDeltaFromChars(context: Loose, addedChars: string): Promise<void> {
    const totalChars = this.leftoverTokenCharCount + addedChars.length;
    const tokenCount = Math.floor(totalChars / 4);
    this.leftoverTokenCharCount = totalChars % 4;
    if (tokenCount > 0) await this.interactionProvider.sendUpdate(context, SlateInteractionUpdates.tokenDelta(tokenCount));
  }

  isConsumerSideError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    if (error.name === "CacheRuntimeError" || error.message.includes("Cache operation") || error.message.includes("Redis") || error.message.includes("xadd")) return true;
    const stack = error.stack ?? "";
    const stackFrames = stack.split("\n").slice(1).join("\n");
    return stackFrames.includes("sendUpdate") || stackFrames.includes("appendUpdateToConversationStreamAsync") || stackFrames.includes("pushAsync") || stackFrames.includes("conversationStream");
  }

  /** Reads the model's stream: text, thinking, and the tool-call deltas that arrive alongside them. */
  async consumeStream(context: Loose, chunkStream: AsyncIterable<Loose>, transcriptHandler: Loose): Promise<void> {
    let textSoFar = "";
    let thinkingText = "";
    let thinkingStartedAt: number | undefined;
    let thinkingOpen = false;
    const loopDetector = this.enableSingleMessageLoopDetection ? new AgentTextLoopDetector() : null;
    const closeThinking = async () => {
      if (!thinkingOpen || thinkingStartedAt === undefined) return;
      thinkingOpen = false;
      const thinkingMs = Math.max(1, Date.now() - thinkingStartedAt);
      await this.interactionProvider.sendUpdate(context, SlateInteractionUpdates.thinkingCompleted(thinkingMs));
      await transcriptHandler.recordThinking(context, "", thinkingMs);
      const finishedThinkingText = thinkingText;
      thinkingText = "";
      void this.onThinkingCompleted?.(context, { text: finishedThinkingText, durationMs: thinkingMs }).catch((error: unknown) => {
        logger.warn(context, "afterAgentThought hook callback failed", { error: error instanceof Error ? error.message : String(error) });
      });
    };
    try {
      for await (const chunk of chunkStream) {
        if (chunk.type === "reasoning-signature") {
          if (thinkingText.length > 0) await closeThinking();
          continue;
        }
        if (thinkingOpen && !THINKING_CHUNK_TYPES.includes(chunk.type)) await closeThinking();
        if (chunk.type === "text-delta") {
          textSoFar += chunk.textDelta;
          if (loopDetector !== null) {
            const loopResult = checkAgentLoop({ ctx: context, newText: chunk.textDelta, detector: loopDetector, caller: "nal" });
            if (loopResult.loopDetected) {
              throw new AgentLoopError({
                loopType: "singleMessage",
                loopKind: loopResult.loopKind ?? "single_message_multi_line",
                repetitions: loopResult.repetitions ?? 0,
                period: loopResult.period,
              });
            }
          }
          await this.interactionProvider.sendUpdate(context, SlateInteractionUpdates.textDelta(chunk.textDelta));
          await this.emitTokenDeltaFromChars(context, chunk.textDelta);
          await transcriptHandler.recordText(context, chunk.textDelta);
        } else if (THINKING_CHUNK_TYPES.includes(chunk.type)) {
          if (!thinkingOpen) {
            thinkingStartedAt = Date.now();
            thinkingOpen = true;
          }
          let delta = "";
          if (chunk.type === "reasoning") delta = chunk.textDelta;
          thinkingText += delta;
          await this.interactionProvider.sendUpdate(context, SlateInteractionUpdates.thinkingDelta(delta, this.thinkingStyle));
          await this.emitTokenDeltaFromChars(context, delta);
          await transcriptHandler.recordThinking(context, delta);
        } else if (chunk.type === "tool-call-delta") {
          await this.emitTokenDeltaFromChars(context, chunk.argsTextDelta);
        }
      }
    } catch (error) {
      if (isLoopError(error)) throw error;
      if (error instanceof InputTokenLimitError) {
        logger.warn(context, "InputTokenLimitError will trigger blocking summarization", { error });
        return;
      }
      const streamAbortReason = context.reason;
      const isStreamIntentionalAbort = context.canceled && streamAbortReason?.intentional === true;
      if (isStreamIntentionalAbort) logger.info(context, "consumeStream aborted (intentional cancellation)", { error, intentionalAbort: true, abortReason: streamAbortReason?.reason });
      else logger.error(context, "Error in consumeStream", error);
      if (this.isConsumerSideError(error)) throw error;
    }
  }

  async emitPartialToolCall(context: Loose, callId: string, pendingCall: Loose): Promise<void> {
    const stampedCall = this.withToolCallMetadata(callId, pendingCall, undefined);
    this.rememberLatestToolCall(callId, stampedCall);
    await this.emitToolCallUpdate(context, "partial", callId, stampedCall);
  }

  /** Sends one Slate lifecycle update, preserving the caller's model identity when a tool update is synthetic. */
  async emitToolCallUpdate(
    context: Loose,
    phase: SlateToolCallUpdatePhase,
    callId: string,
    toolCall: Loose | undefined,
    modelCallId = this.invocationId,
  ): Promise<void> {
    const value = toolCall === undefined ? undefined : slateInteractionToolCallValueFromInterop(toolCall, callId);
    const update = phase === "started"
      ? SlateInteractionUpdates.toolCallStarted(callId, value, modelCallId)
      : phase === "partial"
        ? SlateInteractionUpdates.partialToolCall(callId, value, modelCallId)
        : SlateInteractionUpdates.toolCallCompleted(callId, value, modelCallId);
    await this.interactionProvider.sendUpdate(context, update);
  }

  async recordPendingToolCall(context: Loose, callId: string, pendingCall: Loose): Promise<void> {
    const stampedCall = this.withToolCallMetadata(callId, pendingCall, undefined);
    const redactedCall = redactInteractionToolCallInterop(stampedCall, PrivacyMode.UNSPECIFIED);
    if (this.toolCallRecorder.recordPendingToolCall !== undefined) {
      await this.toolCallRecorder.recordPendingToolCall(context, redactedCall, callId);
      return;
    }
    await this.upsertRecordedToolCall(context, callId, redactedCall);
  }

  async emitToolCallDelta(context: Loose, callId: string, callDelta: Loose): Promise<void> {
    this.applyDeltaToLatestToolCall(callId, callDelta);
    await this.interactionProvider.sendUpdate(context, Updates.toolCallDelta(callId, callDelta, this.invocationId));
  }

  async emitTaskProgressUpdate(context: Loose, toolCallId: string, update: SlateTaskProgressUpdate): Promise<boolean> {
    const sendTaskProgressUpdate = this.interactionProvider.sendTaskProgressUpdate
    if (typeof sendTaskProgressUpdate !== "function") return false
    await sendTaskProgressUpdate.call(this.interactionProvider, context, toolCallId, this.invocationId, update)
    return true
  }

  async emitToolCallError(context: Loose, callId: string, failedCall: Loose): Promise<void> {
    const shouldPreserveArgs = this.shouldPreserveArgsOnErrorCallIds.has(callId);
    const mergedCall = shouldPreserveArgs ? this.applyArgsFromLatestToolCall(callId, failedCall) : failedCall;
    const stampedCall = this.withToolCallMetadata(callId, mergedCall, { startedAtMs: this.toolCallStartedAtMsByCallId.get(callId), completedAtMs: Date.now() });
    this.toolCallStartedAtMsByCallId.delete(callId);
    this.latestToolCallsById.delete(callId);
    this.shouldPreserveArgsOnErrorCallIds.delete(callId);
    await this.emitToolCallUpdate(context, "completed", callId, stampedCall);
    const redactedCall = redactInteractionToolCallInterop(stampedCall, PrivacyMode.UNSPECIFIED);
    if (isAskQuestionToolCallInterop(stampedCall)) await this.upsertRecordedToolCall(context, callId, redactedCall);
    else this.toolCallRecorder.recordToolCall(redactedCall, callId);
  }

  async recordToolCallResult(context: Loose, result: Loose, loggedName: string, failureClassification?: unknown): Promise<void> {
    let textLength = 0;
    for (const part of result.content) {
      if (part.type === "text") {
        textLength += part.text.length;
        await this.emitTokenDeltaFromChars(context, part.text);
      }
    }
    if (textLength > 0) {
      const tokenEstimate = Math.floor(textLength / 4);
      toolCallOutputTokens.histogram(context, tokenEstimate, { tool_name: loggedName });
      toolCallResultTokens.histogram(context, tokenEstimate, { tool_name: loggedName, success: failureClassification === undefined ? "true" : "false" });
    }
  }

  async sendHeartbeat(context: Loose): Promise<void> {
    await this.interactionProvider.sendUpdate(context, SlateInteractionUpdates.heartbeat());
  }

  /** Runs a tool call, announcing it before and after, and recording it once it is done. */
  async executeToolCall(
    parentContext: Loose,
    pendingCall: Loose,
    callId: string,
    runToolFn: (context: Loose) => Promise<Loose>,
    mergeResultFn: (result: Loose) => Loose,
    hookContexts?: readonly Loose[],
  ): Promise<Loose> {
    using executionSpan = createSpan(parentContext.withName("executeToolCall"));
    const context = executionSpan.ctx;
    const startUpdateAt = Date.now();
    this.toolCallStartedAtMsByCallId.set(callId, startUpdateAt);
    {
      using startUpdateSpan = createSpan(context.withName("executeToolCall.sendStartUpdate"));
      const stampedCall = this.withToolCallMetadata(callId, pendingCall, { startedAtMs: startUpdateAt });
      this.rememberLatestToolCall(callId, stampedCall);
      await this.emitToolCallUpdate(startUpdateSpan.ctx, "started", callId, stampedCall);
    }
    const startUpdateMs = Date.now() - startUpdateAt;
    if (startUpdateMs > 1_000) logger.warn(context, "nal.await_stall.start_send_slow", { callId, toolName: toolCallNameInterop(pendingCall), startSendMs: startUpdateMs });
    const executionStartedAt = Date.now();
    let result: Loose;
    const cancelSignal = this.getAbortSignal(context);
    const settle = makeDeferred<Loose>();
    if (cancelSignal.aborted) throw new ToolCallAbortedError();
    else cancelSignal.addEventListener("abort", () => settle.reject(new ToolCallAbortedError()), { once: true });
    runToolFn(context).then(value => {
      result = value;
      const completedCall = mergeResultFn(value);
      if (hookContexts && hookContexts.length > 0) {
        completedCall.hookAdditionalContexts.push(...hookAdditionalContextsToInterop(hookContexts));
      }
      settle.resolve(completedCall);
    }).catch((error: unknown) => settle.reject(error));
    const completedCall = this.withToolCallMetadata(callId, await settle.promise, { startedAtMs: startUpdateAt, completedAtMs: Date.now() });
    this.toolCallStartedAtMsByCallId.delete(callId);
    this.rememberLatestToolCall(callId, completedCall);
    const executionMs = Date.now() - executionStartedAt;
    const toolName = toolCallNameInterop(pendingCall);
    toolCallLatency.histogram(context, executionMs, { tool_name: toolName });
    toolCallCount.increment(context, 1, { tool_name: toolName });
    const completionSendStartMs = Date.now();
    {
      using completionSendSpan = createSpan(context.withName("executeToolCall.sendCompletionUpdate"));
      await this.emitToolCallUpdate(completionSendSpan.ctx, "completed", callId, completedCall);
    }
    const completionSendMs = Date.now() - completionSendStartMs;
    if (completionSendMs > 1_000) logger.warn(context, "nal.await_stall.completion_send_slow", { callId, toolName, toolExecutionMs: executionMs, completionSendMs });
    const redactedCall = redactInteractionToolCallInterop(completedCall, PrivacyMode.UNSPECIFIED);
    if (isAskQuestionToolCallInterop(completedCall)) await this.upsertRecordedToolCall(context, callId, redactedCall);
    else this.toolCallRecorder.recordToolCall(redactedCall, callId);
    this.latestToolCallsById.delete(callId);
    this.shouldPreserveArgsOnErrorCallIds.delete(callId);
    return result!;
  }

  async query(context: Loose, query: Loose): Promise<Loose> {
    return this.interactionProvider.query(context, query);
  }
}
