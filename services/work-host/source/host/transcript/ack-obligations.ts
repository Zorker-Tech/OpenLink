/**
 * The acknowledgement a sent message is owed.
 *
 * A send that the user has heard nothing back from is remembered as an owed: it is fulfilled when the agent
 * actually sends something, redriven when it goes idle or the host comes back up, and given up on when the agent is
 * gone or the redrives ran out — with each of those steps reported.
 */
import { randomUUID } from "node:crypto";
import type { FirstBotReply, FirstBotReplyContext, FirstBotReplyInput } from '../bot/first-bot-reply.ts';
import { dialogueContent } from '../inspiration/inspiration-preference-summary.ts';
import { slateErrorDetail } from "../ports/telemetry.ts";
import { classifyAgentError, isDeliveryOwed } from "./turn-runtime.ts";
import { createSendMessageEntry, quotableEntryText } from './send-message-shaping.ts';
import { allocateTranscriptEntryId } from './transcript-entry-ids.ts';
import { getTranscript, removeEntry } from './transcript-store.ts';
import type { Disposable, TranscriptEntry, TranscriptManagerLike } from "./transcript-hub.ts";

export const MAX_ACK_REDRIVES = 3;
export const ACK_REDRIVE_IDLE_DELAY_MS = 5_000;
const QUICK_BOT_REPLY_TIMEOUT_MS = 4_000;

type FirstBotReplyGenerator = (agentId: string, input: FirstBotReplyInput, signal: AbortSignal) => Promise<FirstBotReply | null>;
type PendingQuickReply = { controller: AbortController; settled: Promise<void> };

function quotableFirstReply(entry: TranscriptEntry): string {
  return entry.kind === 'send-message' ? quotableEntryText(entry).trim() : '';
}

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
  readonly #quickBotReplies = new Map<string, PendingQuickReply>();
  #firstBotReplyGenerator?: FirstBotReplyGenerator;

  constructor(readonly tm: TranscriptManagerLike) {}

  setFirstBotReplyGenerator(generator: FirstBotReplyGenerator): void {
    this.#firstBotReplyGenerator = generator;
  }

  armQuickBotReply(conversation: any, userMessageId: string, prompt: string, acceptedAtMs: number, hasAttachments = false): void {
    const generate = this.#firstBotReplyGenerator;
    const deadline = acceptedAtMs + QUICK_BOT_REPLY_TIMEOUT_MS;
    const remaining = deadline - Date.now();
    if (!generate || remaining <= 0) return;
    const key = `${conversation.id}:${userMessageId}`;
    if (this.#quickBotReplies.has(key)) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(remaining)]);
    const settled = this.#generateQuickBotReply(conversation, userMessageId, prompt, hasAttachments, generate, signal, deadline).finally(() => {
      if (this.#quickBotReplies.get(key)?.controller === controller) this.#quickBotReplies.delete(key);
    });
    this.#quickBotReplies.set(key, { controller, settled });
  }

  async firstBotReplyContext(agentId: string, messageId: string, signal: AbortSignal): Promise<FirstBotReplyContext> {
    const pending = this.#quickBotReplies.get(`${agentId}:${messageId}`);
    if (pending) {
      const cancel = () => pending.controller.abort();
      if (signal.aborted) cancel();
      signal.addEventListener('abort', cancel, { once: true });
      try { await pending.settled; } finally { signal.removeEventListener('abort', cancel); }
    }
    if (signal.aborted) return { reply: null, recentCompletedTurns: [] };

    const entries: TranscriptEntry[] = this.tm.sessions.getAgentTranscriptTail(agentId, { limit: 200 }).entries;
    const anchor = entries.findIndex(entry => entry.id === messageId);
    const current = entries.find(entry => entry.firstBotReplyTo === messageId);
    const message = current ? quotableFirstReply(current) : '';
    const reply = message && typeof current?.firstBotReplyNeedsFollowUp === 'boolean'
      ? { message, emoji: typeof current.firstBotReplyEmoji === 'string' ? current.firstBotReplyEmoji : null, needsFollowUp: current.firstBotReplyNeedsFollowUp }
      : null;
    const recent = anchor < 0 ? [] : entries.slice(0, anchor);
    const recentCompletedTurns: FirstBotReplyInput['context'] = recent.filter(entry => entry.firstBotReplyNeedsFollowUp === false)
      .slice(-2).flatMap((entry) => {
        const user = recent.find(candidate => candidate.id === entry.firstBotReplyTo);
        return typeof user?.content === 'string' ? [
          { role: 'user' as const, text: user.content.slice(0, 200) },
          { role: 'assistant' as const, text: quotableFirstReply(entry) },
        ] : [];
      });
    return { reply, recentCompletedTurns };
  }

  clearQuickBotReplies(): void {
    for (const { controller } of this.#quickBotReplies.values()) controller.abort();
    this.#quickBotReplies.clear();
  }

  #cancelQuickBotReplies(agentId: string): void {
    for (const [key, pending] of this.#quickBotReplies) {
      if (!key.startsWith(`${agentId}:`)) continue;
      pending.controller.abort();
      this.#quickBotReplies.delete(key);
    }
  }

  async #generateQuickBotReply(conversation: any, userMessageId: string, message: string, hasAttachments: boolean, generate: FirstBotReplyGenerator, signal: AbortSignal, deadline: number): Promise<void> {
    try {
      const entries: TranscriptEntry[] = this.tm.sessions.activeSession?.id === conversation.id ? getTranscript() : conversation.db.getTranscriptEntries();
      const anchor = entries.findIndex(entry => entry.id === userMessageId);
      const context = (anchor < 0 ? entries.slice(-8) : entries.slice(Math.max(0, anchor - 8), anchor)).flatMap<FirstBotReplyInput['context'][number]>((entry) => {
        const content = dialogueContent(entry);
        if (entry.id === userMessageId || typeof content !== 'string' || !content.trim() || content.startsWith('[SLATE_HIDDEN_PROMPT]')) return [];
        return [{ role: entry.role === 'user' ? 'user' : 'assistant', text: content.slice(0, 280) }];
      }).slice(-3);
      const reply = await generate(conversation.id, { message, context, hasAttachments }, signal);
      if (reply && !signal.aborted && !this.tm.disposed && Date.now() < deadline) this.#deliverQuickBotReply(conversation, userMessageId, reply);
    } catch (error) {
      if (!signal.aborted) this.reportRedriveError(conversation.id, error);
    }
  }

  #deliverQuickBotReply(conversation: any, userMessageId: string, receipt: FirstBotReply): void {
    const active = this.tm.sessions.activeSession?.id === conversation.id;
    try {
      const entries: TranscriptEntry[] = active ? getTranscript() : conversation.db.getTranscriptEntries();
      const anchor = entries.findIndex(entry => entry.id === userMessageId && isUserWrittenMessage(entry));
      if (anchor < 0 || entries.some(entry => entry.firstBotReplyTo === userMessageId)) return;
      const entry = {
        ...createSendMessageEntry(allocateTranscriptEntryId(entries, 'send-message'), { type: 'text', content: receipt.message }, Date.now()),
        hostReceipt: true,
        firstBotReplyTo: userMessageId,
        firstBotReplyNeedsFollowUp: receipt.needsFollowUp,
        firstBotReplyEmoji: receipt.emoji,
      };
      let persisted = false;
      if (active) {
        this.tm.appendEntry(entry, { persistBeforeEmit: true, deferEmit: true, onPersistOutcome: (value: boolean) => { persisted = value; } });
        if (!persisted) removeEntry(entry.id);
      } else {
        persisted = conversation.db.appendTranscriptEntry(entry);
        if (persisted) this.tm.sessionStore.markSessionActivity(conversation);
      }
      if (persisted) {
        if (receipt.emoji) {
          try {
            this.tm.widgetResponses.applyReaction({ session: conversation, entryId: userMessageId, emoji: receipt.emoji, by: conversation.id, addOnly: true });
          } catch (error) { this.reportRedriveError(conversation.id, error); }
        }
        this.tm.roster.emit({ type: 'appended', entry }, conversation.id);
        if (entries.findLastIndex(isUserWrittenMessage) === anchor) {
          const token = this.mintAckRunToken(conversation.id);
          this.fulfillAckObligation(conversation.id, token);
          this.retireAckRunToken(conversation.id, token);
        }
      }
    } catch (error) {
      this.reportRedriveError(conversation.id, error);
    }
  }

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
    this.#cancelQuickBotReplies(agent);
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
