/** A conversation's run, from the moment it starts to the moment it is put away.

 * One run per subject at a time, through the platform's own runScheduler where it is enabled and through a chain of promises
 * where it is not; the turn count, the activity the user sees, whether the subject is composing or retrying, and what is
 * reported about the turn are all kept here. A run that never finishes is bounded by the watchdog the environment sets. */
import {
  areAgentActivitiesEqual,
  type SlateAgentActivity,
} from "../../shared/agents/agents.ts";
import {
  INITIAL_NAMED_ACTIVITY_HOLD_STATE,
  NAMED_ACTIVITY_MAX_HOLD_MS,
  SEND_MESSAGE_TOOL_CALL_OUTLINE_NAME,
  resolveNamedActivityHold,
  type ActivityTransition,
  type ActivityUpdate,
  type NamedActivityHoldState,
} from "../slate-activity.ts";
import { SlateRunScheduler, type RunLane } from "./run-scheduler.ts";
import type { TranscriptManagerLike } from "./transcript-hub.ts";

export function isRunSchedulerDisabled(): boolean {
  return process.env.SLATE_DISABLE_RUN_SCHEDULER === "1";
}
export function envPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim().length === 0) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
export const RUN_WATCHDOG_DEFAULT_MS = 120_000;
export const RUN_WATCHDOG_GRACE_DEFAULT_MS = 30_000;

export class RunLifecycle {
  readonly inFlightRunCounts = new Map<any, number>();
  readonly runWindowStartedAt = new Map<any, number>();
  readonly turnWorthyBeginCounts = new Map<any, number>();
  activeRunSession: any = null;
  readonly runChains = new Map<string, Promise<void>>();
  readonly runScheduler: SlateRunScheduler | null;
  readonly composingMessageSessionIds = new Set<string>();
  readonly retryingSessionIds = new Set<string>();
  readonly sessionActivities = new Map<string, SlateAgentActivity>();
  readonly sessionActivityHolds = new Map<string, NamedActivityHoldState>();
  readonly lastRequestIdBySession = new Map<string, string>();
  readonly turnRequestIdsBySession = new Map<string, Set<string>>();
  readonly turnEndedSeqBySession = new Map<string, number>();

  constructor(readonly tm: TranscriptManagerLike) {
    this.runScheduler = isRunSchedulerDisabled()
      ? null
      : new SlateRunScheduler({
          watchdogMs: envPositiveInt(
            "SLATE_RUN_WATCHDOG_MS",
            RUN_WATCHDOG_DEFAULT_MS,
          ),
          watchdogGraceMs: envPositiveInt(
            "SLATE_RUN_WATCHDOG_GRACE_MS",
            RUN_WATCHDOG_GRACE_DEFAULT_MS,
          ),
          interruptWedgedRun: (agentId) =>
            this.tm.runnerRegistry.interruptWedgedRunForWatchdog(agentId),
          telemetry: {
            onAccepted: (event) =>
              this.tm.telemetry.reportQueueAccepted({
                conversationId: event.agentId,
                lane: event.lane,
                source: event.source,
                position: event.position,
                depthUser: event.depthUser,
                depthAgent: event.depthAgent,
                depthBackground: event.depthBackground,
                hasActive: event.hasActive,
              }),
            onDequeued: (event) =>
              this.tm.telemetry.reportQueueDequeued({
                conversationId: event.agentId,
                lane: event.lane,
                source: event.source,
                queueWaitMs: event.queueWaitMs,
                ...(event.acceptedToRunMs == null
                  ? {}
                  : { acceptedToRunMs: event.acceptedToRunMs }),
                jumpedBackground: event.jumpedBackground,
                depthUser: event.depthUser,
                depthAgent: event.depthAgent,
                depthBackground: event.depthBackground,
              }),
            onWatchdog: (event) => {
              if (event.stage === "escape")
                this.tm.ackObligations.retireAckRunToken(
                  event.agentId,
                  event.ackToken,
                );
              this.tm.telemetry.reportQueueWatchdog({
                conversationId: event.agentId,
                stage: event.stage,
                activeLane: event.activeLane,
                activeSource: event.activeSource,
                activeRuntimeMs: event.activeRuntimeMs,
                ...(event.waitingUserAgeMs == null
                  ? {}
                  : { waitingUserAgeMs: event.waitingUserAgeMs }),
                ...(event.interrupted == null
                  ? {}
                  : { interrupted: event.interrupted }),
              });
            },
          },
          onRunStart: (agentId) =>
            this.tm.sendPipeline.sendAttachmentBatchIds.delete(agentId),
        });
  }

  async recordRequestId(
    requestKey: string,
    conversation: any,
    source?: string,
  ): Promise<void> {
    if (conversation == null) return;
    try {
      conversation.db.recordRequestId(
        requestKey,
        Date.now(),
        this.tm.turnRuntime.activeRequestPrompts.get(conversation.id),
        source ?? this.tm.turnRuntime.activeRequestSources.get(conversation.id),
      );
      await this.tm.roster.emitAgentUpdate(conversation.id);
    } catch {}
  }

  trackTurnRequestId(sessionId: string, requestKey: string): void {
    const trimmed = requestKey.trim();
    if (trimmed.length === 0) return;
    const ids = this.turnRequestIdsBySession.get(sessionId);
    if (ids == null)
      this.turnRequestIdsBySession.set(sessionId, new Set([trimmed]));
    else ids.add(trimmed);
  }

  reportTurnUsage(conversation: any, tokenUsage: unknown): void {
    const turnRequestIds = this.turnRequestIdsBySession.get(conversation.id);
    this.turnRequestIdsBySession.delete(conversation.id);
    const endedSequence = (this.turnEndedSeqBySession.get(conversation.id) ?? 0) + 1;
    this.turnEndedSeqBySession.set(conversation.id, endedSequence);
    this.tm.telemetry.reportTurnUsage({
      conversationId: conversation.id,
      source:
        this.tm.turnRuntime.activeRequestSources.get(conversation.id) ?? "turn",
      usage: tokenUsage,
      requestId: turnRequestIds?.values().next().value,
      requestIdCount: turnRequestIds?.size ?? 0,
      turnEndedSeq: endedSequence,
    });
  }

  enqueueExclusiveRun(
    agentId: string,
    task: () => Promise<void>,
    settings: {
      lane: RunLane;
      source: string;
      acceptedAtMs?: number;
      ackToken?: string;
    },
  ): Promise<void> {
    if (this.runScheduler != null)
      return this.runScheduler.enqueue(agentId, task, settings);
    const previous = this.runChains.get(agentId) ?? Promise.resolve();
    const result = previous.then(() => {
      this.tm.sendPipeline.sendAttachmentBatchIds.delete(agentId);
      return task();
    });
    this.runChains.set(
      agentId,
      Promise.allSettled([result]).then(() => undefined),
    );
    return result;
  }

  async drainExclusiveRuns(agentId: string): Promise<void> {
    if (this.runScheduler != null) await this.runScheduler.drain(agentId);
    else await this.runChains.get(agentId);
  }

  getRunQueueDiagnostics(): readonly unknown[] {
    if (this.runScheduler == null) return [];
    const now = Date.now();
    const perAgent = new Map<string, Record<string, unknown>>();
    for (const queue of this.runScheduler.getDiagnostics())
      perAgent.set(queue.agentId as string, { ...queue, ackOutstanding: false });
    for (const ackObligation of this.tm.ackObligationStore?.list() ?? []) {
      const existingRow = perAgent.get(ackObligation.agentId) ?? {
        agentId: ackObligation.agentId,
        depthUser: 0,
        depthAgent: 0,
        depthBackground: 0,
        depthTotal: 0,
        ackOutstanding: false,
      };
      perAgent.set(ackObligation.agentId, {
        ...existingRow,
        ackOutstanding: true,
        ackAgeMs: now - ackObligation.createdAtMs,
        ackCoalescedCount: ackObligation.coalescedCount,
      });
    }
    return [...perAgent.values()];
  }

  beginSessionRun(
    conversation: any,
    settings?: { isGroupMemberTurn?: boolean },
  ): void {
    const activeCount = this.inFlightRunCounts.get(conversation) ?? 0;
    if (activeCount === 0) this.runWindowStartedAt.set(conversation, Date.now());
    if (settings?.isGroupMemberTurn !== true)
      this.turnWorthyBeginCounts.set(
        conversation,
        (this.turnWorthyBeginCounts.get(conversation) ?? 0) + 1,
      );
    this.inFlightRunCounts.set(conversation, activeCount + 1);
    this.tm.sessions.liveSessions.set(conversation.id, conversation);
    this.activeRunSession = conversation;
    void this.tm.roster.emitAgentUpdate(conversation.id);
  }

  endSessionRun(conversation: any): void {
    this.setSessionComposing(conversation.id, false);
    this.setSessionRetrying(conversation.id, false);
    this.setSessionActivity(conversation.id, undefined);
    this.sessionActivityHolds.delete(conversation.id);
    const restCount = (this.inFlightRunCounts.get(conversation) ?? 1) - 1;
    if (restCount > 0) {
      this.inFlightRunCounts.set(conversation, restCount);
      return;
    }
    this.inFlightRunCounts.delete(conversation);
    this.recordTurnCompleted(conversation);
    this.tm.turnRuntime.activeRequestPrompts.delete(conversation.id);
    this.tm.turnRuntime.activeRequestSources.delete(conversation.id);
    this.turnRequestIdsBySession.delete(conversation.id);
    this.turnEndedSeqBySession.delete(conversation.id);
    this.tm.sendPipeline.sendAttachmentBatchIds.delete(conversation.id);
    if (this.activeRunSession === conversation) this.activeRunSession = null;
    this.tm.ackObligations.scheduleAckRedriveAfterIdle(conversation.id);
    void this.retireSession(conversation);
    void this.tm.roster.emitAgentUpdate(conversation.id);
  }

  recordTurnCompleted(conversation: any): void {
    const windowStart = this.runWindowStartedAt.get(conversation);
    this.runWindowStartedAt.delete(conversation);
    const worthyBegins = this.turnWorthyBeginCounts.get(conversation) ?? 0;
    this.turnWorthyBeginCounts.delete(conversation);
    if (worthyBegins === 0) return;
    this.tm.productAnalytics.trackEvent("slate.turn.completed", {
      agent_id: conversation.id,
      source:
        this.tm.turnRuntime.activeRequestSources.get(conversation.id) ?? "turn",
      is_group: this.tm.groupChat.isGroupSession(conversation),
      duration_ms: windowStart == null ? 0 : Date.now() - windowStart,
    });
  }

  async retireSession(conversation: any): Promise<void> {
    if (conversation == null) return;
    const pendingOpen = this.tm.sessions.pendingSessionOpens.get(conversation.id);
    const ownsPending =
      pendingOpen != null &&
      (await this.tm.sessions.settledOpen(pendingOpen)) === conversation;
    if (
      conversation === this.tm.sessions.activeSession ||
      this.inFlightRunCounts.has(conversation)
    )
      return;
    if (this.tm.sessions.liveSessions.get(conversation.id) === conversation) {
      this.tm.runnerRegistry.runners
        .get(conversation.id)
        ?.expireAutoReviewApprovals();
      this.tm.sessions.liveSessions.delete(conversation.id);
      this.tm.runnerRegistry.runners.delete(conversation.id);
    }
    if (
      ownsPending &&
      this.tm.sessions.pendingSessionOpens.get(conversation.id) === pendingOpen
    )
      this.tm.sessions.pendingSessionOpens.delete(conversation.id);
    await conversation.agentStore.dispose();
    conversation.db.close();
  }

  runningAgentIds(): Set<string> {
    return new Set(
      [...this.inFlightRunCounts.keys()].map((conversation) => conversation.id),
    );
  }
  liveRunningAgentIds(): Set<string> {
    const runningSet = this.runningAgentIds();
    for (const agentId of this.tm.roster.liveSubagentParentIds())
      runningSet.add(agentId);
    return runningSet;
  }

  withRunStates<T extends Record<string, any>>(agents: readonly T[]): T[] {
    const runningSet = this.runningAgentIds();
    const parentSet = this.tm.roster.liveSubagentParentIds();
    return agents.map((subject) => {
      const turnInFlight = runningSet.has(subject.id);
      const isRunning = turnInFlight || parentSet.has(subject.id);
      const composing =
        isRunning && this.composingMessageSessionIds.has(subject.id);
      const retrying = isRunning && this.retryingSessionIds.has(subject.id);
      const currentActivity = isRunning
        ? this.sessionActivities.get(subject.id)
        : undefined;
      const activeRemoteMemberId = isRunning
        ? this.tm.groupChat.remoteTurnMemberIdsByRoom.get(subject.id)
        : undefined;
      if (
        subject.isRunning === isRunning &&
        (subject.isRunningTurn ?? false) === turnInFlight &&
        subject.isComposingMessage === composing &&
        (subject.isRetrying ?? false) === retrying &&
        areAgentActivitiesEqual(subject.currentActivity, currentActivity) &&
        subject.activeRemoteMemberId === activeRemoteMemberId
      )
        return subject;
      return {
        ...subject,
        isRunning,
        isRunningTurn: turnInFlight,
        isComposingMessage: composing,
        isRetrying: retrying,
        currentActivity,
        activeRemoteMemberId,
      };
    });
  }

  setSessionComposing(sessionId: string, wantsComposing: boolean): void {
    const wasComposing = this.composingMessageSessionIds.has(sessionId);
    if (wasComposing === wantsComposing) return;
    if (wantsComposing) this.composingMessageSessionIds.add(sessionId);
    else this.composingMessageSessionIds.delete(sessionId);
    void this.tm.roster.emitAgentUpdate(sessionId);
  }
  setSessionRetrying(sessionId: string, retrying: boolean): void {
    const wasComposing = this.retryingSessionIds.has(sessionId);
    if (wasComposing === retrying) return;
    if (retrying) this.retryingSessionIds.add(sessionId);
    else this.retryingSessionIds.delete(sessionId);
    void this.tm.roster.emitAgentUpdate(sessionId);
  }
  trackRetryingFromUpdate(nextUpdate: ActivityUpdate, conversation: any): void {
    if (nextUpdate.type === "retrying") {
      const runEpoch = this.tm.turnRuntime.activeTurnEpochs.get(conversation.id);
      if (
        runEpoch !== undefined &&
        runEpoch !== this.tm.sendPipeline.currentTurnEpoch(conversation)
      )
        return;
      this.setSessionRetrying(conversation.id, true);
    } else if (
      [
        "text-delta",
        "thinking-delta",
        "tool-call",
        "send-message",
        "turn-ended",
      ].includes(nextUpdate.type)
    )
      this.setSessionRetrying(conversation.id, false);
  }
  setSessionActivity(
    sessionId: string,
    activity: SlateAgentActivity | undefined,
  ): void {
    if (
      areAgentActivitiesEqual(this.sessionActivities.get(sessionId), activity)
    )
      return;
    if (activity == null) this.sessionActivities.delete(sessionId);
    else this.sessionActivities.set(sessionId, activity);
    void this.tm.roster.emitAgentUpdate(sessionId);
  }
  trackActivityFromUpdate(nextUpdate: ActivityUpdate, sessionId: string): void {
    const previousHold =
      this.sessionActivityHolds.get(sessionId) ??
      INITIAL_NAMED_ACTIVITY_HOLD_STATE;
    const { transition: activityChange, state: holdState } = resolveNamedActivityHold(
      nextUpdate,
      previousHold,
      Date.now(),
      NAMED_ACTIVITY_MAX_HOLD_MS,
    );
    if (holdState === INITIAL_NAMED_ACTIVITY_HOLD_STATE)
      this.sessionActivityHolds.delete(sessionId);
    else this.sessionActivityHolds.set(sessionId, holdState);
    this.applyActivityTransition(sessionId, activityChange);
  }
  applyActivityTransition(
    sessionId: string,
    activityChange: ActivityTransition,
  ): void {
    if (activityChange.type !== "keep")
      this.setSessionActivity(
        sessionId,
        activityChange.type === "set" ? activityChange.activity : undefined,
      );
  }
  trackComposingFromUpdate(nextUpdate: ActivityUpdate, sessionId: string): void {
    if (
      nextUpdate.type === "tool-call" &&
      nextUpdate.name === SEND_MESSAGE_TOOL_CALL_OUTLINE_NAME
    )
      this.setSessionComposing(sessionId, nextUpdate.status === "pending");
    else if (nextUpdate.type === "send-message" || nextUpdate.type === "turn-ended")
      this.setSessionComposing(sessionId, false);
  }
  closeSessionWhenIdle(conversation: any): void {
    if (!this.inFlightRunCounts.has(conversation)) conversation.db.close();
  }
  watchActiveSession(conversation: any): void {
    this.tm.memory.setActiveAgent({
      agentId: conversation.id,
      store: conversation.memory,
    });
    this.tm.automationRuntime.watchSessionAutomations(conversation);
    this.tm.workflowCommands.watchSessionWorkflows(conversation);
    this.tm.roster.watchSessionProfile(conversation);
  }
}
