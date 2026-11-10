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
  isPotentialPassPrefix,
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
import {
  appendEntry,
  getTranscript,
  removeEntry,
  updateEntry,
} from "./transcript-store.ts";
import type {
  TranscriptEntry,
  TranscriptManagerLike,
} from "./transcript-hub.ts";

export class SlateGroupCreateError extends Error {}

export interface GroupMemberStream {
  currentId: string | undefined;
  currentText: string;
  sealed: string[];
}

export function createGroupMemberStream(): GroupMemberStream {
  return { currentId: undefined, currentText: "", sealed: [] };
}

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
    session.db.appendTranscriptEntry(transcriptEntry);
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
  }): Promise<any> {
    const allAgents = await this.tm.sessionStore.listAgents();
    const existing = new Set<string>(allAgents.map((agent: any) => agent.id));
    const groupIds = new Set<string>(
      allAgents
        .filter((agent: any) => agent.isGroup)
        .map((agent: any) => agent.id),
    );
    const requested = [...new Set(turnRequest.memberIds)];
    assertMembersAreNotGroups(requested, (id) => groupIds.has(id));
    const memberIds = requested
      .filter((id) => existing.has(id))
      .slice(0, GROUP_MAX_MEMBERS);
    if (memberIds.length === 0) {
      throw new SlateGroupCreateError(
        "A group needs at least one existing member agent.",
      );
    }

    const duplicate = allAgents.find(
      (agent: any) =>
        agent.isGroup && isSameMemberSet(agent.memberIds, memberIds),
    );
    if (duplicate != null) {
      const transcript = await this.tm.switchAgent(duplicate.id);
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

    const created = await this.tm.createAgent(
      { name: turnRequest.name, description: turnRequest.description ?? "" },
      "user",
    );
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
    if (cleaned.length > 0) {
      writeSlateGroupConfig(dir, {
        version: GROUP_CONFIG_VERSION,
        memberIds: cleaned,
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
  ): Promise<void> {
    try {
      const roomConfig = readSlateGroupConfig(dirname(session.dbPath));
      if (roomConfig == null) return;
      const groupOrchestrator = new GroupChatOrchestrator(
        this.groupOrchestratorDeps(session, epoch, traceCtx, lane),
      );
      await groupOrchestrator.run({
        group: this.groupIdentityFor(session),
        memberIds: [
          ...roomConfig.memberIds,
          ...(roomConfig.remoteMembers ?? []).map(formatRemoteAgentId),
        ],
      });
      await this.tm.roster.emitAgentUpdate(session.id);
    } catch (error) {
      this.tm.trayErrors.pushError({
        agentId: session.id,
        title: "Group chat failed",
        ...describeAgentRunError(error),
      });
      await this.tm.roster.emitAgentUpdate(session.id);
    } finally {
      this.tm.runLifecycle.endSessionRun(session);
    }
  }

  groupOrchestratorDeps(
    session: LiveSession,
    epoch: number,
    traceCtx?: unknown,
    lane = "background",
    requestSource?: string,
  ): GroupOrchestratorDeps {
    const stream = createGroupMemberStream();
    const roomConfig = readSlateGroupConfig(dirname(session.dbPath));
    const remoteMembers = roomConfig?.remoteMembers ?? [];
    return {
      isSharedRoom: roomConfig?.sharedRoomId != null,
      resolveMembers: (ids) => this.resolveGroupMembers(ids, remoteMembers),
      readHistory: () => this.readGroupHistory(session),
      runMemberTurn: (turnRequest) =>
        this.runGroupMemberTurn(
          session,
          turnRequest,
          stream,
          () => this.tm.sendPipeline.currentTurnEpoch(session) === epoch,
          traceCtx,
          lane,
          requestSource,
        ),
      postMemberMessage: (groupMember, content) => {
        this.postGroupMemberMessage(session, groupMember, content, stream);
      },
      finalizeMemberTurn: () => this.finalizeGroupMemberStream(session, stream),
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
    stream: GroupMemberStream,
    isRoomTurnCurrent: () => boolean,
    traceCtx?: unknown,
    lane = "background",
    requestSource?: string,
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
    let lastReactionApplied = false;
    let trackActivity = createGroupMemberActivityTracker();
    const memberTransport = {
      onUpdate: (update: any) => {
        this.tm.runLifecycle.applyActivityTransition(
          memberRoom.id,
          trackActivity(update),
        );
        if (update.type === "react-to-message") {
          lastReactionApplied = this.applyGroupMemberReaction(
            groupRoom,
            effective.member,
            update,
          );
          return;
        }
        if (update.type === "send-message" && update.message?.type === "text") {
          sentMessages.push(update.message.content);
        }
        this.streamGroupMemberUpdate(
          groupRoom,
          effective.member,
          update,
          stream,
        );
      },
      lastReactionApplied: () => lastReactionApplied,
    };

    for (let tryNumber = 1; tryNumber <= 3; tryNumber += 1) {
      this.finalizeGroupMemberStream(groupRoom, stream);
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

  postGroupMemberMessage(
    session: LiveSession,
    groupMember: GroupMember,
    content: string,
    stream?: GroupMemberStream,
  ): void {
    const author = { id: groupMember.id, name: groupMember.name };
    const isActive = this.tm.sessions.activeSession?.id === session.id;
    if (stream != null && isActive) {
      const previewId = stream.sealed.shift();
      if (previewId != null) {
        const finalized = updateEntry(previewId, (transcriptEntry) =>
          transcriptEntry.kind === "send-message"
            ? {
                kind: "send-message",
                id: transcriptEntry.id,
                message: { type: "text", content },
                ...(transcriptEntry.timestampMs == null
                  ? {}
                  : { timestampMs: transcriptEntry.timestampMs }),
                author,
              }
            : transcriptEntry,
        );
        if (finalized != null) {
          this.tm.roster.emit({ type: "updated", entry: finalized });
          session.db.appendTranscriptEntry(finalized);
          this.tm.sessions.markActiveSessionArrival(session);
          this.tm.sharedRooms.publishSharedRoomEntryIfNeeded(
            session,
            finalized,
          );
          return;
        }
      }
    }
    const transcriptEntries = this.entriesFor(session, isActive);
    const transcriptEntry: TranscriptEntry = {
      kind: "send-message",
      id: allocateTranscriptEntryId(transcriptEntries, "send-message"),
      message: { type: "text", content },
      timestampMs: Date.now(),
      author,
    };
    this.writeGroupEntry(session, transcriptEntry, isActive);
    this.tm.sharedRooms.publishSharedRoomEntryIfNeeded(session, transcriptEntry);
  }

  streamGroupMemberUpdate(
    groupRoom: LiveSession,
    groupMember: GroupMember,
    update: any,
    stream: GroupMemberStream,
  ): void {
    if (this.tm.sessions.activeSession?.id !== groupRoom.id) return;
    try {
      if (update.type === "text-delta") {
        if (!update.text) return;
        stream.currentText += update.text;
        if (stream.currentId == null) {
          if (isPotentialPassPrefix(stream.currentText)) return;
          this.openGroupStreamEntry(groupMember, stream);
        } else this.updateGroupStreamEntry(stream.currentId, stream.currentText);
      } else if (update.type === "send-message" && stream.currentId != null) {
        stream.sealed.push(stream.currentId);
        stream.currentId = undefined;
        stream.currentText = "";
      }
    } catch {
      // Streaming preview failures must not fail the groupMember turn.
    }
  }

  openGroupStreamEntry(groupMember: GroupMember, stream: GroupMemberStream): void {
    const id = allocateTranscriptEntryId(getTranscript(), "send-message");
    const transcriptEntry: TranscriptEntry = {
      kind: "send-message",
      id,
      message: { type: "text", content: stream.currentText },
      timestampMs: Date.now(),
      author: { id: groupMember.id, name: groupMember.name },
      streaming: true,
    };
    stream.currentId = id;
    appendEntry(transcriptEntry);
    this.tm.roster.emit({ type: "appended", entry: transcriptEntry });
  }

  updateGroupStreamEntry(id: string, content: string): void {
    const updated = updateEntry(id, (transcriptEntry) =>
      transcriptEntry.kind === "send-message"
        ? { ...transcriptEntry, message: { type: "text", content } }
        : transcriptEntry,
    );
    if (updated != null)
      this.tm.roster.emit({ type: "updated", entry: updated });
  }

  finalizeGroupMemberStream(
    groupRoom: LiveSession,
    stream: GroupMemberStream,
  ): void {
    try {
      if (this.tm.sessions.activeSession?.id === groupRoom.id) {
        const leftovers = [...stream.sealed];
        if (stream.currentId != null) leftovers.push(stream.currentId);
        for (const id of leftovers) {
          if (removeEntry(id)) this.tm.roster.emit({ type: "removed", id });
        }
      }
    } catch {
      // Preview cleanup is defensive: failures never fail the groupMember turn.
    } finally {
      stream.currentId = undefined;
      stream.currentText = "";
      stream.sealed.length = 0;
    }
  }

  readGroupHistory(session: LiveSession): GroupMessage[] {
    const transcriptEntries = this.entriesFor(session);
    const messages: GroupMessage[] = [];
    for (const transcriptEntry of transcriptEntries) {
      if (
        transcriptEntry.kind === "message" &&
        transcriptEntry.role === "user" &&
        String(transcriptEntry.content ?? "").trim()
      ) {
        const name = (transcriptEntry.fromUser as any)?.name;
        messages.push({
          speaker: name == null ? { kind: "user" } : { kind: "user", name },
          content: String(transcriptEntry.content),
        });
      } else if (
        transcriptEntry.kind === "send-message" &&
        (transcriptEntry.message as any)?.type === "text" &&
        transcriptEntry.author != null &&
        transcriptEntry.streaming !== true
      ) {
        messages.push({
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
