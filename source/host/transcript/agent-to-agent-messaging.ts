/** One agent reaching out to another.

 * What one agent says to another is clamped, written into both conversations, and newQueue for the recipient; the queue
 * is drained one wake at a time, with priority messages interrupting what the recipient is doing and anything that
 * could not be delivered given back rather than lost. */
import {
  buildAgentInboundWakePrompt,
  clampAgentMessage,
} from "../agents/agent-messaging.ts";
import { slateErrorDetail } from "../ports/telemetry.ts";
import { raisesUserActivity } from "../../shared/transcript.ts";
import { describeAgentRunError } from "./agent-run-error.ts";
import { loadAgentInboundImages } from "./send-message-shaping.ts";
import { nextEntryId } from "./transcript-entry-ids.ts";
import { getTranscript } from "./transcript-store.ts";
import { classifyAgentError } from "./turn-runtime.ts";
import type { TranscriptManagerLike } from "./transcript-hub.ts";

export interface AgentInboundMessage {
  from: { id: string; name: string };
  text: string;
  timestampMs: number;
  images?: readonly { url: string; alt?: string }[];
  priority?: boolean;
  isDisplayed?: boolean;
  isRedriven?: boolean;
}

/** A list split into what interrupts the recipient and what waits. */
export function partitionAgentInbound<T extends { priority?: boolean }>(
  messages: readonly T[],
): { priority: T[]; rest: T[] } {
  const priority: T[] = [],
    rest: T[] = [];
  for (const message of messages)
    (message.priority === true ? priority : rest).push(message);
  return { priority, rest };
}

export function prioritizeAgentInbound<T extends { priority?: boolean }>(
  messages: readonly T[],
): T[] {
  const split = partitionAgentInbound(messages);
  return [...split.priority, ...split.rest];
}

export function mergeAgentInboundQueue<T extends { priority?: boolean }>(
  newQueue: readonly T[],
  oldQueue: readonly T[],
): T[] {
  const fresh = partitionAgentInbound(newQueue),
    previous = partitionAgentInbound(oldQueue);
  return [...fresh.priority, ...previous.priority, ...previous.rest, ...fresh.rest];
}

/** The transcript a write goes to: the live one for the active conversation, the stored one otherwise. */
function transcriptFor(conversation: any, onActiveSession: boolean): any[] {
  return onActiveSession ? getTranscript() : conversation.db.getTranscriptEntries();
}

export class AgentToAgentMessaging {
  readonly pendingAgentInbound = new Map<string, AgentInboundMessage[]>();
  readonly revivingAgentInboundIds = new Set<string>();
  constructor(readonly tm: TranscriptManagerLike) {}

  async sendToAgent(
    senderId: string,
    recipientId: string,
    text: string,
    images: readonly { url: string; alt?: string }[] = [],
    priority = false,
  ): Promise<string> {
    const message = clampAgentMessage(text);
    if (message.length === 0) return "Message was empty; nothing was sent.";
    if (recipientId === senderId) return "An agent can't message itself.";
    if (this.tm.sessions.isAgentGone(recipientId))
      return "That agent no longer exists.";
    if (this.tm.groupChat.isRemoteRoomAgentId(recipientId))
      return "That is a shared chat hosted by another user; agents can't message it directly.";
    const agents = await this.tm.sessionStore.listAgents();
    const recipient = agents.find((agent: any) => agent.id === recipientId);
    if (recipient == null) return `No agent found with id ${recipientId}.`;
    if (recipient.isGroup) return this.postToGroup(senderId, recipientId, message, images, priority);
    this.tm.productAnalytics.trackEvent("slate.agent_message.sent", {
      from_agent_id: senderId,
      to_agent_id: recipientId,
      is_group_target: false,
      is_priority: priority,
    });
    const sourceAgent = agents.find((agent: any) => agent.id === senderId);
    this.tm.sessions.liveSessions
      .get(senderId)
      ?.db.addConversationPartner(recipientId);
    this.appendAgentOutboundEntry(
      senderId,
      { id: recipientId, name: recipient.name, kind: "agent" },
      message,
      Date.now(),
      images,
    );
    const inbound: AgentInboundMessage = {
      from: { id: senderId, name: sourceAgent?.name ?? "An agent" },
      text: message,
      timestampMs: Date.now(),
      ...(images.length === 0 ? {} : { images }),
      ...(priority ? { priority: true } : {}),
    };
    const newQueue = this.pendingAgentInbound.get(recipientId) ?? [];
    if (priority) {
      this.pendingAgentInbound.set(recipientId, [inbound, ...newQueue]);
      this.steerRecipientForPriorityPeer(recipientId);
    } else {
      newQueue.push(inbound);
      this.pendingAgentInbound.set(recipientId, newQueue);
    }
    void this.reviveForAgentInbound(recipientId);
    return priority
      ? `Sent to ${recipient.name} as a priority message — it will interrupt their current non-user work and wake them now. This is asynchronous — if they reply, it'll arrive later as a new message that wakes you; don't wait on it now.`
      : `Sent to ${recipient.name}. This is asynchronous — if they reply, it'll arrive later as a new message that wakes you; don't wait on it now.`;
  }

  /** A message to a group: text only, and priority does not interrupt members. */
  private async postToGroup(
    senderId: string,
    recipientId: string,
    message: string,
    images: readonly { url: string; alt?: string }[],
    priority: boolean,
  ): Promise<string> {
    const acknowledgement = await this.tm.postToGroup(senderId, recipientId, message, priority);
    const warnings: string[] = [];
    if (images.length > 0)
      warnings.push(
        `Note: the attached image${images.length === 1 ? " was" : "s were"} NOT delivered — group messages are text-only for now; send images to an agent directly.`,
      );
    if (priority)
      warnings.push("Note: priority is 1:1 only — this post did not interrupt members.");
    return warnings.length === 0 ? acknowledgement : `${acknowledgement} ${warnings.join(" ")}`;
  }

  steerRecipientForPriorityPeer(agentKey: string): void {
    const runScheduler = this.tm.runLifecycle.runScheduler;
    if (runScheduler == null || runScheduler.getActiveLane(agentKey) === "user")
      return;
    const interruptReason = "superseded by a priority agent message";
    const hadRunInFlight = this.tm.runLifecycle.runningAgentIds().has(agentKey);
    const groupInterrupted =
      this.tm.runnerRegistry.activeGroupMemberRunners
        .get(agentKey)
        ?.interrupt(interruptReason) ?? false;
    if (groupInterrupted) this.tm.groupChat.dmPreemptedGroupMemberIds.add(agentKey);
    const directInterrupted =
      this.tm.runnerRegistry.runners.get(agentKey)?.interrupt(interruptReason) ?? false;
    if (directInterrupted)
      this.tm.backgroundWakes.dmPreemptedWakeAgentIds.add(agentKey);
    if (directInterrupted || groupInterrupted || hadRunInFlight)
      this.tm.telemetry.reportTurnInterrupt({
        conversationId: agentKey,
        reason: "agent_steer",
        hadActiveRun: directInterrupted || groupInterrupted,
        wasInFlight: hadRunInFlight,
      });
  }

  async reviveForAgentInbound(agentKey: string): Promise<void> {
    if (!this.tm.execution.canExecute || this.revivingAgentInboundIds.has(agentKey)) return;
    this.revivingAgentInboundIds.add(agentKey);
    try {
      while ((this.pendingAgentInbound.get(agentKey)?.length ?? 0) > 0) {
        const messages = prioritizeAgentInbound(this.pendingAgentInbound.get(agentKey) ?? []);
        this.pendingAgentInbound.delete(agentKey);
        await this.runAgentInboundWake(agentKey, messages);
      }
    } finally {
      this.revivingAgentInboundIds.delete(agentKey);
    }
  }

  async runAgentInboundWake(
    agentKey: string,
    messages: readonly AgentInboundMessage[],
  ): Promise<void> {
    if (messages.length === 0 || !this.tm.execution.canExecute) return;
    let conversation: any;
    try {
      conversation = await this.tm.sessions.resolveBackgroundSession(agentKey);
    } catch {
      return;
    }
    if (this.tm.groupChat.isGroupSession(conversation) || this.tm.groupChat.isRemoteRoomSession(conversation)) return;
    this.appendAgentInboundEntries(
      conversation,
      messages.filter((message) => message.isDisplayed !== true),
    );
    const agentRunner = this.tm.runnerRegistry.getRunner(conversation);
    this.tm.runLifecycle.beginSessionRun(conversation);
    await this.tm.runLifecycle.enqueueExclusiveRun(
      conversation.id,
      async () => {
        this.tm.turnRuntime.activeRequestPrompts.delete(conversation.id);
        this.tm.turnRuntime.activeRequestSources.set(conversation.id, "agent");
        this.tm.backgroundWakes.dmPreemptedWakeAgentIds.delete(conversation.id);
        try {
          if (await this.deliverInboundMessages(agentKey, messages, conversation, agentRunner)) await this.tm.roster.emitAgentUpdate(conversation.id);
        } catch (error) {
          this.reportInboundFailure(conversation, error);
        } finally {
          this.tm.runLifecycle.endSessionRun(conversation);
        }
      },
      { lane: "agent", source: "agent" },
    );
  }

  /** Hands the messages to the agent one at a time, giving the rest back when a priority one arrives. */
  private async deliverInboundMessages(agentKey: string, messages: readonly AgentInboundMessage[], conversation: any, agentRunner: any): Promise<boolean> {
    for (const [position, message] of messages.entries()) {
      if (position > 0 && (this.pendingAgentInbound.get(agentKey) ?? []).some((waiting) => waiting.priority === true)) {
        const oldQueue = messages.slice(position).map((leftover) => ({ ...leftover, isDisplayed: true }));
        this.pendingAgentInbound.set(agentKey, mergeAgentInboundQueue(this.pendingAgentInbound.get(agentKey) ?? [], oldQueue));
        return false;
      }
      const selectedImages = await loadAgentInboundImages(message.images);
      const turnResult = await agentRunner.run(
        buildAgentInboundWakePrompt(message),
        {
          hidden: true,
          isSilenceAllowed: true,
          ...(selectedImages.length === 0 ? {} : { selectedImages }),
        },
      );
      const wasPreempted = this.tm.backgroundWakes.dmPreemptedWakeAgentIds.delete(conversation.id);
      if (turnResult.aborted && turnResult.quiescedForUpgrade !== true) {
        if (!wasPreempted || this.tm.sessions.isAgentGone(agentKey)) return false;
        const retryable = messages
          .slice(position)
          .filter((leftover) => leftover.isRedriven !== true)
          .map((leftover) => ({ ...leftover, isDisplayed: true, isRedriven: true }));
        if (retryable.length > 0)
          this.pendingAgentInbound.set(agentKey, mergeAgentInboundQueue(this.pendingAgentInbound.get(agentKey) ?? [], retryable));
        return false;
      }
    }
    return true;
  }

  /** Reports an inbound wake that failed, where the user can see it. */
  private reportInboundFailure(conversation: any, error: unknown): void {
    this.tm.telemetry.reportAgentError({
      source: "agent",
      conversationId: conversation.id,
      requestId: this.tm.runLifecycle.lastRequestIdBySession.get(conversation.id),
      error: classifyAgentError(error),
      detail: slateErrorDetail(error),
    });
    this.tm.trayErrors.pushError({
      agentId: conversation.id,
      title: "Message from another agent failed",
      ...describeAgentRunError(error),
    });
  }

  appendAgentInboundEntries(
    conversation: any,
    messages: readonly AgentInboundMessage[],
  ): void {
    const onActiveSession = conversation.id === this.tm.sessions.activeSession?.id;
    let marksActivity = false;
    for (const message of messages) {
      conversation.db.addConversationPartner(message.from.id);
      const transcriptEntry = {
        kind: "message",
        id: nextEntryId(transcriptFor(conversation, onActiveSession), "user-message"),
        role: "user",
        content: message.text,
        isStreaming: false,
        timestampMs: message.timestampMs,
        fromAgent: message.from,
        ...(message.images?.length ? { images: message.images } : {}),
      };
      marksActivity ||= raisesUserActivity(transcriptEntry);
      if (onActiveSession) this.tm.appendEntry(transcriptEntry);
      else conversation.db.appendTranscriptEntry(transcriptEntry);
    }
    if (!onActiveSession) {
      if (marksActivity) this.tm.sessionStore.markSessionActivity(conversation);
      void this.tm.roster.emitAgentUpdate(conversation.id);
    }
  }

  appendAgentOutboundEntry(
    senderId: string,
    toAgent: { readonly kind?: string; readonly [key: string]: unknown },
    text: string,
    timestampMs: number,
    images: readonly { url: string; alt?: string }[] = [],
  ): void {
    const conversation = this.tm.sessions.liveSessions.get(senderId);
    if (conversation == null) return;
    const onActiveSession = conversation.id === this.tm.sessions.activeSession?.id;
    const transcriptEntry = {
      kind: "message",
      id: nextEntryId(transcriptFor(conversation, onActiveSession), "assistant-message"),
      role: "assistant",
      content: text,
      isStreaming: false,
      timestampMs,
      toAgent,
      ...(images.length === 0 ? {} : { images }),
    };
    if (onActiveSession) this.tm.appendEntry(transcriptEntry);
    else {
      conversation.db.appendTranscriptEntry(transcriptEntry);
      if (raisesUserActivity(transcriptEntry)) this.tm.sessionStore.markSessionActivity(conversation);
      void this.tm.roster.emitAgentUpdate(conversation.id);
    }
  }
}