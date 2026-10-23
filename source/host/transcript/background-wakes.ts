/** Waking a conversation for something that happened while nobody was talking to it.

 * A channel message, a delivery that failed, a broadcast from the user, a timeline event — each is queued against the
 * conversation it belongs to, drained one wake at a time and run as a hidden background turn, while the completions and
 * the messages between agents are handed to the machinery that owns them. */
import { randomUUID } from "node:crypto";
import {
  buildAdminBroadcastWakePrompt,
  clampAgentMessage,
} from "../agents/agent-messaging.ts";
import { slateErrorDetail } from "../ports/telemetry.ts";
import {
  buildChannelDeliveryFailureWakePrompt,
  buildChannelInboundWakePrompt,
  buildChannelOutboundMessage,
  humanizeChannelDeliveryFailure,
} from "../channels/channel-messaging.ts";
import { formatChannelAddress } from "../channels/channels.ts";
import { buildTimelineEventWakePrompt } from "../../shared/slate-timeline-events.ts";
import { AgentToAgentMessaging } from "./agent-to-agent-messaging.ts";
import { describeAgentRunError } from "./agent-run-error.ts";
import { CompletionRevivals } from "./completion-revivals.ts";
import { AgentGoneError } from "./session-runtime.ts";
import { collectInboundImages } from "./send-message-shaping.ts";
import { nextEntryId } from "./transcript-entry-ids.ts";
import { getTranscript } from "./transcript-store.ts";
import { classifyAgentError } from "./turn-runtime.ts";
import type { TranscriptManagerLike } from "./transcript-hub.ts";

export function distinctChannelAddresses(
  inboundBatch: readonly { address: any }[],
): string[] {
  return [
    ...new Set(
      inboundBatch.map((envelope) => formatChannelAddress(envelope.address)),
    ),
  ];
}

export class BackgroundWakes {
  readonly pendingInbound = new Map<string, any[]>();
  readonly revivingInboundAgentIds = new Set<string>();
  readonly pendingChannelFailures = new Map<string, any[]>();
  readonly revivingChannelFailureAgentIds = new Set<string>();
  readonly pendingEventWakes = new Map<string, any[]>();
  readonly revivingEventAgentIds = new Set<string>();
  readonly dmPreemptedWakeAgentIds = new Set<string>();
  readonly completionRevivals: CompletionRevivals;
  readonly agentToAgent: AgentToAgentMessaging;
  readonly pendingSubagentCompletions;
  readonly revivingSubagentAgentIds;
  readonly pendingShellCompletions;
  readonly revivingShellAgentIds;
  readonly pendingAgentInbound;

  constructor(readonly tm: TranscriptManagerLike) {
    this.completionRevivals = new CompletionRevivals(tm);
    this.agentToAgent = new AgentToAgentMessaging(tm);
    this.pendingSubagentCompletions =
      this.completionRevivals.pendingSubagentCompletions;
    this.revivingSubagentAgentIds =
      this.completionRevivals.revivingSubagentAgentIds;
    this.pendingShellCompletions =
      this.completionRevivals.pendingShellCompletions;
    this.revivingShellAgentIds = this.completionRevivals.revivingShellAgentIds;
    this.pendingAgentInbound = this.agentToAgent.pendingAgentInbound;
  }
  handleBackgroundSubagentCompletion(
    ...args: Parameters<
      CompletionRevivals["handleBackgroundSubagentCompletion"]
    >
  ): void {
    this.completionRevivals.handleBackgroundSubagentCompletion(...args);
  }
  handleBackgroundShellCompletion(
    ...args: Parameters<CompletionRevivals["handleBackgroundShellCompletion"]>
  ): void {
    this.completionRevivals.handleBackgroundShellCompletion(...args);
  }
  reviveForSubagentCompletions(agentKey: string) {
    return this.completionRevivals.reviveForSubagentCompletions(agentKey);
  }
  reviveForShellCompletions(agentKey: string) {
    return this.completionRevivals.reviveForShellCompletions(agentKey);
  }
  sendToAgent(...args: Parameters<AgentToAgentMessaging["sendToAgent"]>) {
    return this.agentToAgent.sendToAgent(...args);
  }
  appendAgentOutboundEntry(
    ...args: Parameters<AgentToAgentMessaging["appendAgentOutboundEntry"]>
  ): void {
    this.agentToAgent.appendAgentOutboundEntry(...args);
  }

  deliverToChannel(
    runSession: any,
    message: unknown,
    recipientToken: string,
  ): void {
    const agentKey = runSession?.id ?? this.tm.sessions.activeSession?.id;
    if (agentKey == null) return;
    const delivery = buildChannelOutboundMessage(message as any);
    if (delivery == null) return;
    void this.tm
      .channelDelivery(agentKey, recipientToken, delivery)
      .catch((error: unknown) => {
        const failureDetail =
          error instanceof Error ? error.message : "Channel delivery failed";
        const reason = humanizeChannelDeliveryFailure(recipientToken, failureDetail);
        this.tm.trayErrors.pushError({
          agentId: agentKey,
          title: "Message not delivered",
          detail: reason,
        });
        this.queueChannelDeliveryFailure(agentKey, { addressToken: recipientToken, reason });
      });
  }
  queueChannelDeliveryFailure(agentKey: string, failure: unknown): void {
    if (
      this.tm.pendingWakes.enqueuePendingWake(
        this.pendingChannelFailures,
        agentKey,
        [failure],
      )
    )
      void this.reviveForChannelFailures(agentKey);
  }
  async reviveForChannelFailures(agentKey: string): Promise<void> {
    if (
      !this.tm.execution.canExecute ||
      this.revivingChannelFailureAgentIds.has(agentKey)
    )
      return;
    this.revivingChannelFailureAgentIds.add(agentKey);
    try {
      while ((this.pendingChannelFailures.get(agentKey)?.length ?? 0) > 0) {
        const failureBatch = this.pendingChannelFailures.get(agentKey) ?? [];
        this.pendingChannelFailures.delete(agentKey);
        if (!(await this.runChannelFailureWake(agentKey, failureBatch))) {
          this.pendingChannelFailures.set(agentKey, [
            ...failureBatch,
            ...(this.pendingChannelFailures.get(agentKey) ?? []),
          ]);
          break;
        }
      }
    } finally {
      this.revivingChannelFailureAgentIds.delete(agentKey);
    }
  }
  async runChannelFailureWake(
    agentKey: string,
    failureBatch: readonly any[],
  ): Promise<boolean> {
    if (failureBatch.length === 0) return true;
    if (!this.tm.execution.canExecute) return false;
    let targetSession: any;
    try {
      targetSession = await this.tm.sessions.resolveBackgroundSession(agentKey);
    } catch (error) {
      return error instanceof AgentGoneError;
    }
    if (this.tm.groupChat.isGroupSession(targetSession)) return true;
    await this.runBackgroundWake(
      targetSession,
      "connector",
      "channel-failure",
      async (sessionRunner) => {
        await sessionRunner.run(buildChannelDeliveryFailureWakePrompt(failureBatch), {
          hidden: true,
          ...this.tm.widgetResponses.collectUnansweredQuestionPrompts(targetSession),
        });
      },
      "Delivery-failure follow-up failed",
      "channel_failure",
    );
    return true;
  }

  wakeForInbound(agentKey: string, envelope: unknown): void {
    if (
      this.tm.pendingWakes.enqueuePendingWake(this.pendingInbound, agentKey, [
        envelope,
      ])
    )
      void this.reviveForInbound(agentKey);
  }
  async reviveForInbound(agentKey: string): Promise<void> {
    if (
      !this.tm.execution.canExecute ||
      this.revivingInboundAgentIds.has(agentKey)
    )
      return;
    this.revivingInboundAgentIds.add(agentKey);
    try {
      while ((this.pendingInbound.get(agentKey)?.length ?? 0) > 0) {
        const inboundBatch = this.pendingInbound.get(agentKey) ?? [];
        this.pendingInbound.delete(agentKey);
        await this.runInboundWake(agentKey, inboundBatch);
      }
    } finally {
      this.revivingInboundAgentIds.delete(agentKey);
    }
  }
  async runInboundWake(
    agentKey: string,
    inboundBatch: readonly any[],
  ): Promise<void> {
    if (inboundBatch.length === 0 || !this.tm.execution.canExecute) return;
    let targetSession: any;
    try {
      targetSession = await this.tm.sessions.resolveBackgroundSession(agentKey);
    } catch {
      return;
    }
    if (
      this.tm.groupChat.isGroupSession(targetSession) ||
      this.tm.groupChat.isRemoteRoomSession(targetSession)
    )
      return;
    this.appendChannelInboundEntries(
      targetSession,
      inboundBatch.filter((envelope) => envelope.isDisplayed !== true),
    );
    const originAddresses = distinctChannelAddresses(inboundBatch);
    const sessionRunner = this.tm.runnerRegistry.getRunner(targetSession);
    this.tm.runLifecycle.beginSessionRun(targetSession);
    await this.tm.runLifecycle.enqueueExclusiveRun(
      targetSession.id,
      async () => {
        this.tm.turnRuntime.activeRequestPrompts.delete(targetSession.id);
        this.tm.turnRuntime.activeRequestSources.set(targetSession.id, "connector");
        this.dmPreemptedWakeAgentIds.delete(targetSession.id);
        try {
          this.notifyChannelActivity(targetSession.id, originAddresses, true);
          const result = await sessionRunner.run(
            buildChannelInboundWakePrompt(inboundBatch),
            {
              hidden: true,
              ...this.tm.widgetResponses.collectUnansweredQuestionPrompts(
                targetSession,
              ),
              selectedImages: collectInboundImages(inboundBatch),
            },
          );
          const preemptedByDm = this.dmPreemptedWakeAgentIds.delete(targetSession.id);
          if (result.aborted && result.quiescedForUpgrade !== true) {
            if (!preemptedByDm || this.tm.sessions.isAgentGone(agentKey)) return;
            const retryableInbound = inboundBatch
              .filter((envelope) => envelope.isRedriven !== true)
              .map((envelope) => ({
                ...envelope,
                isDisplayed: true,
                isRedriven: true,
              }));
            if (retryableInbound.length > 0)
              this.pendingInbound.set(agentKey, [
                ...retryableInbound,
                ...(this.pendingInbound.get(agentKey) ?? []),
              ]);
            return;
          }
          if (!result.aborted && result.sentMessageCount === 0)
            await this.tm.automationRuntime.ensureHiddenTurnReply(sessionRunner);
          await this.tm.roster.emitAgentUpdate(targetSession.id);
        } catch (error) {
          this.reportWakeError(
            targetSession,
            "connector",
            "Channel message follow-up failed",
            error,
          );
        } finally {
          this.notifyChannelActivity(targetSession.id, originAddresses, false);
          this.tm.runLifecycle.endSessionRun(targetSession);
        }
      },
      { lane: "background", source: "connector" },
    );
  }
  notifyChannelActivity(
    agentKey: string,
    addresses: readonly string[],
    isActive: boolean,
  ): void {
    for (const address of addresses)
      this.tm.channelActivity?.(agentKey, address, isActive);
  }
  appendChannelInboundEntries(targetSession: any, inboundBatch: readonly any[]): void {
    const isActive = targetSession.id === this.tm.sessions.activeSession?.id;
    for (const envelope of inboundBatch) {
      const transcriptEntry = {
        kind: "message",
        id: nextEntryId(
          isActive ? getTranscript() : targetSession.db.getTranscriptEntries(),
          "user-message",
        ),
        role: "user",
        content: envelope.text,
        isStreaming: false,
        timestampMs: envelope.timestampMs,
        channel: formatChannelAddress(envelope.address),
        channelSender: envelope.sender,
      };
      if (isActive) this.tm.appendEntry(transcriptEntry);
      else targetSession.db.appendTranscriptEntry(transcriptEntry);
    }
    if (!isActive) {
      this.tm.sessionStore.markSessionActivity(targetSession);
      void this.tm.roster.emitAgentUpdate(targetSession.id);
    }
  }

  async broadcastToAgents(
    targets: "all" | readonly string[],
    message: string,
  ): Promise<{ total: number; scheduled: number }> {
    const text = clampAgentMessage(message);
    if (text.length === 0 || !this.tm.execution.canExecute)
      return { total: 0, scheduled: 0 };
    const ids =
      targets === "all"
        ? await this.tm.sessionStore.listAgentIds()
        : [...new Set(targets)];
    let scheduled = 0;
    for (const id of ids)
      if (await this.scheduleBroadcast(id, text)) scheduled += 1;
    return { total: ids.length, scheduled };
  }
  async scheduleBroadcast(agentKey: string, message: string): Promise<boolean> {
    if (this.tm.sessions.isAgentGone(agentKey)) return false;
    let targetSession: any;
    try {
      targetSession = await this.tm.sessions.resolveBackgroundSession(agentKey);
    } catch {
      return false;
    }
    if (
      this.tm.groupChat.isGroupSession(targetSession) ||
      this.tm.groupChat.isRemoteRoomSession(targetSession)
    )
      return false;
    void this.runBackgroundWake(
      targetSession,
      "broadcast",
      "broadcast",
      async (sessionRunner) => {
        const result = await sessionRunner.run(
          buildAdminBroadcastWakePrompt(message),
          { hidden: true },
        );
        if (!result.aborted && result.sentMessageCount === 0)
          await this.tm.automationRuntime.ensureHiddenTurnReply(sessionRunner);
      },
      "Broadcast message failed",
    );
    return true;
  }

  emitTimelineEvent(agentKey: string, event: unknown): void {
    if (!this.tm.sessions.isAgentGone(agentKey))
      void this.recordTimelineEvent(agentKey, event);
  }
  async recordTimelineEvent(agentKey: string, event: unknown): Promise<void> {
    let targetSession: any;
    try {
      targetSession = await this.tm.sessions.resolveBackgroundSession(agentKey);
    } catch {
      return;
    }
    if (this.tm.groupChat.isGroupSession(targetSession)) return;
    this.appendTimelineEventEntry(targetSession, event);
    if (!this.tm.runLifecycle.runningAgentIds().has(agentKey))
      this.queueEventWake(agentKey, event);
  }
  appendTimelineEventEntry(targetSession: any, event: unknown): void {
    const transcriptEntry = {
      kind: "event",
      id: `event-${randomUUID()}`,
      event,
      timestampMs: Date.now(),
    };
    if (targetSession.id === this.tm.sessions.activeSession?.id)
      this.tm.appendEntry(transcriptEntry);
    else targetSession.db.appendTranscriptEntry(transcriptEntry);
  }
  queueEventWake(agentKey: string, event: unknown): void {
    if (
      this.tm.pendingWakes.enqueuePendingWake(this.pendingEventWakes, agentKey, [
        event,
      ])
    )
      void this.reviveForEvents(agentKey);
  }
  async reviveForEvents(agentKey: string): Promise<void> {
    if (
      !this.tm.execution.canExecute ||
      this.revivingEventAgentIds.has(agentKey)
    )
      return;
    this.revivingEventAgentIds.add(agentKey);
    try {
      while ((this.pendingEventWakes.get(agentKey)?.length ?? 0) > 0) {
        const eventBatch = this.pendingEventWakes.get(agentKey) ?? [];
        this.pendingEventWakes.delete(agentKey);
        try {
          await this.runEventWake(agentKey, eventBatch);
        } catch (error) {
          console.error(
            `[transcript-manager] event wake revival failed for ${agentKey}:`,
            error,
          );
        }
      }
    } finally {
      this.revivingEventAgentIds.delete(agentKey);
    }
  }
  async runEventWake(agentKey: string, eventBatch: readonly any[]): Promise<void> {
    if (eventBatch.length === 0 || !this.tm.execution.canExecute) return;
    let targetSession: any;
    try {
      targetSession = await this.tm.sessions.resolveBackgroundSession(agentKey);
    } catch {
      return;
    }
    if (!this.tm.groupChat.isGroupSession(targetSession))
      await this.runBackgroundWake(
        targetSession,
        "event",
        "event",
        (sessionRunner) =>
          sessionRunner.run(buildTimelineEventWakePrompt(eventBatch), {
            hidden: true,
            isSilenceAllowed: true,
          }),
        "Timeline event follow-up failed",
      );
  }
  hasRunningBackgroundShellWork(): boolean {
    for (const sessionRunner of this.tm.runnerRegistry.runners.values())
      if (sessionRunner.hasRunningBackgroundShellWork()) return true;
    return false;
  }

  private async runBackgroundWake(
    targetSession: any,
    requestSource: string,
    queueSource: string,
    run: (sessionRunner: any) => Promise<unknown>,
    trayTitle: string,
    errorSource = requestSource,
  ): Promise<void> {
    const sessionRunner = this.tm.runnerRegistry.getRunner(targetSession);
    this.tm.runLifecycle.beginSessionRun(targetSession);
    await this.tm.runLifecycle.enqueueExclusiveRun(
      targetSession.id,
      async () => {
        this.tm.turnRuntime.activeRequestPrompts.delete(targetSession.id);
        this.tm.turnRuntime.activeRequestSources.set(targetSession.id, requestSource);
        try {
          await run(sessionRunner);
          await this.tm.roster.emitAgentUpdate(targetSession.id);
        } catch (error) {
          this.reportWakeError(targetSession, errorSource, trayTitle, error);
        } finally {
          this.tm.runLifecycle.endSessionRun(targetSession);
        }
      },
      { lane: "background", source: queueSource },
    );
  }
  private reportWakeError(
    targetSession: any,
    source: string,
    title: string,
    error: unknown,
  ): void {
    this.tm.telemetry.reportAgentError({
      source,
      conversationId: targetSession.id,
      requestId: this.tm.runLifecycle.lastRequestIdBySession.get(targetSession.id),
      error: classifyAgentError(error),
      detail: slateErrorDetail(error),
    });
    this.tm.trayErrors.pushError({
      agentId: targetSession.id,
      title,
      ...describeAgentRunError(error),
    });
  }
}
