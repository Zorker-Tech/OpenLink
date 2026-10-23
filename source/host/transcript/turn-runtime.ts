/** Running one turn of a conversation.

 * A turn is traced, given the context it replies in, run against its runner, and then looked at: what the agent said,
 * what it should have said, what went wrong, and whether another attempt is worth making — with the nudges, the
 * follow-up turns and the recovery sends that come out of that all decided here. */
import { isMessageAddress } from "../../shared/message-reference.ts";
import { slateDualSurfaceToolTelemetry } from "../../shared/agents/agent-tool-names.ts";
import { SLATE_REACTION_AGENT } from "../../shared/transcript.ts";
import { UNKNOWN_CONNECTOR_TAG } from "../../shared/observability/connector-auth-telemetry.ts";
import { slateErrorDetail } from "../ports/telemetry.ts";
import {
  isContextOverflowDeadEnd,
  isConversationTooLargeRefusal,
  isFirstTokenStallError,
  isProviderCapacityError,
  isRetryableProviderError,
  isTransientStreamError,
  serverRetryAfterMsFromError,
} from "../runner/transient-stream-error.ts";
import {
  beginTurnTrace,
  markTurnTraceError,
  resolveTurnTraceOutcome,
  setTurnTraceAttributes,
  type HostTrace,
} from "../send-trace-host.ts";
import { brandedEnumOf, brandedErrno } from "../../shared/errors/bounded-values.ts";
import { SlateError } from "../../shared/errors/registry.ts";
import { findSystemErrno } from "../../shared/system-errno.ts";
import {
  describeAgentRunError,
  findBackendConnectError,
  PROVIDER_OVERLOAD_ERROR_TITLE,
} from "./agent-run-error.ts";
import {
  createSendMessageEntry,
  describeRepliedMessageQuote,
  isUserMessageEntry,
  stampBoxRequestEntry,
  type SendMessage,
} from "./send-message-shaping.ts";
import { nextEntryId } from "./transcript-entry-ids.ts";
import type {
  TranscriptEntry,
  TranscriptManagerLike,
} from "./transcript-hub.ts";
import { getTranscript, updateEntry } from "./transcript-store.ts";
import type { LiveTranscriptSession } from "./session-runtime.ts";

export const MAX_REPLY_NUDGES = 3;
export const REPLY_NUDGE_PROMPT =
  "Your previous turn left the user without the result they're waiting on — you never called SendMessage that turn, or every SendMessage you tried failed to deliver. Either way they received nothing and are still waiting. Do not assume a send from an earlier turn covered it: an opening acknowledgement back then did not deliver this result (ack ≠ delivery). Deliver the result now by actually invoking the SendMessage tool — make a real tool/function call, not text you write. Plain assistant text is NEVER shown to the user; only a real SendMessage tool invocation reaches them, so if you don't call the tool they just keep seeing silence.";
export const CLOSING_SEND_NUDGE_PROMPT =
  "Your previous turn acknowledged the user and then ran tool calls, but ended without a follow-up SendMessage — the last thing the user saw is that opening acknowledgement, so whatever the tool calls produced after it never reached them. If that work produced the result or answer they are waiting on, deliver it now by actually invoking the SendMessage tool — make a real tool/function call, not text you write. Plain assistant text is NEVER shown to the user; only a real SendMessage tool invocation reaches them. If the work is genuinely unfinished, continue it and send the result once you have it.";
export const TASK_ERROR_RESULT_CLASS = "task_error_result";
export const CONNECT_CODE_NAMES = [
  "Canceled",
  "Unknown",
  "InvalidArgument",
  "DeadlineExceeded",
  "NotFound",
  "AlreadyExists",
  "PermissionDenied",
  "ResourceExhausted",
  "FailedPrecondition",
  "Aborted",
  "OutOfRange",
  "Unimplemented",
  "Internal",
  "Unavailable",
  "DataLoss",
  "Unauthenticated",
] as const;
export const connectCodeTag = brandedEnumOf(CONNECT_CODE_NAMES, "Other");

export interface TurnTraceContext {
  withName(name: string): unknown;
}

export type TurnCompletedSpanRecorder = (
  context: unknown,
  settings: {
    readonly startTime: Date;
    readonly attributes: Readonly<Record<string, unknown>>;
  },
  endTime: Date,
) => void;

let turnCompletedSpanRecorder: TurnCompletedSpanRecorder | undefined;

/** Supplies the bundle-scope tracing helper without guessing an OTel runtime. */
export function setTurnCompletedSpanRecorder(
  recorder: TurnCompletedSpanRecorder | undefined,
): void {
  turnCompletedSpanRecorder = recorder;
}

export function recordTurnQueueWaitSpan(input: {
  traceCtx: unknown;
  queueStartEpochMs?: number;
  queueStartPerfMs?: number;
  conversationId: string;
  clientNonce?: string;
}): void {
  if (
    turnCompletedSpanRecorder == null ||
    input.queueStartEpochMs == null ||
    input.queueStartPerfMs == null ||
    input.traceCtx == null ||
    typeof input.traceCtx !== "object" ||
    !("withName" in input.traceCtx) ||
    typeof input.traceCtx.withName !== "function"
  ) {
    return;
  }
  try {
    const queueWaitMs = Math.max(
      0,
      Math.round(performance.now() - input.queueStartPerfMs),
    );
    turnCompletedSpanRecorder(
      (input.traceCtx as TurnTraceContext).withName("turn-queue-wait"),
      {
        startTime: new Date(input.queueStartEpochMs),
        attributes: {
          "slate.queue_wait_ms": queueWaitMs,
          "slate.conversation_id": input.conversationId,
          ...(input.clientNonce != null && input.clientNonce.length > 0
            ? { "slate.client_nonce": input.clientNonce }
            : {}),
        },
      },
      new Date(input.queueStartEpochMs + queueWaitMs),
    );
  } catch {}
}

export function connectCodeOf(error: unknown): string | undefined {
  const connectError = findBackendConnectError(error, false);
  if (connectError == null || typeof connectError.code !== "number") {
    return undefined;
  }
  return connectCodeTag(CONNECT_CODE_NAMES[connectError.code - 1]);
}

export interface TurnResult {
  sentMessageCount: number;
  reacted: boolean;
  aborted: boolean;
  quiescedForUpgrade?: boolean;
  streamOutputProduced?: boolean;
  endedOnSilentToolCalls?: boolean;
  awaitingUserSelection?: boolean;
}

export interface AgentRunner {
  run(prompt: string, settings: Record<string, unknown>): Promise<TurnResult>;
  wouldRecoverViaPrepend?(
    recent: readonly unknown[],
    latestMessageId: string,
    skippedMessageId: string,
  ): Promise<boolean>;
  getObservedToolCallCount?(): number;
}

export interface TurnOptions extends Record<string, unknown> {
  readonly selectedImages: readonly unknown[];
  readonly messageId?: string;
  readonly recentUserMessages?: readonly { id: string; text: string }[];
  readonly selectedVideos?: readonly unknown[];
  readonly attachedFilePaths?: readonly string[];
  readonly replyContext?: { targetId: string };
  readonly isFork?: boolean;
  readonly traceCtx?: unknown;
  readonly queueStartEpochMs?: number;
  readonly queueStartPerfMs?: number;
  readonly clientNonce?: string;
  readonly ackToken?: string;
}

export function isDeliveryOwed(
  turnResult: Pick<TurnResult, "sentMessageCount" | "reacted">,
): boolean {
  return turnResult.sentMessageCount === 0 && !turnResult.reacted;
}

export function classifyAgentError(error: unknown): Record<string, unknown> {
  if (isProviderCapacityError(error)) {
    const retryAfterMs = serverRetryAfterMsFromError(error);
    if (retryAfterMs !== undefined) {
      return SlateError.backendCapacityDeferred({
        connectCode: connectCodeOf(error),
        retryAfterMs,
      });
    }
    return SlateError.providerOverloaded({ connectCode: connectCodeOf(error) });
  }
  if (isFirstTokenStallError(error)) return SlateError.firstTokenStall();
  if (isContextOverflowDeadEnd(error)) return SlateError.contextWindowOverflow();
  if (isConversationTooLargeRefusal(error)) {
    return SlateError.conversationTooLarge();
  }
  const connectCode = connectCodeOf(error);
  if (isRetryableProviderError(error)) {
    if (isTransientStreamError(error)) {
      return SlateError.streamReset({
        connectCode,
        errno: brandedErrno(findSystemErrno(error)),
      });
    }
    return SlateError.turnRetryable({ connectCode });
  }
  if (connectCode !== undefined) {
    return SlateError.backendRejected({ connectCode });
  }
  return SlateError.agentUnclassified();
}

type CardPredicate = (transcriptEntry: TranscriptEntry) => boolean;
type CardUpdate = (transcriptEntry: TranscriptEntry) => TranscriptEntry;

function messageOf(transcriptEntry: TranscriptEntry): Record<string, any> | undefined {
  return typeof transcriptEntry.message === "object" && transcriptEntry.message != null
    ? (transcriptEntry.message as Record<string, any>)
    : undefined;
}

export class TurnRuntime {
  readonly replyThreadTargets = new Map<LiveTranscriptSession, string>();
  readonly forkTurnSessions = new Set<LiveTranscriptSession>();
  readonly activeRequestPrompts = new Map<string, string>();
  readonly activeRequestSources = new Map<string, string>();
  readonly activeTurnEpochs = new Map<string, number>();
  readonly activeTurns = new Map<string, Record<string, any>>();
  readonly reportedDualSurfaceToolCalls = new Map<string, Set<string>>();
  readonly reportedToolCallErrors = new Map<string, Set<string>>();
  readonly reportedToolCallStalls = new Map<string, Set<string>>();
  readonly pendingToolCallStarts = new Map<string, Map<string, number>>();

  constructor(readonly tm: TranscriptManagerLike) {}

  settleCardStatus(input: {
    runSession?: LiveTranscriptSession | null;
    isForActiveAgent: boolean;
    matchesCard: CardPredicate;
    applyStatus: CardUpdate;
  }): void {
    const targetSession =
      input.runSession ?? this.tm.sessions.activeSession ?? null;
    const persistedTarget = targetSession?.db
      .getTranscriptEntries()
      .find(input.matchesCard) as TranscriptEntry | undefined;
    const persisted =
      targetSession != null && persistedTarget != null
        ? (targetSession.db.updateTranscriptEntry(
            persistedTarget.id,
            input.applyStatus,
          ) as TranscriptEntry | null)
        : null;
    const liveTargetEntry = input.isForActiveAgent
      ? getTranscript().find(input.matchesCard)
      : undefined;
    const live =
      liveTargetEntry == null ? null : updateEntry(liveTargetEntry.id, input.applyStatus);
    const shippedEntry = live ?? persisted;
    if (shippedEntry != null)
      this.tm.roster.emit(
        { type: "updated", entry: shippedEntry },
        targetSession?.id,
      );
  }

  markReportedOnce(input: {
    reported: Map<string, Set<string>>;
    sessionId: string;
    toolCallId: string;
  }): boolean {
    let seenIds = input.reported.get(input.sessionId);
    if (seenIds == null) {
      seenIds = new Set();
      input.reported.set(input.sessionId, seenIds);
    }
    if (seenIds.has(input.toolCallId)) return false;
    seenIds.add(input.toolCallId);
    return true;
  }

  reportToolCallDiagnostic(
    session: LiveTranscriptSession,
    toolObservation: Record<string, any>,
  ): void {
    const requestId =
      toolObservation.requestId ??
      this.tm.runLifecycle.lastRequestIdBySession.get(session.id);
    const base = {
      conversationId: session.id,
      requestId,
      toolName: toolObservation.toolName,
      toolCallId: toolObservation.toolCallId,
      connector: toolObservation.connector,
    };
    if (toolObservation.kind === "error") {
      if (
        !this.markReportedOnce({
          reported: this.reportedToolCallErrors,
          sessionId: session.id,
          toolCallId: toolObservation.toolCallId,
        })
      )
        return;
      this.tm.telemetry.reportToolCallError({
        ...base,
        errorClass: toolObservation.errorClass,
        durationMs: toolObservation.durationMs,
      });
    } else {
      if (
        !this.markReportedOnce({
          reported: this.reportedToolCallStalls,
          sessionId: session.id,
          toolCallId: toolObservation.toolCallId,
        })
      )
        return;
      this.tm.telemetry.reportToolCallStalled({
        ...base,
        elapsedMs: toolObservation.elapsedMs,
      });
    }
  }

  async runTurn(
    session: LiveTranscriptSession,
    agentRunner: AgentRunner,
    prompt: string,
    settings: TurnOptions,
    epoch: number,
  ): Promise<void> {
    const turnTrace = beginTurnTrace({
      parentCtx: settings.traceCtx,
      conversationId: session.id,
      turnType: "user",
      ...(settings.queueStartEpochMs == null
        ? {}
        : { startTime: settings.queueStartEpochMs }),
      attributes: {
        "slate.turn_epoch": epoch,
        ...(settings.clientNonce
          ? { "slate.client_nonce": settings.clientNonce }
          : {}),
        ...(settings.messageId == null
          ? {}
          : { "slate.message_id": settings.messageId }),
        ...(settings.isFork === true ? { "slate.is_fork": true } : {}),
      },
    });
    const turnCtx = turnTrace?.context ?? settings.traceCtx;
    try {
      recordTurnQueueWaitSpan({
        traceCtx: turnCtx,
        ...(settings.queueStartEpochMs == null
          ? {}
          : { queueStartEpochMs: settings.queueStartEpochMs }),
        ...(settings.queueStartPerfMs == null
          ? {}
          : { queueStartPerfMs: settings.queueStartPerfMs }),
        conversationId: session.id,
        ...(settings.clientNonce == null
          ? {}
          : { clientNonce: settings.clientNonce }),
      });
      if (
        epoch !== this.tm.sendPipeline.currentTurnEpoch(session) &&
        settings.messageId != null
      ) {
        const currentResult = this.tm.sendPipeline.latestRecoverySends.get(session.id);
        const rawText = settings.recentUserMessages?.find(
          (sentMessage) => sentMessage.id === settings.messageId,
        )?.text;
        const canRecover =
          settings.selectedImages.length === 0 &&
          (settings.selectedVideos?.length ?? 0) === 0 &&
          (settings.attachedFilePaths?.length ?? 0) === 0 &&
          settings.isFork !== true &&
          settings.replyContext == null &&
          rawText != null &&
          rawText === prompt.trim() &&
          epoch >
            (this.tm.sendPipeline.recoveryBreakEpochs.get(session.id) ?? 0) &&
          currentResult != null &&
          currentResult.epoch === this.tm.sendPipeline.currentTurnEpoch(session) &&
          agentRunner.wouldRecoverViaPrepend != null &&
          (await agentRunner.wouldRecoverViaPrepend(
            currentResult.recentUserMessages,
            currentResult.messageId,
            settings.messageId,
          ));
        if (canRecover) {
          this.tm.telemetry
            .startTurn({ conversationId: session.id, turnType: "new" })
            .finalize("cancelled");
          this.tm.ackObligations.retireAckRunToken(
            session.id,
            settings.ackToken,
          );
          setTurnTraceAttributes(turnTrace, { "slate.outcome": "superseded" });
          this.tm.runLifecycle.endSessionRun(session);
          return;
        }
      }

      const cleanPrompt = prompt.trim();
      if (cleanPrompt) this.activeRequestPrompts.set(session.id, cleanPrompt);
      else this.activeRequestPrompts.delete(session.id);
      if (settings.replyContext != null)
        this.replyThreadTargets.set(session, settings.replyContext.targetId);
      else this.replyThreadTargets.delete(session);
      if (settings.isFork === true) this.forkTurnSessions.add(session);
      else this.forkTurnSessions.delete(session);
      this.activeTurnEpochs.set(session.id, epoch);
      const turnStartMs = Date.now();
      const turn = this.tm.telemetry.startTurn({
        conversationId: session.id,
        turnType: "new",
      });
      this.activeTurns.set(session.id, turn);
      this.activeRequestSources.set(session.id, "turn");
      try {
        const unanswered =
          this.tm.widgetResponses.collectUnansweredQuestionPrompts(session);
        const turnResult = await agentRunner.run(prompt, {
          ...settings,
          ...unanswered,
          traceCtx: turnCtx,
          appendReplyReminder: true,
          requestSource: "turn",
          onModelResolved: (modelId: string) => turn.setModel(modelId),
        });
        let finalResult = turnResult;
        if (turnResult.quiescedForUpgrade)
          this.tm.upgradeResume.markAgentResumePending(session, "turn");
        else if (
          !turnResult.aborted &&
          epoch === this.tm.sendPipeline.currentTurnEpoch(session)
        ) {
          const settledReply = await this.ensureUserReply(
            agentRunner,
            turnResult,
            session,
            epoch,
            settings.ackToken,
            turnCtx,
            turnTrace,
            turn,
          );
          finalResult = settledReply.result;
          if (
            settledReply.deliveryOwed &&
            !finalResult.aborted &&
            finalResult.quiescedForUpgrade !== true &&
            epoch === this.tm.sendPipeline.currentTurnEpoch(session)
          ) {
            this.tm.telemetry.reportTurnEmptyDelivery({
              conversationId: session.id,
              requestId: this.tm.runLifecycle.lastRequestIdBySession.get(
                session.id,
              ),
              source: "turn",
              requestSource: "turn",
              replyNudgeAttempts: settledReply.replyNudgeAttempts,
              toolCallCount: agentRunner.getObservedToolCallCount?.() ?? 0,
              streamOutputProduced: settledReply.streamOutputProduced,
              durationMs: Date.now() - turnStartMs,
              ackOutstanding:
                this.tm.ackObligationStore?.get(session.id) != null,
            });
          }
        }
        turn.finalize(
          turnResult.aborted || turnResult.quiescedForUpgrade ? "cancelled" : "success",
        );
        setTurnTraceAttributes(turnTrace, {
          "slate.outcome": resolveTurnTraceOutcome(finalResult),
        });
        await this.tm.roster.emitAgentUpdate(session.id);
        this.tm.automationRuntime.emitAutomations(session);
      } catch (error) {
        console.error(
          `[slate][turn] agent run failed for ${session.id}`,
          error,
        );
        turn.finalize(
          "error",
          classifyAgentError(error),
          slateErrorDetail(error),
        );
        markTurnTraceError(turnTrace, error);
        if (epoch === this.tm.sendPipeline.currentTurnEpoch(session)) {
          const failureDescription = describeAgentRunError(error);
          const requestId = session.db.getRequestIds().at(-1)?.id;
          this.tm.trayErrors.pushError({
            agentId: session.id,
            title:
              failureDescription.errorKind === "provider_overloaded"
                ? PROVIDER_OVERLOAD_ERROR_TITLE
                : "Agent failed to respond",
            requestId,
            ...failureDescription,
          });
        }
        await this.tm.roster.emitAgentUpdate(session.id);
      } finally {
        for (const map of [
          this.activeTurns,
          this.reportedDualSurfaceToolCalls,
          this.reportedToolCallErrors,
          this.reportedToolCallStalls,
          this.pendingToolCallStarts,
          this.activeRequestPrompts,
          this.activeRequestSources,
        ])
          map.delete(session.id);
        this.tm.runLifecycle.lastRequestIdBySession.delete(session.id);
        this.replyThreadTargets.delete(session);
        this.forkTurnSessions.delete(session);
        if (this.activeTurnEpochs.get(session.id) === epoch)
          this.activeTurnEpochs.delete(session.id);
        this.tm.ackObligations.retireAckRunToken(session.id, settings.ackToken);
        this.tm.runLifecycle.endSessionRun(session);
      }
    } finally {
      try {
        turnTrace?.span.end();
      } catch {}
      this.tm.traceFlusher();
    }
  }

  async ensureUserReply(
    agentRunner: AgentRunner,
    turnResult: TurnResult,
    session: LiveTranscriptSession,
    epoch: number,
    ackToken: string | undefined,
    traceCtx: unknown,
    turnTrace: HostTrace | undefined,
    turn?: Record<string, any>,
  ): Promise<{
    result: TurnResult;
    replyNudgeAttempts: number;
    deliveryOwed: boolean;
    streamOutputProduced: boolean;
  }> {
    let currentResult = turnResult;
    let nudgeAttempts = 0;
    let didDeliver = !isDeliveryOwed(turnResult);
    let producedStreamOutput = turnResult.streamOutputProduced === true;
    while (
      isDeliveryOwed(currentResult) &&
      nudgeAttempts < MAX_REPLY_NUDGES &&
      epoch === this.tm.sendPipeline.currentTurnEpoch(session)
    ) {
      nudgeAttempts += 1;
      currentResult = await agentRunner.run(REPLY_NUDGE_PROMPT, {
        hidden: true,
        ackToken,
        traceCtx,
        onModelResolved: (id: string) => turn?.setModel(id),
      });
      didDeliver ||= !isDeliveryOwed(currentResult);
      producedStreamOutput ||= currentResult.streamOutputProduced === true;
      if (currentResult.aborted) break;
    }
    if (
      currentResult.endedOnSilentToolCalls === true &&
      !currentResult.aborted &&
      currentResult.awaitingUserSelection !== true &&
      epoch === this.tm.sendPipeline.currentTurnEpoch(session)
    ) {
      setTurnTraceAttributes(turnTrace, { "slate.closing_send_nudge": true });
      let nudgeResult: TurnResult | undefined;
      try {
        nudgeResult = await agentRunner.run(CLOSING_SEND_NUDGE_PROMPT, {
          hidden: true,
          ackToken,
          traceCtx,
          onModelResolved: (id: string) => turn?.setModel(id),
        });
        currentResult = nudgeResult;
        didDeliver ||= !isDeliveryOwed(nudgeResult);
        producedStreamOutput ||= nudgeResult.streamOutputProduced === true;
      } finally {
        this.tm.telemetry.reportClosingSendNudge({
          conversationId: session.id,
          delivered:
            nudgeResult != null && (nudgeResult.sentMessageCount > 0 || nudgeResult.reacted),
          sentMessageCount: nudgeResult?.sentMessageCount ?? 0,
          aborted: nudgeResult?.aborted ?? false,
        });
      }
    }
    return {
      result: currentResult,
      replyNudgeAttempts: nudgeAttempts,
      deliveryOwed: !didDeliver,
      streamOutputProduced: producedStreamOutput,
    };
  }

  resolveReplyTarget(
    entryList: readonly TranscriptEntry[],
    candidateId: string,
  ): string | undefined {
    return entryList.some((transcriptEntry) => transcriptEntry.id === candidateId)
      ? candidateId
      : undefined;
  }

  buildReplyContext(
    entryList: readonly TranscriptEntry[],
    targetId?: string,
  ): { targetId: string; quote: string } | undefined {
    if (targetId == null) return undefined;
    const target = entryList.find((transcriptEntry) => transcriptEntry.id === targetId);
    return target == null
      ? undefined
      : { targetId, quote: describeRepliedMessageQuote(target) };
  }

  handleAgentUpdate(
    agentUpdate: Record<string, any>,
    session?: LiveTranscriptSession,
  ): string | undefined {
    const runSession =
      session ??
      this.tm.runLifecycle.activeRunSession ??
      this.tm.sessions.activeSession ??
      null;
    const isForActiveAgent =
      runSession == null ||
      runSession.id === this.tm.sessions.activeSession?.id;
    if (isForActiveAgent) this.tm.roster.applyAgentUpdateToOutline(agentUpdate);
    if (runSession != null) {
      this.tm.runLifecycle.trackComposingFromUpdate(agentUpdate, runSession.id);
      this.tm.runLifecycle.trackRetryingFromUpdate(agentUpdate, runSession);
      this.tm.runLifecycle.trackActivityFromUpdate(agentUpdate, runSession.id);
    }
    switch (agentUpdate.type) {
      case "client-side-tool-v2": {
        if (runSession == null) return undefined;
        const event = this.tm.clientSideToolV2.publish(runSession.id, agentUpdate.update);
        if (event != null) this.tm.roster.emitClientSideToolV2(event);
        return undefined;
      }
      case "tool-call": {
        if (agentUpdate.status === "pending" && runSession != null) {
          let startTimes = this.pendingToolCallStarts.get(runSession.id);
          if (startTimes == null) {
            startTimes = new Map();
            this.pendingToolCallStarts.set(runSession.id, startTimes);
          }
          if (!startTimes.has(agentUpdate.id)) startTimes.set(agentUpdate.id, performance.now());
          const dualSurface = slateDualSurfaceToolTelemetry(agentUpdate.name);
          if (
            dualSurface != null &&
            this.markReportedOnce({
              reported: this.reportedDualSurfaceToolCalls,
              sessionId: runSession.id,
              toolCallId: agentUpdate.id,
            })
          ) {
            this.tm.telemetry.reportToolCallStarted({
              conversationId: runSession.id,
              requestId: this.tm.runLifecycle.lastRequestIdBySession.get(
                runSession.id,
              ),
              toolName: dualSurface.toolName,
              toolCallId: agentUpdate.id,
              surface: dualSurface.surface,
            });
          }
        } else if (runSession != null) {
          const startTimes = this.pendingToolCallStarts.get(runSession.id);
          const startedAt = startTimes?.get(agentUpdate.id);
          startTimes?.delete(agentUpdate.id);
          if (agentUpdate.status === "failed")
            this.reportToolCallDiagnostic(runSession, {
              kind: "error",
              toolCallId: agentUpdate.id,
              toolName: agentUpdate.name,
              connector: UNKNOWN_CONNECTOR_TAG,
              errorClass: TASK_ERROR_RESULT_CLASS,
              ...(startedAt == null
                ? {}
                : { durationMs: Math.round(performance.now() - startedAt) }),
            });
        }
        return undefined;
      }
      case "request-id":
        if (runSession != null) {
          this.activeTurns.get(runSession.id)?.setRequestId(agentUpdate.requestId);
          this.tm.runLifecycle.lastRequestIdBySession.set(
            runSession.id,
            agentUpdate.requestId,
          );
          this.tm.runLifecycle.trackTurnRequestId(
            runSession.id,
            agentUpdate.requestId,
          );
        }
        void this.tm.runLifecycle.recordRequestId(
          agentUpdate.requestId,
          runSession,
          agentUpdate.source,
        );
        return undefined;
      case "turn-ended":
        if (runSession != null)
          this.tm.runLifecycle.reportTurnUsage(runSession, agentUpdate.usage);
        return undefined;
      case "send-message": {
        const incomingMessage = agentUpdate.message as SendMessage;
        if (
          (incomingMessage.type === "text" || incomingMessage.type === "attachment") &&
          typeof incomingMessage.channel === "string" &&
          incomingMessage.channel.length > 0
        )
          this.tm.backgroundWakes.deliverToChannel(
            runSession,
            incomingMessage,
            incomingMessage.channel,
          );
        if (incomingMessage.type === "listener-connect")
          this.onListenerConnect(runSession, incomingMessage);
        if (incomingMessage.type === "connector" && incomingMessage.variant === "connect")
          this.onConnectorConnect(runSession, incomingMessage);
        const entryList =
          isForActiveAgent || runSession == null
            ? getTranscript()
            : (runSession.db.getTranscriptEntries() as TranscriptEntry[]);
        const sendEntryId = nextEntryId(entryList, "send-message");
        const validatedMessage = this.tm.sendPipeline.validateAiReplyTarget(
          incomingMessage,
          sendEntryId,
          entryList,
        );
        const threadedMessage = this.tm.sendPipeline.applyAutoReplyThread(
          validatedMessage,
          runSession,
          entryList,
        ) as SendMessage;
        const batchId =
          threadedMessage.type === "attachment" && runSession != null
            ? this.tm.sendPipeline.claimSendAttachmentBatchId(runSession.id)
            : undefined;
        const base = {
          ...createSendMessageEntry(sendEntryId, threadedMessage, agentUpdate.timestampMs),
          ...(batchId == null ? {} : { batchId }),
        };
        const boxStampedEntry =
          agentUpdate.boxHandoff == null
            ? base
            : stampBoxRequestEntry(base, agentUpdate.boxHandoff);
        const transcriptEntry =
          runSession != null && this.forkTurnSessions.has(runSession)
            ? { ...boxStampedEntry, branched: true }
            : boxStampedEntry;
        if (isForActiveAgent || runSession == null) {
          this.tm.sendPipeline.appendSendMessageEntry(transcriptEntry);
          const activeAgentKey = runSession?.id ?? this.tm.sessions.activeSession?.id;
          this.tm.ackObligations.fulfillAckObligation(
            activeAgentKey,
            agentUpdate.ackToken,
          );
          if (activeAgentKey != null) void this.tm.roster.emitAgentUpdate(activeAgentKey);
        } else {
          runSession.db.appendTranscriptEntry(transcriptEntry);
          this.tm.ackObligations.fulfillAckObligation(
            runSession.id,
            agentUpdate.ackToken,
          );
          this.tm.sessionStore.markSessionActivity(runSession);
          void this.tm.roster.emitAgentUpdate(runSession.id);
        }
        return sendEntryId;
      }
      case "auto-review-status":
        this.settleNestedCard(
          runSession,
          isForActiveAgent,
          "auto-review-approval",
          "approval",
          agentUpdate.requestId,
          agentUpdate.status,
        );
        return undefined;
      case "local-tool-permission-status":
        this.settleNestedCard(
          runSession,
          isForActiveAgent,
          "local-tool-permission",
          "ask",
          agentUpdate.requestId,
          agentUpdate.status,
        );
        return undefined;
      case "react-to-message": {
        const emoji = String(agentUpdate.emoji ?? "").trim();
        if (!emoji || !isMessageAddress(agentUpdate.messageAddress))
          return undefined;
        const reactionSession =
          runSession ?? this.tm.sessions.activeSession ?? null;
        const entryList =
          reactionSession != null &&
          reactionSession.id !== this.tm.sessions.activeSession?.id
            ? (reactionSession.db.getTranscriptEntries() as TranscriptEntry[])
            : getTranscript();
        const target = entryList.find(
          (transcriptEntry) => transcriptEntry.id === agentUpdate.messageAddress,
        );
        if (target == null || !isUserMessageEntry(target)) return undefined;
        const appliedReaction = this.tm.widgetResponses.applyReaction({
          session: reactionSession,
          entryId: agentUpdate.messageAddress,
          emoji,
          by: reactionSession?.id ?? SLATE_REACTION_AGENT,
        });
        return appliedReaction == null ? undefined : agentUpdate.messageAddress;
      }
      default:
        return undefined;
    }
  }

  private onListenerConnect(
    session: LiveTranscriptSession | null,
    sentMessage: SendMessage,
  ): void {
    const ownerKey = session?.id ?? this.tm.sessions.activeSession?.id;
    if (ownerKey == null) return;
    try {
      this.tm.onListenerConnectCard?.({
        agentId: ownerKey,
        platform: sentMessage.platform,
      });
    } catch {}
  }

  private onConnectorConnect(
    session: LiveTranscriptSession | null,
    sentMessage: SendMessage,
  ): void {
    const ownerKey = session?.id ?? this.tm.sessions.activeSession?.id;
    if (ownerKey == null) return;
    try {
      this.tm.onConnectorConnectCard?.({
        agentId: ownerKey,
        connector: sentMessage.connector,
        ...(sentMessage.serverId == null ? {} : { serverId: sentMessage.serverId }),
      });
    } catch {}
  }

  private settleNestedCard(
    runSession: LiveTranscriptSession | null,
    isForActiveAgent: boolean,
    type: string,
    key: string,
    requestId: string,
    status: unknown,
  ): void {
    const cardPredicate = (transcriptEntry: TranscriptEntry) =>
      messageOf(transcriptEntry)?.type === type &&
      messageOf(transcriptEntry)?.[key]?.requestId === requestId;
    const statusMutator = (transcriptEntry: TranscriptEntry): TranscriptEntry => {
      const sentMessage = messageOf(transcriptEntry);
      if (
        sentMessage == null ||
        sentMessage.type !== type ||
        sentMessage[key]?.requestId !== requestId
      )
        return transcriptEntry;
      return {
        ...transcriptEntry,
        message: { ...sentMessage, [key]: { ...sentMessage[key], status } },
      };
    };
    this.settleCardStatus({
      runSession,
      isForActiveAgent,
      matchesCard: cardPredicate,
      applyStatus: statusMutator,
    });
  }
}
