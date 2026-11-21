/** A group chat, as the conversation machinery sees it.

 * A group is an agent whose directory says it is one; the glue creates and reconfigures those, tells a room turn how to
 * reach its members and what they have said, runs each groupMember's turn with its own persona and stream, and answers for the
 * members that stream on someone else's host. */
import { existsSync } from "node:fs";
import { dirname } from "node:path";

import { SLATE_DEFAULT_AGENT_NAME } from "../../shared/agents/agents.ts";
import {
  formatRemoteAgentId,
  isRemoteAgentId,
} from "../../shared/agents/sharing.ts";
import { isMessageAddress } from "../../shared/message-reference.ts";
import { isSilentBotReply } from "../../shared/bot-delivery-text.ts";
import {
  readSlateProfileFile,
  getSlateProfilePath,
} from "../agents/agent-profile.ts";
import {
  GROUP_CONFIG_VERSION,
  GROUP_MAX_MEMBERS,
  readSlateGroupConfig,
  writeSlateGroupConfig,
  isSlateGroupDir,
  type RemoteGroupMember,
} from "../groups/group-store.ts";
import {
  assertMembersAreNotGroups,
  buildGroupRedriveNote,
  isPassContent,
  isSameMemberSet,
  SHARED_ROOM_HISTORY_LIMIT,
  type GroupDescription,
  type GroupMember,
  type GroupMessage,
} from "../groups/group-chat.ts";
import { isSlateRemoteRoomDir } from "../groups/remote-room-store.ts";
import { buildSharedRoomGuardrails } from "../groups/xuser.ts";
import { createGroupMemberActivityTracker } from "../slate-activity.ts";
import {
  beginTurnTrace,
  markTurnTraceError,
  resolveTurnTraceOutcome,
  resolveTurnTraceType,
  setTurnTraceAttributes,
} from "../send-trace-host.ts";
import {
  GroupChatOrchestrator,
  type GroupOrchestratorDeps,
} from "./group-chat-orchestrator.ts";
import { describeAgentRunError } from "./agent-run-error.ts";
import { AgentGoneError } from "./session-runtime.ts";
import { allocateTranscriptEntryId } from "./transcript-entry-ids.ts";
import { getTranscript } from "./transcript-store.ts";
import type {
  TranscriptEntry,
  TranscriptManagerLike,
} from "./transcript-hub.ts";

export class SlateGroupCreateError extends Error {}

type LiveSession = any;

export class GroupChatGlue {
  readonly dmPreemptedGroupMemberIds = new Set<string>();
  readonly remoteTurnMemberIdsByRoom = new Map<string, string>();

  constructor(readonly tm: TranscriptManagerLike) {}


  /** A session's transcriptEntries, read from the open transcript or from its own database. */
  private entriesFor(session: LiveSession, isActive?: boolean): TranscriptEntry[] {
    const onScreen = isActive ?? this.tm.sessions.activeSession?.id === session.id;
    return onScreen ? getTranscript() : session.db.getTranscriptEntries();
  }

  /** Writes a group message into the room the user sees, or into the room's own session. */
  private writeGroupEntry(
    session: LiveSession,
    transcriptEntry: TranscriptEntry,
    isActive?: boolean,
  ): void {
    const onScreen = isActive ?? this.tm.sessions.activeSession?.id === session.id;
    if (onScreen) {
      this.tm.appendEntry(transcriptEntry);
      return;
    }
    if (!session.db.appendTranscriptEntry(transcriptEntry)) return;
    this.tm.roster.emit({ type: "appended", entry: transcriptEntry }, session.id);
    this.tm.sessionStore.markSessionActivity(session);
    void this.tm.roster.emitAgentUpdate(session.id);
  }

  async pinMemberSessionForGroupTurn(memberId: string): Promise<LiveSession> {
    if (this.tm.sessions.isAgentGone(memberId))
      throw new AgentGoneError(memberId);
    const stream = this.tm.sessions.liveSessions.get(memberId);
    const session = stream ?? (await this.tm.sessions.openSessionOnce(memberId));
    this.tm.runLifecycle.beginSessionRun(session, { isGroupMemberTurn: true });
    return session;
  }

  async createGroup(turnRequest: {
    name: string;
    description?: string;
    memberIds: string[];
    externalId?: string;
  }): Promise<any> {
    const allAgents = await this.tm.sessionStore.listAgents();
    const existing = new Set<string>(allAgents.map((agent: any) => agent.id));
    const groupIds = new Set<string>(
      allAgents
        .filter((agent: any) => agent.isGroup)
        .map((agent: any) => agent.id),
    );
    const requested = [...new Set(turnRequest.memberIds)];
    const externalId = turnRequest.externalId?.trim() || undefined;
    assertMembersAreNotGroups(requested, (id) => groupIds.has(id));
    const memberIds = requested
      .filter((id) => existing.has(id))
      .slice(0, GROUP_MAX_MEMBERS);
    if (memberIds.length === 0) {
      throw new SlateGroupCreateError(
        "A group needs at least one existing member agent.",
      );
    }
    if (externalId !== undefined && memberIds.length !== requested.length) {
      throw new SlateGroupCreateError("One or more requested group members are unavailable.");
    }

    const duplicate = externalId == null
      ? allAgents.find(
          (agent: any) =>
            agent.isGroup && isSameMemberSet(agent.memberIds, memberIds),
        )
      : allAgents.find(
          (agent: any) =>
            agent.isGroup &&
            readSlateGroupConfig(this.tm.sessionStore.getAgentDir(agent.id))?.externalId === externalId,
        );
    if (duplicate != null) {
      const transcript = externalId === undefined
        ? await this.tm.switchAgent(duplicate.id)
        : await this.tm.sessions.getAgentTranscript(duplicate.id);
      const stamp = this.tm.roster.reserveSnapshotStamp();
      const summary =
        (await this.tm.sessionStore.listAgents(duplicate.id)).find(
          (agent: any) => agent.id === duplicate.id,
        ) ?? duplicate;
      return {
        agent: this.tm.roster.finalizeSummaryForRpc(summary, stamp),
        transcript,
      };
    }

    const profile = { name: turnRequest.name, description: turnRequest.description ?? "" };
    if (externalId !== undefined) {
      return await this.tm.createBackgroundAgent(profile, "user", {
        isIntroductionSuppressed: true,
        configureAgentDir: (dir: string) => writeSlateGroupConfig(dir, { version: GROUP_CONFIG_VERSION, memberIds, externalId }),
      });
    }
    const created = await this.tm.createAgent(profile, "user");
    writeSlateGroupConfig(this.tm.sessionStore.getAgentDir(created.agent.id), {
      version: GROUP_CONFIG_VERSION,
      memberIds,
    });
    this.tm.productAnalytics.trackEvent("slate.group.created", {
      group_id: created.agent.id,
      member_count: memberIds.length,
    });
    await this.tm.roster.emitAgents();
    const stamp = this.tm.roster.reserveSnapshotStamp();
    const refreshed = (
      await this.tm.sessionStore.listAgents(created.agent.id)
    ).find((agent: any) => agent.id === created.agent.id);
    return {
      agent:
        refreshed == null
          ? created.agent
          : this.tm.roster.finalizeSummaryForRpc(refreshed, stamp),
      transcript: created.transcript,
    };
  }

  async setGroupMembers(
    groupId: string,
    memberIds: readonly string[],
  ): Promise<any | null> {
    const dir = this.tm.sessionStore.getAgentDir(groupId);
    const current = readSlateGroupConfig(dir);
    if (current == null) return null;
    if (current.sharedRoomId != null)
      return this.currentStampedSummary(groupId);

    const allAgents = await this.tm.sessionStore.listAgents();
    const existing = new Set<string>(allAgents.map((agent: any) => agent.id));
    const groupIds = new Set<string>(
      allAgents
        .filter((agent: any) => agent.isGroup)
        .map((agent: any) => agent.id),
    );
    const requested = [...new Set(memberIds)];
    assertMembersAreNotGroups(requested, (id) => groupIds.has(id));
    const cleaned = requested
      .filter((id) => id !== groupId && existing.has(id))
      .slice(0, GROUP_MAX_MEMBERS);
    if (current.externalId !== undefined && cleaned.length !== requested.length) {
      throw new SlateGroupCreateError("One or more requested group members are unavailable.");
    }
    if (cleaned.length > 0) {
      writeSlateGroupConfig(dir, {
        version: GROUP_CONFIG_VERSION,
        memberIds: cleaned,
        ...(current.remoteMembers === undefined ? {} : { remoteMembers: current.remoteMembers }),
        ...(current.externalId === undefined ? {} : { externalId: current.externalId }),
      });
      await this.tm.roster.emitAgents();
    }
    return this.currentStampedSummary(groupId);
  }

  private async currentStampedSummary(groupId: string): Promise<any | null> {
    const stamp = this.tm.roster.reserveSnapshotStamp();
    const summary = (await this.tm.sessionStore.listAgents(groupId)).find(
      (agent: any) => agent.id === groupId,
    );
    return summary == null
      ? null
      : this.tm.roster.finalizeSummaryForRpc(summary, stamp);
  }

  isGroupSession(session: LiveSession): boolean {
    return isSlateGroupDir(dirname(session.dbPath));
  }

  isGroupAgentId(agentId: string): boolean {
    return isSlateGroupDir(this.tm.sessionStore.getAgentDir(agentId));
  }

  isRemoteRoomSession(session: LiveSession): boolean {
    return isSlateRemoteRoomDir(dirname(session.dbPath));
  }

  isRemoteRoomAgentId(agentId: string): boolean {
    return isSlateRemoteRoomDir(this.tm.sessionStore.getAgentDir(agentId));
  }

  groupIdentityFor(session: LiveSession): GroupDescription {
    const profile = this.tm.roster.resolveAgentProfile(session);
    return { name: profile.name, description: profile.description };
  }

  async runGroupTurn(
    session: LiveSession,
    epoch: number,
    traceCtx?: unknown,
    lane = "background",
    userMessageId?: string,
  ): Promise<void> {
    // A group turn is one lifecycle even though it runs several member turns.
    // The Bot surface uses these frames to hold its pending state until the
    // whole group has settled, without polling member run state.
    const emitTurn = (phase: "started" | "ended", ok?: boolean) => {
      this.tm.roster.emit(
        {
          type: "group-turn",
          phase,
          epoch,
          timestampMs: Date.now(),
          ...(ok === undefined ? {} : { ok }),
        },
        session.id,
      );
    };
    let started = false;
    try {
      // Emit the lifecycle before reading the group config: a stream that
      // accepted a group prompt must receive a matching end even when the
      // group identity is no longer readable.
      emitTurn("started");
      started = true;
      const roomConfig = readSlateGroupConfig(dirname(session.dbPath));
      if (roomConfig == null) {
        emitTurn("ended", false);
        return;
      }
      const groupOrchestrator = new GroupChatOrchestrator(
        this.groupOrchestratorDeps(session, epoch, traceCtx, lane, undefined, userMessageId),
      );
      await groupOrchestrator.run({
        group: this.groupIdentityFor(session),
        memberIds: [
          ...roomConfig.memberIds,
          ...(roomConfig.remoteMembers ?? []).map(formatRemoteAgentId),
        ],
      });
      await this.tm.roster.emitAgentUpdate(session.id);
      emitTurn("ended", true);
    } catch (error) {
      this.tm.trayErrors.pushError({
        agentId: session.id,
        title: "Group chat failed",
        ...describeAgentRunError(error),
      });
      await this.tm.roster.emitAgentUpdate(session.id);
      emitTurn("ended", false);
    } finally {
      if (!started) emitTurn("ended", false);
      this.tm.runLifecycle.endSessionRun(session);
    }
  }

  groupOrchestratorDeps(
    session: LiveSession,
    epoch: number,
    traceCtx?: unknown,
    lane = "background",
    requestSource?: string,
    userMessageId?: string,
  ): GroupOrchestratorDeps {
    const roomConfig = readSlateGroupConfig(dirname(session.dbPath));
    const remoteMembers = roomConfig?.remoteMembers ?? [];
    const anchor = userMessageId === undefined ? undefined : this.entriesFor(session).find(entry => entry.id === userMessageId);
    const replyTo = typeof anchor?.replyTo === 'string' ? anchor.id : undefined;
    return {
      isSharedRoom: roomConfig?.sharedRoomId != null,
      resolveMembers: (ids) => this.resolveGroupMembers(ids, remoteMembers),
      readHistory: () => {
        const history = this.readGroupHistory(session);
        const anchorIndex = userMessageId === undefined ? -1 : history.findIndex(entry => entry.id === userMessageId);
        return anchorIndex === -1 ? history : history.filter((entry, index) => index <= anchorIndex || entry.speaker.kind !== 'user');
      },
      runMemberTurn: async (turnRequest) => {
        const { member } = turnRequest;
        const progress = (phase: 'reading' | 'working' | 'speaking' | 'idle') =>
          this.tm.roster.emit({ type: 'group-member', epoch, phase, member: { id: member.id, name: member.name } }, session.id);
        progress('reading');
        try {
          return await this.runGroupMemberTurn(session, turnRequest,
            () => this.tm.sendPipeline.currentTurnEpoch(session) === epoch,
            traceCtx, lane, requestSource, progress);
        } finally {
          progress('idle');
        }
      },
      postMemberMessage: (member, content) => this.postGroupMemberMessage(session, member, content, replyTo),
      isCurrent: () => this.tm.sendPipeline.currentTurnEpoch(session) === epoch,
    };
  }

  async resolveGroupMembers(
    memberIds: readonly string[],
    remoteMembers: readonly RemoteGroupMember[] = [],
  ): Promise<GroupMember[]> {
    const members: GroupMember[] = [];
    for (const id of memberIds) {
      if (isRemoteAgentId(id)) {
        const remote = remoteMembers.find(
          (candidate) => formatRemoteAgentId(candidate) === id,
        );
        if (remote != null)
          members.push({ id, name: remote.name, description: "" });
        continue;
      }
      const dir = this.tm.sessionStore.getAgentDir(id);
      if (!existsSync(dir)) continue;
      if (isSlateGroupDir(dir)) {
        console.warn(
          `Slate group: ignoring nested group member ${id}; a group chat cannot be a member of another group.`,
        );
        continue;
      }
      const profile = readSlateProfileFile(getSlateProfilePath(dir));
      members.push({
        id,
        name: profile?.name.trim() || SLATE_DEFAULT_AGENT_NAME,
        description: profile?.description ?? "",
      });
    }
    return members;
  }

  async runGroupMemberTurn(
    groupRoom: LiveSession,
    turnRequest: { member: GroupMember; systemPrompt: string; prompt: string },
    isRoomTurnCurrent: () => boolean,
    traceCtx?: unknown,
    lane = "background",
    requestSource?: string,
    progress?: (phase: 'working' | 'speaking') => void,
  ): Promise<string[]> {
    if (isRemoteAgentId(turnRequest.member.id)) {
      return this.runRemoteGroupMemberTurn(groupRoom, turnRequest.member);
    }
    if (!this.tm.execution.canExecuteGroupMember) return [];

    let effective = turnRequest;
    if (this.tm.sharedRooms.sharedRoomConfigOf(groupRoom) != null) {
      effective = {
        ...turnRequest,
        systemPrompt:
          turnRequest.systemPrompt +
          buildSharedRoomGuardrails({
            hostName: "",
            isForeignHost: false,
          }),
      };
    }

    let memberRoom: LiveSession;
    try {
      memberRoom = await this.pinMemberSessionForGroupTurn(
        effective.member.id,
      );
    } catch {
      return [];
    }
    const sentMessages: string[] = [];
    const requiresBotRuntime = readSlateGroupConfig(dirname(groupRoom.dbPath))?.externalId != null;
    let lastReactionApplied = false;
    let trackActivity = createGroupMemberActivityTracker();
    const memberTransport = {
      onUpdate: (update: any) => {
        this.tm.runLifecycle.applyActivityTransition(
          memberRoom.id,
          trackActivity(update),
        );
        if (!isRoomTurnCurrent()) return;
        if (update.type === "react-to-message") {
          lastReactionApplied = this.applyGroupMemberReaction(
            groupRoom,
            effective.member,
            update,
          );
          return;
        }
        if (update.type === 'tool-call' && update.status === 'pending') progress?.('working');
        if (update.type === "send-message" && update.message?.type === "text" && typeof update.message.content === 'string'
          && !isPassContent(update.message.content) && !isSilentBotReply(update.message.content)) {
          sentMessages.push(update.message.content);
          progress?.('speaking');
        }
      },
      lastReactionApplied: () => lastReactionApplied,
    };

    for (let tryNumber = 1; tryNumber <= 3; tryNumber += 1) {
      lastReactionApplied = false;
      trackActivity = createGroupMemberActivityTracker();
      const prompt =
        tryNumber === 1
          ? effective.prompt
          : `${effective.prompt}${buildGroupRedriveNote()}`;
      await this.tm.runLifecycle.enqueueExclusiveRun(
        memberRoom.id,
        async () => {
          this.tm.turnRuntime.activeRequestSources.set(
            memberRoom.id,
            requestSource ?? "turn",
          );
          let registeredRunner: any;
          try {
            if (tryNumber > 1 && !isRoomTurnCurrent()) return;
            registeredRunner = this.tm.execution.createGroupMemberRunner(
              memberRoom,
              this.tm.runnerRegistry.runnerHooksFor(memberRoom, memberTransport),
              {
                systemPrompt: effective.systemPrompt,
                ...(requiresBotRuntime ? { requiresBotRuntime: true } : {}),
                isSharedRoomTurn:
                  this.tm.sharedRooms.sharedRoomConfigOf(groupRoom) != null,
              },
            );
            this.tm.runnerRegistry.activeGroupMemberRunners.set(
              memberRoom.id,
              registeredRunner,
            );
            this.tm.runnerRegistry.wireRunnerLifecycle(
              registeredRunner,
              memberRoom,
              groupRoom.id,
            );
            const memberTurnTrace = beginTurnTrace({
              parentCtx: traceCtx,
              conversationId: groupRoom.id,
              turnType: resolveTurnTraceType(
                requestSource == null ? {} : { requestSource },
              ),
              attributes: {
                "slate.is_group_member": true,
                "slate.member_conversation_id": memberRoom.id,
                ...(tryNumber > 1 ? { "slate.tryNumber": tryNumber } : {}),
              },
            });
            try {
              const memberResult = await registeredRunner.run(prompt, {
                traceCtx: memberTurnTrace?.context ?? traceCtx,
                requestSource,
              });
              setTurnTraceAttributes(memberTurnTrace, {
                "slate.outcome": resolveTurnTraceOutcome(memberResult),
              });
            } catch (error) {
              markTurnTraceError(memberTurnTrace, error);
              throw error;
            } finally {
              try {
                memberTurnTrace?.span.end();
              } catch {}
            }
          } catch {
            // A failed groupMember turn is a pass, not a room-wide failure.
          } finally {
            if (
              this.tm.runnerRegistry.activeGroupMemberRunners.get(
                memberRoom.id,
              ) === registeredRunner
            ) {
              this.tm.runnerRegistry.activeGroupMemberRunners.delete(
                memberRoom.id,
              );
            }
            this.tm.runLifecycle.endSessionRun(memberRoom);
          }
        },
        { lane, source: "group-member" },
      );

      const wasPreempted = this.dmPreemptedGroupMemberIds.delete(memberRoom.id);
      if (
        !wasPreempted ||
        sentMessages.length > 0 ||
        lastReactionApplied ||
        tryNumber >= 3 ||
        !isRoomTurnCurrent()
      ) {
        break;
      }
      try {
        memberRoom = await this.pinMemberSessionForGroupTurn(
          effective.member.id,
        );
      } catch {
        break;
      }
    }
    return sentMessages;
  }

  async runRemoteGroupMemberTurn(
    groupRoom: LiveSession,
    groupMember: GroupMember,
  ): Promise<string[]> {
    const xuserDelegate = this.tm.xuserDelegate;
    if (xuserDelegate == null || !xuserDelegate.isEnabled()) return [];
    const roomConfig = this.tm.sharedRooms.sharedRoomConfigOf(groupRoom);
    if (roomConfig?.sharedRoomId == null) return [];
    const ids = [
      ...roomConfig.memberIds,
      ...(roomConfig.remoteMembers ?? []).map(formatRemoteAgentId),
    ];
    const members = await this.resolveGroupMembers(
      ids,
      roomConfig.remoteMembers ?? [],
    );
    this.setRemoteTurnMember(groupRoom.id, groupMember.id);
    try {
      return await xuserDelegate.runRemoteMemberTurn({
        sharedRoomId: roomConfig.sharedRoomId,
        member: groupMember,
        group: this.groupIdentityFor(groupRoom),
        peers: members.filter((other) => other.id !== groupMember.id),
        newMessages: this.readGroupHistory(groupRoom).slice(
          -SHARED_ROOM_HISTORY_LIMIT,
        ),
      });
    } catch {
      return [];
    } finally {
      this.setRemoteTurnMember(groupRoom.id);
    }
  }

  setRemoteTurnMember(roomId: string, memberId?: string): void {
    if (this.remoteTurnMemberIdsByRoom.get(roomId) === memberId) return;
    if (memberId == null) this.remoteTurnMemberIdsByRoom.delete(roomId);
    else this.remoteTurnMemberIdsByRoom.set(roomId, memberId);
    void this.tm.roster.emitAgentUpdate(roomId);
  }

  applyGroupMemberReaction(
    groupRoom: LiveSession,
    groupMember: GroupMember,
    update: any,
  ): boolean {
    const reactionEmoji = String(update.emoji ?? "").trim();
    if (reactionEmoji.length === 0 || !isMessageAddress(update.messageAddress))
      return false;
    const transcriptEntries = this.entriesFor(groupRoom);
    const target = transcriptEntries.find(
      (transcriptEntry: TranscriptEntry) => transcriptEntry.id === update.messageAddress,
    );
    if (target == null) return false;
    if (
      target.kind === "send-message" &&
      (target.author as any)?.id === groupMember.id
    )
      return false;
    return (
      this.tm.widgetResponses.applyReaction({
        session: groupRoom,
        entryId: update.messageAddress,
        emoji: reactionEmoji,
        by: groupMember.id,
      }) != null
    );
  }

  postGroupMemberMessage(session: LiveSession, groupMember: GroupMember, content: string, replyTo?: string): void {
    if (isPassContent(content) || isSilentBotReply(content)) return;
    const transcriptEntry: TranscriptEntry = {
      kind: "send-message",
      id: allocateTranscriptEntryId(this.entriesFor(session), "send-message"),
      message: { type: "text", content },
      timestampMs: Date.now(),
      author: { id: groupMember.id, name: groupMember.name },
      ...(replyTo ? { replyTo } : {}),
    };
    this.writeGroupEntry(session, transcriptEntry);
    this.tm.sharedRooms.publishSharedRoomEntryIfNeeded(session, transcriptEntry);
  }

  readGroupHistory(session: LiveSession): GroupMessage[] {
    const transcriptEntries = this.entriesFor(session);
    const messages: GroupMessage[] = [];
    const authorByEntry = new Map(transcriptEntries.flatMap((entry) => {
      const author = entry.author as { id?: unknown } | undefined;
      return typeof author?.id === 'string' && entry.kind === 'send-message' && entry.streaming !== true
        ? [[entry.id, author.id] as const] : [];
    }));
    for (const transcriptEntry of transcriptEntries) {
      if (
        transcriptEntry.kind === "message" &&
        transcriptEntry.role === "user" &&
        String(transcriptEntry.content ?? "").trim()
      ) {
        const name = (transcriptEntry.fromUser as any)?.name;
        const replyToMemberId = typeof transcriptEntry.replyTo === 'string' ? authorByEntry.get(transcriptEntry.replyTo) : undefined;
        messages.push({
          id: transcriptEntry.id,
          ...(replyToMemberId ? { replyToMemberId } : {}),
          speaker: name == null ? { kind: "user" } : { kind: "user", name },
          content: String(transcriptEntry.content),
        });
      } else if (
        transcriptEntry.kind === "send-message" &&
        (transcriptEntry.message as any)?.type === "text" &&
        transcriptEntry.author != null &&
        transcriptEntry.streaming !== true &&
        typeof (transcriptEntry.message as any).content === "string" &&
        !isSilentBotReply((transcriptEntry.message as any).content)
      ) {
        messages.push({
          id: transcriptEntry.id,
          speaker: {
            kind: "member",
            id: (transcriptEntry.author as any).id,
            name: (transcriptEntry.author as any).name,
          },
          content: (transcriptEntry.message as any).content,
        });
      }
    }
    return messages;
  }
}
