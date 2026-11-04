/** Picking a conversation back up after the user was handed the box.

 * A box that comes back, an MCP server that finished authorizing, a subscriber that connected — each is a moment the
 * agent was paused for, so it is resumed with the hiddenPrompt its situation calls for, and the badge that said the user was
 * being waited on is cleared or set to say something else. */
import {
  planBoxReturn,
  type BoxReturnTicket,
} from "../../shared/forever-box.ts";
import { formatMcpAccountDisplayName } from "../../shared/mcp.ts";
import { slateErrorDetail } from "../ports/telemetry.ts";
import { describeAgentRunError } from "./agent-run-error.ts";
import { classifyAgentError } from "./turn-runtime.ts";
import type { TranscriptManagerLike } from "./transcript-hub.ts";

export interface AwaitingStateSink {
  set(agentId: string, state: unknown): void;
  clear(agentId: string): void;
  trySetForTab(
    agentId: string,
    state: { tabId: string; [key: string]: unknown },
  ): void;
  clearForTab(
    agentId: string,
    tabId: string,
    tabOptions?: { ifSinceBefore?: number },
  ): void;
}

export class BoxHandoffResume {
  readonly boxHandoffs = new Map<string, BoxReturnTicket>();
  readonly foreverBoxListeners = new Set<(value: unknown) => void>();
  readonly awaitingSink = this.createAwaitingStateSink();

  constructor(readonly tm: TranscriptManagerLike) {}

  subscribeForeverBox(subscriber: (value: unknown) => void): () => void {
    this.foreverBoxListeners.add(subscriber);
    return () => this.foreverBoxListeners.delete(subscriber);
  }

  withBoxHandoff<T extends { agentId: string }>(
    boxStatus: T,
  ): T & { handoff: BoxReturnTicket | null } {
    return { ...boxStatus, handoff: this.boxHandoffs.get(boxStatus.agentId) ?? null };
  }

  createAwaitingStateSink(): AwaitingStateSink {
    return {
      set: (agentId, state) => {
        void this.applyAwaitingState(agentId, state);
      },
      clear: (agentId) => {
        void this.applyAwaitingState(agentId, null);
      },
      trySetForTab: (agentId, state) => {
        void this.applyAwaitingStateForTab(agentId, state.tabId, state);
      },
      clearForTab: (agentId, tabId, tabOptions) => {
        void this.applyAwaitingStateForTab(agentId, tabId, null, tabOptions);
      },
    };
  }

  async applyAwaitingState(agentId: string, state: unknown): Promise<void> {
    if (this.tm.sessions.isAgentGone(agentId)) return;
    try {
      await this.tm.sessionStore.setAwaitingUserResponse(agentId, state);
      await this.tm.roster.emitAgentUpdate(agentId);
    } catch {
      // Awaiting badges are advisory and must not interrupt a turn.
    }
  }

  async applyAwaitingStateForTab(
    agentId: string,
    tabId: string,
    state: unknown,
    tabOptions?: { ifSinceBefore?: number },
  ): Promise<void> {
    if (this.tm.sessions.isAgentGone(agentId)) return;
    try {
      const applied = await this.tm.sessionStore.setAwaitingUserResponseForTab(
        agentId,
        tabId,
        state,
        tabOptions,
      );
      if (applied) await this.tm.roster.emitAgentUpdate(agentId);
    } catch {
      // A stale tab or disappearing agent is an expected race.
    }
  }

  async handBackForeverBox(agentId: string, trigger: string): Promise<void> {
    const returnPlan = planBoxReturn(this.boxHandoffs.get(agentId), trigger);
    if (returnPlan.type === "untracked") return;
    this.boxHandoffs.delete(agentId);
    this.awaitingSink.clear(agentId);
    await this.tm.resolveBoxRequestEntry(
      agentId,
      returnPlan.requestId,
      returnPlan.outcome,
    );
    await this.tm.emitForeverBoxStatus(agentId);
    await this.tm.resumeAfterBoxHandoff(agentId, returnPlan.cause);
  }

  async emitForeverBoxStatus(agentId: string): Promise<void> {
    try {
      const boxStatus = this.withBoxHandoff(
        await this.tm.foreverBox.getStatus({ id: agentId }),
      );
      for (const subscriber of this.foreverBoxListeners) subscriber(boxStatus);
    } catch {
      // Status listeners are best effort while boxes are being recreated.
    }
  }

  async resumeAfterBoxHandoff(
    agentId: string,
    trigger = "button",
  ): Promise<void> {
    let hiddenPrompt =
      "[The user handed the box back to you. Please continue your task — start with the read-only Screenshot tool to see the current state of the box desktop.]";
    if (trigger === "dismissed") {
      hiddenPrompt =
        "[The user dismissed your box help request without doing the step you asked for. Treat it as declined: do not assume the step happened, and do not immediately request the box again for the same step. Continue the task without it if you can — skip the step or find another way. If the task cannot proceed without it, send the user a brief message saying what is blocked, then stop and wait for their reply.]";
    } else if (trigger === "viewer-closed") {
      hiddenPrompt =
        "[The user closed the box desktop viewer without explicitly handing control back, so they may or may not have finished the step you asked for. Start with the read-only Screenshot tool to check the current state of the box desktop. If the step is clearly done, continue the task. If you can't tell, send the user a brief message asking whether they finished so you can keep going.]";
    }
    await this.resumeWithHiddenPrompt(
      agentId,
      hiddenPrompt,
      "Agent failed to resume after box handoff",
    );
  }

  async resumeAfterMcpAuth(
    agentId: string,
    serverName: string,
    accountLabel: string,
  ): Promise<void> {
    const accountName = formatMcpAccountDisplayName(serverName, accountLabel);
    await this.resumeWithHiddenPrompt(
      agentId,
      `[The "${accountName}" MCP server finished authorizing — it's connected and its tools are available now. Your first action is a SendMessage telling the user it's connected, then pick up whatever you paused to authorize it. If there was nothing else to do, just confirm it's ready and ask what they'd like to do with it. Remember: nothing reaches the user unless it's inside a SendMessage.]`,
      "Agent failed to resume after MCP authentication",
    );
  }

  async resumeAfterListenerConnect(
    agentId: string,
    messagingPlatform: string,
  ): Promise<void> {
    const accountName = messagingPlatform === "slack" ? "Slack" : "GitHub";
    const channelNote =
      messagingPlatform === "slack"
        ? " For a channel subscriber, also remind them the Cursor bot must be in the channel (/invite @Cursor) or messages there can't reach it."
        : "";
    await this.resumeWithHiddenPrompt(
      agentId,
      `[${accountName} is now connected to the user's Cursor account — ${accountName} subscriber routines can fire. Your first action is a SendMessage telling the user it's connected, then pick up whatever you paused (e.g. finish or re-check the subscriber routine you were setting up).${channelNote} Remember: nothing reaches the user unless it's inside a SendMessage.]`,
      "Agent failed to resume after listener connect",
    );
  }

  async resumeWithHiddenPrompt(
    agentId: string,
    hiddenPrompt: string,
    failureTitle: string,
  ): Promise<void> {
    if (!this.tm.execution.canExecute) return;
    let resumedSession: any;
    try {
      resumedSession = await this.tm.sessions.resolveBackgroundSession(agentId);
    } catch {
      return;
    }
    if (this.tm.groupChat.isGroupSession(resumedSession)) return;
    const activeRunner = this.tm.runnerRegistry.getRunner(resumedSession);
    this.tm.runLifecycle.beginSessionRun(resumedSession);
    const acknowledgementToken = this.tm.ackObligations.mintAckRunToken(resumedSession.id);
    await this.tm.runLifecycle.enqueueExclusiveRun(
      resumedSession.id,
      async () => {
        this.tm.turnRuntime.activeRequestPrompts.delete(resumedSession.id);
        this.tm.turnRuntime.activeRequestSources.set(
          resumedSession.id,
          "handoff-resume",
        );
        try {
          await activeRunner.run(hiddenPrompt, {
            hidden: true,
            ackToken: acknowledgementToken,
            requestSource: "handoff-resume",
          });
          await this.tm.roster.emitAgentUpdate(resumedSession.id);
        } catch (failure) {
          this.tm.telemetry.reportAgentError({
            source: "resume",
            conversationId: resumedSession.id,
            requestId: this.tm.runLifecycle.lastRequestIdBySession.get(
              resumedSession.id,
            ),
            error: classifyAgentError(failure),
            detail: slateErrorDetail(failure),
          });
          this.tm.trayErrors.pushError({
            agentId: resumedSession.id,
            title: failureTitle,
            ...describeAgentRunError(failure),
          });
        } finally {
          this.tm.ackObligations.retireAckRunToken(resumedSession.id, acknowledgementToken);
          this.tm.runLifecycle.endSessionRun(resumedSession);
        }
      },
      { lane: "background", source: "handoff-resume", ackToken: acknowledgementToken },
    );
  }
}
