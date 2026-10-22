/**
 * The acknowledgement a sent message is owed.
 *
 * A send that the user has heard nothing back from is remembered as an owed: it is fulfilled when the agent
 * actually sends something, redriven when it goes idle or the host comes back up, and given up on when the agent is
 * gone or the redrives ran out — with each of those steps reported.
 */
import { randomUUID } from "node:crypto";
import { slateErrorDetail } from "../ports/telemetry.ts";
import { classifyAgentError, isDeliveryOwed } from "./turn-runtime.ts";
import type { Disposable, TranscriptManagerLike } from "./transcript-hub.ts";

export const MAX_ACK_REDRIVES = 3;
export const ACK_REDRIVE_IDLE_DELAY_MS = 5_000;

/** The recoveryPrompt a redrive sends: it has to make the agent actually answer, not think about answering. */
export function buildAckRedrivePrompt(): string {
  return "[System recovery] The user sent one or more messages that were never visibly acknowledged — the turns handling them were interrupted, or the app restarted before a reply went out. Their newest message may be MISSING from your context entirely. Respond now by actually invoking the SendMessage tool: if you can see their latest message and already completed what it asked, send a brief confirmation with the result; if you can see it but the work is not done, acknowledge them and continue the work; if you cannot be certain what they last asked, say you may have missed their latest message and ask them to resend it — NEVER guess or claim completion of work you cannot see. Plain assistant text is NEVER shown to the user; only a real SendMessage tool invocation reaches them. Do NOT end this turn with only thinking, an empty reply, or a plan to send later — ending the turn without a real SendMessage invocation delivers nothing and is a failure. Invoke SendMessage now, even if all you can send is a brief status update.";
}

/** Whether a transcript entry is a message the user wrote themselves: not an agent's, not a channel's. */
function isUserWrittenMessage(entry: any): boolean {
  return entry.kind === "message" && entry.role === "user" && entry.fromAgent == null && entry.channel == null;
}

/** The user turns a redrive hands to the agent, with the redrive recoveryPrompt as the newest one. */
function redriveConversationHistory(transcript: any[], recoveryPrompt: string, redriveMessageId: string): any[] {
  const history: any[] = transcript
    .filter(isUserWrittenMessage)
    .map((entry: any) => ({ id: entry.id, text: entry.content, richText: entry.richText }));
  history.push({ id: redriveMessageId, text: recoveryPrompt });
  return history;
}

export class AckObligations {
  readonly ackRedriveTimers = new Map<string, Disposable>();
  readonly ackRunTokens = new Map<string, Set<string>>();

  constructor(readonly tm: TranscriptManagerLike) {}

  /** Whether this host can owe anything at all: it has the ackStore and a run queue. */
  private canOweAck(): boolean {
    return this.tm.ackObligationStore != null && this.tm.runLifecycle.runScheduler != null;
  }

  /** Whether a redrive may be driven right now: it can owe, and nothing is stopping runs. */
  private canRedriveAck(): boolean {
    return this.canOweAck() && !this.tm.disposed && !this.tm.upgradeResume.quiescingForUpgrade;
  }

  /** Why nothing was delivered on a redrive turn, reported the way the turn reports itself. */
  private reportEmptyAckTurn(conversationId: string, agent: string, bumped: { redriveAttempts: number }, agentRunner: any, delivery: any, startedAtMs: number, ackStore: any): void {
    this.tm.telemetry.reportTurnEmptyDelivery({
      conversationId,
      requestId: this.tm.runLifecycle.lastRequestIdBySession.get(conversationId),
      source: "ack_redrive",
      requestSource: "handoff-resume",
      redriveAttempts: bumped.redriveAttempts,
      toolCallCount: agentRunner.getObservedToolCallCount(),
      streamOutputProduced: delivery.streamOutputProduced === true,
      durationMs: Date.now() - startedAtMs,
      ackOutstanding: ackStore.get(agent) != null,
    });
  }

  /** A redrive turn that threw, reported the way the host reports agent errors. */
  private reportRedriveError(conversationId: string, error: unknown): void {
    this.tm.telemetry.reportAgentError({
      source: "ack_redrive",
      conversationId,
      requestId: this.tm.runLifecycle.lastRequestIdBySession.get(conversationId),
      error: classifyAgentError(error),
      detail: slateErrorDetail(error),
    });
  }

  recordAckObligationSend(conversation: any, sentAtMs: number): void {
    if (!this.canOweAck()) return;
    this.clearAckRedriveTimer(conversation.id);
    const { obligation: owed, created } = this.tm.ackObligationStore!.recordSend(conversation.id, { atMs: sentAtMs });
    this.tm.telemetry.reportAckObligation({
      conversationId: conversation.id,
      outcome: created ? "created" : "coalesced",
      ageMs: sentAtMs - owed.createdAtMs,
      coalescedCount: owed.coalescedCount,
    });
  }

  armSendGuard(conversation: any, sentAtMs: number, owesAck: boolean): { disarm(): void; [Symbol.dispose](): void } {
    let waiting = owesAck;
    return {
      disarm: () => {
        waiting = false;
      },
      [Symbol.dispose]: () => {
        if (!waiting || !this.canOweAck()) return;
        if (this.tm.ackObligationStore!.get(conversation.id) == null) this.recordAckObligationSend(conversation, sentAtMs);
      },
    };
  }

  confirmAckObligationAfterInterrupt(conversation: any, sentAtMs: number, interrupted: boolean): void {
    if (!this.canOweAck()) return;
    this.clearAckRedriveTimer(conversation.id);
    if (this.tm.ackObligationStore!.get(conversation.id) == null) this.recordAckObligationSend(conversation, sentAtMs);
    if (interrupted) this.tm.ackObligationStore!.recordInterrupt(conversation.id, sentAtMs);
  }

  mintAckRunToken(agent: string): string | undefined {
    if (!this.canOweAck()) return undefined;
    const token = randomUUID();
    const tokens = this.ackRunTokens.get(agent) ?? new Set<string>();
    tokens.add(token);
    this.ackRunTokens.set(agent, tokens);
    return token;
  }

  retireAckRunToken(agent: string, token?: string): void {
    if (token == null) return;
    const tokens = this.ackRunTokens.get(agent);
    if (tokens == null) return;
    tokens.delete(token);
    if (tokens.size === 0) this.ackRunTokens.delete(agent);
  }

  fulfillAckObligation(agent?: string, runToken?: string): void {
    if (agent == null || runToken == null || this.ackRunTokens.get(agent)?.has(runToken) !== true) return;
    if (!this.canOweAck()) return;
    const owed = this.tm.ackObligationStore!.get(agent);
    if (owed == null) return;
    this.tm.ackObligationStore!.clear(agent);
    this.clearAckRedriveTimer(agent);
    const nowMs = Date.now();
    this.tm.telemetry.reportAckObligation({
      conversationId: agent,
      outcome: "fulfilled",
      ageMs: nowMs - owed.createdAtMs,
      coalescedCount: owed.coalescedCount,
      redriveAttempts: owed.redriveAttempts,
      timeToFirstVisibleAckMs: nowMs - owed.createdAtMs,
      ...(owed.lastInterruptAtMs == null ? {} : { interruptToReplacementAckMs: nowMs - owed.lastInterruptAtMs }),
    });
  }

  markAckObligationLost(agent: string, reason: "agent_deleted" | "max_redrives"): void {
    if (!this.canOweAck()) return;
    const owed = this.tm.ackObligationStore!.get(agent);
    if (owed == null) return;
    this.tm.ackObligationStore!.clear(agent);
    this.clearAckRedriveTimer(agent);
    this.tm.telemetry.reportAckObligation({
      conversationId: agent,
      outcome: "lost",
      reason,
      ageMs: Date.now() - owed.createdAtMs,
      coalescedCount: owed.coalescedCount,
      redriveAttempts: owed.redriveAttempts,
    });
  }

  clearAckRedriveTimer(agent: string): void {
    const timer = this.ackRedriveTimers.get(agent);
    if (timer == null) return;
    timer.dispose();
    this.ackRedriveTimers.delete(agent);
  }

  scheduleAckRedriveAfterIdle(agent: string): void {
    this.armAckRedriveTimer(agent, "idle");
  }

  armAckRedriveTimer(agent: string, cause: "idle" | "boot"): void {
    if (!this.canRedriveAck()) return;
    if (this.tm.ackObligationStore!.get(agent) == null) return;
    this.clearAckRedriveTimer(agent);
    this.ackRedriveTimers.set(
      agent,
      this.tm.ackRedrivePolicy.arm(agent, () => {
        this.ackRedriveTimers.delete(agent);
        void this.redriveAckObligation(agent, cause);
      }),
    );
  }

  async redriveUnfulfilledAckObligations(): Promise<void> {
    if (!this.canOweAck() || !this.tm.execution.canExecute) return;
    for (const owed of this.tm.ackObligationStore!.list()) this.armAckRedriveTimer(owed.agentId, "boot");
  }

  /** The bumped a redrive reports before it resolves the conversation it is about. */
  private reportRedriveAttempt(agent: string, cause: "idle" | "boot", bumped: { createdAtMs: number; coalescedCount: number; redriveAttempts: number }): void {
    this.tm.telemetry.reportAckObligation({
      conversationId: agent,
      outcome: "redrive",
      reason: cause,
      ageMs: Date.now() - bumped.createdAtMs,
      coalescedCount: bumped.coalescedCount,
      redriveAttempts: bumped.redriveAttempts,
    });
  }

  /** Performs one redrive turn on the conversation a resolved conversation names. */
  private async runRedriveTurn(conversation: any, agent: string, bumped: { redriveAttempts: number }, agentRunner: any, runToken: string | undefined, ackStore: any): Promise<void> {
    this.tm.turnRuntime.activeRequestPrompts.delete(conversation.id);
    this.tm.turnRuntime.activeRequestSources.set(conversation.id, "handoff-resume");
    try {
      if (ackStore.get(agent) == null) return;
      const startedAtMs = Date.now();
      const recoveryPrompt = buildAckRedrivePrompt();
      const redriveMessageId = `ack-redrive-${randomUUID()}`;
      const recentUserMessages = redriveConversationHistory(conversation.db.getTranscriptEntries(), recoveryPrompt, redriveMessageId);
      const delivery = await agentRunner.run(recoveryPrompt, {
        hidden: true,
        ...(runToken == null ? {} : { ackToken: runToken }),
        messageId: redriveMessageId,
        recentUserMessages,
        requestSource: "handoff-resume",
      });
      await this.tm.roster.emitAgentUpdate(conversation.id);
      if (isDeliveryOwed(delivery) && !delivery.aborted && delivery.quiescedForUpgrade !== true) this.reportEmptyAckTurn(conversation.id, agent, bumped, agentRunner, delivery, startedAtMs, ackStore);
    } catch (error) {
      this.reportRedriveError(conversation.id, error);
    } finally {
      this.retireAckRunToken(conversation.id, runToken);
      this.tm.runLifecycle.endSessionRun(conversation);
    }
  }

  async redriveAckObligation(agent: string, cause: "idle" | "boot"): Promise<void> {
    if (!this.canOweAck() || !this.tm.execution.canExecute || this.tm.disposed || this.tm.upgradeResume.quiescingForUpgrade) return;
    const ackStore = this.tm.ackObligationStore!;
    const owed = ackStore.get(agent);
    if (owed == null) return;
    if (this.tm.sessions.isAgentGone(agent)) return this.markAckObligationLost(agent, "agent_deleted");
    if (owed.redriveAttempts >= MAX_ACK_REDRIVES) return this.markAckObligationLost(agent, "max_redrives");
    const bumped = ackStore.recordRedriveAttempt(agent);
    if (bumped == null) return;
    this.reportRedriveAttempt(agent, cause, bumped);
    let conversation: any;
    try {
      conversation = await this.tm.sessions.resolveBackgroundSession(agent);
    } catch {
      this.scheduleAckRedriveAfterIdle(agent);
      return;
    }
    if (this.tm.groupChat.isGroupSession(conversation) || this.tm.groupChat.isRemoteRoomSession(conversation)) {
      ackStore.clear(agent);
      return;
    }
    const agentRunner = this.tm.runnerRegistry.getRunner(conversation);
    this.tm.runLifecycle.beginSessionRun(conversation);
    const runToken = this.mintAckRunToken(conversation.id);
    await this.tm.runLifecycle.enqueueExclusiveRun(
      conversation.id,
      async () => this.runRedriveTurn(conversation, agent, bumped, agentRunner, runToken, ackStore),
      {
        lane: "background",
        source: "ack-redrive",
        ...(runToken == null ? {} : { ackToken: runToken }),
      },
    );
  }
}