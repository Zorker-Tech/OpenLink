/** Creating, opening, closing and deleting a conversation's agent.

 * A new agent is given a directory, a database and — when the user asked for it — an opening; one that already exists is
 * minted where it was left, checkpointed and closed when it goes out of sight, and deleted with everything it owned,
 * with each step reported so a failure to start or finish is visible. */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { isSlateAgentLimitError } from "../../shared/agents/agents.ts";
import { errorLogTag } from "../../shared/errors/summary.ts";
import {
  cloneAgentDir,
  cloneAgentDisplayName,
} from "../agents/agent-clone.ts";
import { CANONICAL_AVATAR_FILENAME } from "../agents/agent-avatar.ts";
import { getAgentAutomationsDir } from "../automations/automation-store.ts";
import {
  SLATE_DISK_SAVER_KICKSTART_PROMPT,
  SLATE_DISK_SAVER_REAUDIT_PROMPT,
} from "../../shared/agents/disk-saver.ts";
import {
  INTRODUCTION_FAILED_TRAY_TITLE,
  SLATE_ONBOARDING_KICKSTART_PROMPT,
  introductionFailedTrayKey,
} from "../../shared/agents/onboarding.ts";
import { slateErrorDetail } from "../ports/telemetry.ts";
import { SlateAgentDb } from "../extensions/session/agent-db.ts";
import { checkpointSlateAgentDb } from "../storage/store-db.ts";
import { publishTranscriptMutation } from "./transcript-mutation-events.ts";
import { describeAgentRunError } from "./agent-run-error.ts";
import { isUserMessageEntry } from "./send-message-shaping.ts";
import { getTranscript } from "./transcript-store.ts";
import { classifyAgentError } from "./turn-runtime.ts";
import type { TranscriptManagerLike } from "./transcript-hub.ts";

export class SlateAgentLifecycleError extends Error {}
interface CreateOptions {
  purpose?: string;
  isKickstartRequested?: boolean;
  isIntroductionSuppressed?: boolean;
  configureAgentDir?(dir: string): void;
}

export class AgentLifecycle {
  constructor(readonly tm: TranscriptManagerLike) {}

  async createAgent(
    profileInput: unknown,
    originKind = "user",
    createOptions: CreateOptions = {},
  ): Promise<any> {
    const outgoing = this.tm.sessions.activeSession;
    const incoming = await this.mintAgentSession(profileInput, originKind, createOptions);
    const now = Date.now();
    await this.tm.sessions.markSessionLeftBehind(outgoing, now);
    await this.tm.sessionStore.markSessionViewed(incoming, now);
    this.tm.sessions.invalidateDeferredActivation();
    await this.tm.sessions.replaceSession(incoming);
    this.tm.sessions.clearActiveTranscript(incoming.id);
    this.tm.roster.emit({ type: "cleared" });
    await this.tm.roster.emitAgents();
    const snapshotStamp = this.tm.roster.reserveSnapshotStamp();
    const agentSummary = await this.tm.sessionStore.summarizeOpenSession(incoming);
    if (agentSummary == null)
      throw new SlateAgentLifecycleError(
        "Failed to summarize newly created Slate agent.",
      );
    if (createOptions.isKickstartRequested === true)
      void this.kickstartCreatedAgent(incoming.id);
    return {
      agent: this.tm.roster.finalizeSummaryForRpc(agentSummary, snapshotStamp),
      transcript: getTranscript(),
    };
  }
  async kickstartCreatedAgent(agentId: string): Promise<void> {
    let ready = false;
    try {
      ready = await this.tm.execution.isRunReady();
    } catch {}
    await this.kickstartAgent(agentId, ready);
  }
  async createBackgroundAgent(
    profileInput: unknown,
    originKind = "user",
    createOptions: CreateOptions = {},
  ): Promise<any> {
    const session = await this.mintAgentSession(profileInput, originKind, createOptions);
    try {
      const transcript = session.db.getTranscriptEntries();
      await this.tm.roster.emitAgents();
      const snapshotStamp = this.tm.roster.reserveSnapshotStamp();
      const agentSummary = await this.tm.sessionStore.summarizeOpenSession(session);
      if (agentSummary == null)
        throw new SlateAgentLifecycleError(
          "Failed to summarize newly created Slate agent.",
        );
      return {
        agent: this.tm.roster.finalizeSummaryForRpc(agentSummary, snapshotStamp),
        transcript,
      };
    } finally {
      await session.agentStore.dispose();
      session.db.close();
    }
  }
  async mintAgentSession(
    profileInput: unknown,
    originKind: string,
    createOptions: CreateOptions,
  ): Promise<any> {
    const session = await this.tm.sessionStore.createSession(
      profileInput,
      originKind,
      createOptions.purpose,
    );
    createOptions.configureAgentDir?.(this.tm.sessionStore.getAgentDir(session.id));
    if (createOptions.isIntroductionSuppressed !== true)
      session.db.setIntroductionPending(true);
    return session;
  }

  async kickstartAgent(agentId: string, isRunReady: boolean): Promise<boolean> {
    let session: any;
    try {
      session =
        this.tm.sessions.activeSession?.id === agentId
          ? this.tm.sessions.activeSession
          : await this.tm.sessions.resolveBackgroundSession(agentId);
    } catch {
      return false;
    }
    if (
      this.tm.groupChat.isGroupSession(session) ||
      this.tm.groupChat.isRemoteRoomSession(session) ||
      !session.db.getIntroductionPending()
    )
      return false;
    if (session.db.getTranscriptEntries().some(isUserMessageEntry)) {
      session.db.setIntroductionPending(false);
      return false;
    }
    if (!isRunReady || !this.tm.execution.canExecute) return false;
    if (this.tm.runLifecycle.inFlightRunCounts.has(session)) return true;
    const agentRunner = this.tm.runnerRegistry.getRunner(session);
    this.tm.runLifecycle.beginSessionRun(session);
    void this.tm.runLifecycle.enqueueExclusiveRun(
      session.id,
      async () => {
        this.tm.turnRuntime.activeRequestSources.set(session.id, "turn");
        try {
          const prompt =
            session.db.getAgentPurpose() === "disk-saver"
              ? SLATE_DISK_SAVER_KICKSTART_PROMPT
              : SLATE_ONBOARDING_KICKSTART_PROMPT;
          const turnResult = await agentRunner.run(prompt, { hidden: true });
          let didDeliver = turnResult.sentMessageCount > 0;
          if (!turnResult.aborted && turnResult.sentMessageCount === 0)
            didDeliver =
              await this.tm.automationRuntime.ensureHiddenTurnReply(agentRunner);
          if (turnResult.quiescedForUpgrade) {
            this.tm.upgradeResume.markAgentResumePending(session, "turn");
            session.db.setIntroductionPending(false);
          } else if (!turnResult.aborted && didDeliver)
            session.db.setIntroductionPending(false);
          await this.tm.roster.emitAgentUpdate(session.id);
        } catch (error) {
          this.tm.telemetry.reportAgentError({
            source: "onboarding_kickstart",
            conversationId: session.id,
            requestId: this.tm.runLifecycle.lastRequestIdBySession.get(
              session.id,
            ),
            error: classifyAgentError(error),
            detail: slateErrorDetail(error),
          });
          this.tm.trayErrors.pushError({
            agentId: session.id,
            title: INTRODUCTION_FAILED_TRAY_TITLE,
            ...describeAgentRunError(error),
            dedupeKey: introductionFailedTrayKey(session.id),
          });
        } finally {
          this.tm.runLifecycle.endSessionRun(session);
        }
      },
      { lane: "user", source: "kickstart" },
    );
    return true;
  }

  async requestDiskSaverAudit(
    agentId: string,
    isRunReady: boolean,
  ): Promise<boolean> {
    let session: any;
    try {
      session =
        this.tm.sessions.activeSession?.id === agentId
          ? this.tm.sessions.activeSession
          : await this.tm.sessions.resolveBackgroundSession(agentId);
    } catch {
      return false;
    }
    if (
      this.tm.groupChat.isGroupSession(session) ||
      this.tm.groupChat.isRemoteRoomSession(session) ||
      session.db.getAgentPurpose() !== "disk-saver"
    )
      return false;
    if (session.db.getIntroductionPending())
      return this.kickstartAgent(agentId, isRunReady);
    if (!isRunReady || !this.tm.execution.canExecute) return false;
    if (this.tm.runLifecycle.inFlightRunCounts.has(session)) return true;
    const agentRunner = this.tm.runnerRegistry.getRunner(session);
    this.tm.runLifecycle.beginSessionRun(session);
    void this.tm.runLifecycle.enqueueExclusiveRun(
      session.id,
      async () => {
        this.tm.turnRuntime.activeRequestSources.set(session.id, "event");
        try {
          const turnResult = await agentRunner.run(SLATE_DISK_SAVER_REAUDIT_PROMPT, {
            hidden: true,
          });
          if (turnResult.quiescedForUpgrade)
            this.tm.upgradeResume.markAgentResumePending(session, "event");
          else if (!turnResult.aborted && turnResult.sentMessageCount === 0)
            await this.tm.automationRuntime.ensureHiddenTurnReply(agentRunner);
          await this.tm.roster.emitAgentUpdate(session.id);
        } catch (error) {
          this.tm.telemetry.reportAgentError({
            source: "disk_saver_reaudit",
            conversationId: session.id,
            requestId: this.tm.runLifecycle.lastRequestIdBySession.get(
              session.id,
            ),
            error: classifyAgentError(error),
            detail: slateErrorDetail(error),
          });
        } finally {
          this.tm.runLifecycle.endSessionRun(session);
        }
      },
      { lane: "background", source: "event" },
    );
    return true;
  }

  async cloneAgent(sourceId: string): Promise<any> {
    const agentSummary = (await this.tm.sessionStore.listAgents()).find(
      (agent: any) => agent.id === sourceId,
    );
    if (agentSummary == null)
      throw new SlateAgentLifecycleError("That agent no longer exists.");
    if (agentSummary.isGroup)
      throw new SlateAgentLifecycleError("Groups can't be duplicated yet.");
    const minted = await this.tm.sessionStore.mintAgent(
      async (agentId: string) => {
        cloneAgentDir(
          this.tm.sessionStore.getAgentDir(sourceId),
          this.tm.sessionStore.getAgentDir(agentId),
          agentId,
          cloneAgentDisplayName(agentSummary.name),
          {
            getAutomationsDir: getAgentAutomationsDir,
            checkpointStore: (dbPath) => {
              checkpointSlateAgentDb(dbPath);
            },
            rewriteIdentity: (targetDir, newAgentId, includesChatHistory) => {
              const db = new SlateAgentDb(join(targetDir, "store.db"));
              try {
                db.set("agentId", newAgentId);
                db.setAgentOrigin("user");
                db.clearAgentPurpose();
                db.clearTransientState();
                if (!includesChatHistory) db.clearConversation();
                const avatarPath = join(targetDir, CANONICAL_AVATAR_FILENAME);
                const existing = db.getSlateProfile();
                db.setSlateProfile({
                  description: existing.description,
                  avatarPath: existsSync(avatarPath) ? avatarPath : null,
                });
              } finally {
                db.close();
              }
            },
          },
        );
        return this.openMintedSession(agentId);
      },
    );
    return this.commitOpenedSession(minted);
  }
  async commitOpenedSession(minted: {
    session: any;
    entries: any[];
    agent: any;
  }): Promise<any> {
    publishTranscriptMutation({
      kind: "agent-needs-reindex",
      agentId: minted.session.id,
    } as unknown as Parameters<typeof publishTranscriptMutation>[0]);
    const outgoing = this.tm.sessions.activeSession;
    const now = Date.now();
    await this.tm.sessions.markSessionLeftBehind(outgoing, now);
    await this.tm.sessionStore.markSessionViewed(minted.session, now);
    this.tm.sessions.invalidateDeferredActivation();
    await this.tm.sessions.replaceSession(minted.session);
    this.tm.sessions.setActiveTranscript(minted.session.id, minted.entries);
    this.tm.sessions.loaded = true;
    this.tm.roster.emit({
      type: "snapshot",
      activeAgentId: minted.session.id,
      entries: minted.entries,
    });
    await this.tm.roster.emitAgents();
    const snapshotStamp = this.tm.roster.reserveSnapshotStamp();
    const refreshed = await this.tm.sessionStore.summarizeOpenSession(
      minted.session,
    );
    return {
      agent: this.tm.roster.finalizeSummaryForRpc(
        refreshed ?? minted.agent,
        snapshotStamp,
      ),
      transcript: getTranscript(),
    };
  }
  async openMintedSession(newId: string): Promise<any> {
    let session: any;
    try {
      session = await this.tm.sessionStore.openSession(newId);
      const transcriptEntries = await this.tm.sessionStore.getTranscriptEntries(session);
      const agent = await this.tm.sessionStore.summarizeOpenSession(session);
      if (agent == null)
        throw new SlateAgentLifecycleError(
          "minted agent could not be summarized",
        );
      return { session, entries: transcriptEntries, agent };
    } catch (error) {
      await this.discardMintedSession(session, newId);
      throw error;
    }
  }
  async discardMintedSession(session: any, newId: string): Promise<void> {
    if (session != null) {
      try {
        await session.agentStore.dispose();
        session.db.close();
      } catch {}
    }
    await this.tm.sessionStore.deleteSession(newId).catch((error: unknown) => {
      console.error(
        `[slate] minted-session discard left ${newId} on disk: ${errorLogTag(error)}`,
      );
    });
  }

  async deleteAgent(agentId: string): Promise<any> {
    return this.tm.deleteAgents([agentId]);
  }
  async deleteAgents(agentIds: readonly string[]): Promise<any> {
    const deletingIds = new Set(agentIds);
    if (deletingIds.size === 0) return { transcript: getTranscript() };
    try {
      return await this.runDeleteAgents(deletingIds);
    } catch (error) {
      for (const id of deletingIds)
        if (this.tm.sessionStore.agentDirExists(id))
          this.tm.sessions.deletedAgentIds.delete(id);
      throw error;
    }
  }
  async runDeleteAgents(deletingIds: ReadonlySet<string>): Promise<any> {
    const activeAgent = await this.tm.sessions.tryEnsureSession();
    const deletingActive = activeAgent != null && deletingIds.has(activeAgent.id);
    for (const id of deletingIds) await this.interruptAgentForDeletion(id);
    for (const id of deletingIds) this.tm.trayErrors.clearForAgent(id);
    for (const id of deletingIds) {
      if (id === activeAgent?.id) continue;
      await this.forgetAgentState(id);
    }
    if (!deletingActive || activeAgent == null) {
      await this.tm.roster.emitAgents();
      return { transcript: getTranscript() };
    }
    await activeAgent.agentStore.dispose();
    await this.forgetAgentState(activeAgent.id, activeAgent);
    const nextAgent = (await this.tm.sessionStore.listAgents(activeAgent.id)).find(
      (agent: any) => !deletingIds.has(agent.id),
    );
    const successorIds = [
      ...(nextAgent == null ? [] : [nextAgent.id]),
      ...(await this.tm.sessionStore.listAgentRecordIds()).filter(
        (id: string) => !deletingIds.has(id) && id !== nextAgent?.id,
      ),
    ];
    for (const successorId of successorIds) {
      let nextSession: any;
      try {
        nextSession =
          this.tm.sessions.liveSessions.get(successorId) ??
          (await this.tm.sessions.openSessionOnce(successorId));
      } catch (error) {
        console.error(
          `[slate] skipping unopenable agent ${successorId} after delete: ${errorLogTag(error)}`,
        );
        continue;
      }
      const transcriptEntries = await this.tm.sessionStore.getTranscriptEntries(nextSession);
      await this.activateSession(nextSession, transcriptEntries);
      return { transcript: transcriptEntries };
    }
    try {
      const incoming = await this.tm.sessionStore.createFallbackSession(
        (id: string) => this.tm.sessions.openSessionOnce(id),
      );
      await this.tm.sessionStore.markSessionViewed(incoming);
      this.tm.sessions.invalidateDeferredActivation();
      this.tm.sessions.setActiveSession(incoming);
      this.tm.runLifecycle.watchActiveSession(incoming);
      this.tm.sessions.clearActiveTranscript(incoming.id);
      this.tm.sessions.loaded = true;
      this.tm.roster.emit({ type: "cleared" });
      await this.tm.roster.emitAgents();
      return { transcript: getTranscript() };
    } catch (error) {
      if (!isSlateAgentLimitError(error)) throw error;
      this.tm.sessions.activeSession = undefined;
      this.tm.unwatchActiveSession();
      this.tm.sessions.clearActiveTranscript(null);
      this.tm.sessions.loaded = false;
      this.tm.roster.emit({ type: "cleared" });
      await this.tm.roster.emitAgents();
      return { transcript: getTranscript() };
    }
  }


  /** Forgets every runtime reference to an agent: its runners, live sessions, wakes and handoffs. */
  private async forgetAgentState(agentId: string, closeWhenIdle?: any): Promise<void> {
    this.tm.runnerRegistry.runners.delete(agentId);
    this.tm.sessions.liveSessions.delete(agentId);
    this.tm.sessions.pendingSessionOpens.delete(agentId);
    if (closeWhenIdle != null) this.tm.runLifecycle.closeSessionWhenIdle(closeWhenIdle);
    await this.tm.sessionStore.deleteSession(agentId);
    this.tm.onAgentForgotten?.(agentId);
    this.tm.pendingWakeStore?.clearAgent(agentId);
    this.tm.boxHandoff.boxHandoffs.delete(agentId);
    this.tm.boxHandoff.awaitingSink.clear(agentId);
    this.tm.roster.emitAsyncTasksForAgent(agentId);
  }

  /** Puts a session in front of the user: viewed, active, watched and its transcript shown. */
  private async activateSession(targetSession: any, entries: any[]): Promise<void> {
    await this.tm.sessionStore.markSessionViewed(targetSession);
    this.tm.sessions.invalidateDeferredActivation();
    this.tm.sessions.setActiveSession(targetSession);
    this.tm.runLifecycle.watchActiveSession(targetSession);
    this.tm.sessions.setActiveTranscript(targetSession.id, entries);
    this.tm.sessions.loaded = true;
    this.tm.roster.emit({
      type: "snapshot",
      activeAgentId: targetSession.id,
      entries,
    });
    await this.tm.roster.emitAgents();
  }

  /** The summary answer a profile change hands back. */
  private answerProfile(agentSummary: any, snapshotStamp: number): unknown {
    return agentSummary == null ? null : this.tm.roster.finalizeSummaryForRpc(agentSummary, snapshotStamp);
  }

  async interruptAgentForDeletion(agentId: string): Promise<void> {
    this.tm.sessions.deletedAgentIds.add(agentId);
    this.tm.ackObligations.markAckObligationLost(agentId, "agent_deleted");
    this.tm.ackObligations.ackRunTokens.delete(agentId);
    for (const queue of [
      this.tm.backgroundWakes.pendingSubagentCompletions,
      this.tm.backgroundWakes.pendingShellCompletions,
      this.tm.backgroundWakes.pendingInbound,
      this.tm.backgroundWakes.pendingAgentInbound,
      this.tm.backgroundWakes.pendingChannelFailures,
    ])
      queue.delete(agentId);
    this.tm.groupChat.dmPreemptedGroupMemberIds.delete(agentId);
    this.tm.backgroundWakes.dmPreemptedWakeAgentIds.delete(agentId);
    this.tm.roster.forgetAgentSubagentWork(agentId);
    this.tm.roster.lastRunnerAsyncTasks.delete(agentId);
    const groupMemberRunner =
      this.tm.runnerRegistry.activeGroupMemberRunners.get(agentId);
    const agentRunner = this.tm.runnerRegistry.runners.get(agentId);
    if (agentRunner != null || groupMemberRunner != null) {
      const wasInFlight = this.tm.runLifecycle.runningAgentIds().has(agentId);
      const hadGroup = groupMemberRunner?.interruptAll("agent deleted") ?? false;
      const hadActiveRun =
        (agentRunner?.interruptAll("agent deleted") ?? false) || hadGroup;
      this.tm.telemetry.reportTurnInterrupt({
        conversationId: agentId,
        reason: "agent_deleted",
        hadActiveRun,
        wasInFlight,
      });
      agentRunner?.cancelBackgroundShellRewatches();
      groupMemberRunner?.cancelBackgroundShellRewatches();
    }
    await this.tm.runLifecycle.drainExclusiveRuns(agentId);
    await agentRunner?.drainBackgroundSubagents();
    await groupMemberRunner?.drainBackgroundSubagents();
  }

  async updateAgent(agentId: string, profileInput: any): Promise<unknown> {
    const trimmedProfile = {
      ...(profileInput.avatarShape === undefined
        ? {}
        : { avatarShape: profileInput.avatarShape.trim() }),
      ...(profileInput.avatarColor === undefined
        ? {}
        : { avatarColor: profileInput.avatarColor.trim() }),
      name: profileInput.name.trim(),
      description: profileInput.description.trim(),
      ...(profileInput.title === undefined ? {} : { title: profileInput.title.trim() }),
    };
    const snapshotStamp = this.tm.roster.reserveSnapshotStamp();
    const activeAgent = this.tm.sessions.activeSession;
    const agentSummary =
      activeAgent?.id === agentId
        ? (this.tm.sessionStore.writeAgentProfileFile(agentId, trimmedProfile),
          await this.tm.sessionStore.summarizeOpenSession(activeAgent))
        : await this.tm.sessionStore.updateAgentProfile(agentId, trimmedProfile);
    await this.tm.roster.emitAgentUpdate(agentId);
    this.tm.roster.emitProfileChanged(agentId);
    return this.answerProfile(agentSummary, snapshotStamp);
  }
  async setAgentUnread(
    agentId: string,
    isUnread: boolean,
    atMs?: number,
  ): Promise<void> {
    const activeAgent = this.tm.sessions.activeSession;
    if (activeAgent?.id === agentId) {
      if (isUnread) {
        await this.tm.sessionStore.seedSessionActivityFromDbMtime(activeAgent);
        activeAgent.db.markUnread(atMs);
      } else activeAgent.db.markRead();
    } else await this.tm.sessionStore.setSessionUnread(agentId, isUnread, atMs);
    await this.tm.roster.emitAgentUpdate(agentId);
  }
  async setAgentNotifyOnUpdates(
    agentId: string,
    enabled: boolean,
  ): Promise<void> {
    this.tm.sessionStore.setSessionNotifyOnUpdates(agentId, enabled);
    await this.tm.roster.emitAgentUpdate(agentId);
  }
  async setAgentHiddenFromSidebar(
    agentId: string,
    hidden: boolean,
  ): Promise<void> {
    this.tm.sessionStore.setSessionHiddenFromSidebar(agentId, hidden);
    await this.tm.roster.emitAgentUpdate(agentId);
  }
  async setAgentAvatarBytes(
    agentId: string,
    avatarBytes: Uint8Array,
  ): Promise<unknown> {
    const activeAgent = this.tm.sessions.activeSession,
      snapshotStamp = this.tm.roster.reserveSnapshotStamp();
    const agentSummary =
      activeAgent?.id === agentId
        ? await this.tm.sessionStore.setAgentAvatarBytes(
            activeAgent.db,
            activeAgent.dbPath,
            agentId,
            avatarBytes,
            agentId,
          )
        : await this.tm.sessionStore.setAgentAvatarBytesById(agentId, avatarBytes);
    await this.tm.roster.emitAgentUpdate(agentId);
    this.tm.roster.emitProfileChanged(agentId);
    return this.answerProfile(agentSummary, snapshotStamp);
  }
  getAgentAvatar(agentId: string): Promise<unknown> {
    return this.tm.sessionStore.getAgentAvatar(agentId);
  }
}
