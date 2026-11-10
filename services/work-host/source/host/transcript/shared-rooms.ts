/** The shared rooms a conversation's transcript is mirrored into, and read back from.

 * What a room carries — a guest's message, an agent's answer, a picture — is turned into a transcript transcriptEntry and written
 * locally as well, so the conversation a user opens shows what was said in the room; a room that is gone is reported
 * rather than left looking like a conversation that never had anything in it. */
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

import { raisesUserActivity } from "../../shared/transcript.ts";
import { clampAgentMessage } from "../agents/agent-messaging.ts";
import {
  formatRemoteAgentId,
  SLATE_SHARED_ROOM_IMAGE_BYTES_MAX,
} from "../../shared/agents/sharing.ts";
import {
  GROUP_CONFIG_VERSION,
  readSlateGroupConfig,
  writeSlateGroupConfig,
  type SlateGroupConfig,
} from "../groups/group-store.ts";
import {
  REMOTE_ROOM_CONFIG_VERSION,
  readSlateRemoteRoomConfig,
  writeSlateRemoteRoomConfig,
} from "../groups/remote-room-store.ts";
import { isPassContent } from "../groups/group-chat.ts";
import { allocateTranscriptEntryId } from "./transcript-entry-ids.ts";
import { getTranscript, updateEntry } from "./transcript-store.ts";
import type {
  TranscriptEntry,
  TranscriptManagerLike,
} from "./transcript-hub.ts";

export function decodeAvatarDataUrl(dataUrl: string): Buffer | null {
  const marker = ";base64,";
  const index = dataUrl.indexOf(marker);
  if (!dataUrl.startsWith("data:image/") || index === -1) return null;
  try {
    const bytes = Buffer.from(dataUrl.slice(index + marker.length), "base64");
    return bytes.length > 0 ? bytes : null;
  } catch {
    return null;
  }
}

export function isRoomContentEntry(transcriptEntry: TranscriptEntry): boolean {
  return transcriptEntry.kind === "message" || transcriptEntry.kind === "send-message";
}

type LiveSession = any;

export class SharedRooms {
  constructor(readonly tm: TranscriptManagerLike) {}

  async postToGroup(
    fromAgentId: string,
    groupId: string,
    text: string,
    priority = false,
  ): Promise<string> {
    const message = clampAgentMessage(text);
    if (message.length === 0) return "Message was empty; nothing was sent.";
    if (isPassContent(message)) {
      return 'Nothing was posted: "(pass)" means staying silent in a group chat.';
    }
    if (!this.tm.execution.canExecute)
      return "Messaging isn't available right now.";

    let roomSession: LiveSession;
    try {
      roomSession = await this.tm.sessions.resolveBackgroundSession(groupId);
    } catch {
      return `No group found with id ${groupId}.`;
    }
    const roomConfig = readSlateGroupConfig(dirname(roomSession.dbPath));
    if (roomConfig == null) return `${groupId} is not a group chat.`;
    if (!roomConfig.memberIds.includes(fromAgentId)) {
      return "You can only post to a group you're a member of.";
    }

    const groupName = this.tm.groupChat.groupIdentityFor(roomSession).name;
    const member = (
      await this.tm.groupChat.resolveGroupMembers([fromAgentId])
    )[0] ?? {
      id: fromAgentId,
      name: "An agent",
      description: "",
    };
    this.tm.productAnalytics.trackEvent("slate.agent_message.sent", {
      from_agent_id: fromAgentId,
      to_agent_id: groupId,
      is_group_target: true,
      is_priority: priority,
    });
    this.tm.backgroundWakes.appendAgentOutboundEntry(
      fromAgentId,
      { id: groupId, name: groupName, kind: "group" },
      message,
      Date.now(),
    );
    this.tm.groupChat.postGroupMemberMessage(roomSession, member, message);
    const epoch = this.tm.sendPipeline.nextTurnEpoch(roomSession);
    this.tm.runLifecycle.beginSessionRun(roomSession);
    this.startAgentTurn(roomSession, epoch);
    return `Posted to "${groupName}". Its members will see it and reply on their own turns.`;
  }


  /** Writes an transcriptEntry into the transcript the user sees, or into a room that is not on screen. */
  private publishEntry(
    liveSession: LiveSession,
    transcriptEntry: TranscriptEntry,
    options: { readonly raiseActivity: boolean },
  ): void {
    if (this.tm.sessions.activeSession?.id === liveSession.id) {
      this.tm.appendEntry(transcriptEntry);
      return;
    }
    liveSession.db.appendTranscriptEntry(transcriptEntry);
    if (options.raiseActivity) this.tm.sessionStore.markSessionActivity(liveSession);
    void this.tm.roster.emitAgentUpdate(liveSession.id);
  }

  /** A liveSession's entries, read from the open transcript or from its own database. */
  private entriesFor(liveSession: LiveSession, isActive?: boolean): TranscriptEntry[] {
    const onScreen = isActive ?? this.tm.sessions.activeSession?.id === liveSession.id;
    return onScreen ? getTranscript() : liveSession.db.getTranscriptEntries();
  }

  /** Starts the room's own turn for an agent, after an transcriptEntry it should answer. */
  private startAgentTurn(liveSession: LiveSession, epoch: unknown): void {
    void this.tm.runLifecycle.enqueueExclusiveRun(
      liveSession.id,
      () => {
        this.tm.turnRuntime.activeRequestSources.set(liveSession.id, "agent");
        return this.tm.groupChat.runGroupTurn(
          liveSession,
          epoch,
          undefined,
          "agent",
        );
      },
      { lane: "agent", source: "agent" },
    );
  }

  sharedRoomConfigOf(liveSession: LiveSession): SlateGroupConfig | null {
    const roomConfig = readSlateGroupConfig(dirname(liveSession.dbPath));
    return roomConfig?.sharedRoomId == null ? null : roomConfig;
  }

  publishSharedRoomEntryIfNeeded(
    liveSession: LiveSession,
    transcriptEntry: TranscriptEntry,
  ): void {
    const xuserDelegate = this.tm.xuserDelegate;
    const roomConfig = this.sharedRoomConfigOf(liveSession);
    if (xuserDelegate == null || roomConfig?.sharedRoomId == null) return;
    xuserDelegate.publishRoomEntry(roomConfig.sharedRoomId, transcriptEntry);
  }

  async dispatchMirrorRoomSend(liveSession: LiveSession, request: any): Promise<void> {
    const appendNotice = (text: string): void => {
      const notice: TranscriptEntry = {
        kind: "notice",
        id: `notice-xuser-${randomUUID()}`,
        text,
        timestampMs: Date.now(),
      };
      this.publishEntry(liveSession, notice, { raiseActivity: false });
    };
    const remote = readSlateRemoteRoomConfig(dirname(liveSession.dbPath));
    const xuserDelegate = this.tm.xuserDelegate;
    if (remote == null || xuserDelegate == null || !xuserDelegate.isEnabled()) {
      appendNotice(
        "This shared chat isn't connected right now, so the message wasn't delivered.",
      );
      return;
    }
    if (remote.isRevoked === true) {
      appendNotice(
        "You no longer have access to this shared chat, so the message wasn't delivered.",
      );
      return;
    }
    if (request.hasNonImageAttachments) {
      appendNotice(
        "Only text and images can be sent to shared chats for now; other attachments were not delivered.",
      );
    }

    const images: Array<{ base64: string; mediaType: string }> = [];
    let totalImageBytes = 0;
    let omitted = false;
    for (const image of request.selectedImages.slice(0, 4)) {
      if (
        totalImageBytes + image.data.byteLength >
        SLATE_SHARED_ROOM_IMAGE_BYTES_MAX
      ) {
        omitted = true;
        continue;
      }
      totalImageBytes += image.data.byteLength;
      images.push({
        base64: Buffer.from(image.data).toString("base64"),
        mediaType: image.mimeType ?? "image/png",
      });
    }
    if (request.selectedImages.length > 4 || omitted) {
      appendNotice(
        "Some images were too large for the shared chat and were not delivered.",
      );
    }
    try {
      const result = await xuserDelegate.sendMirrorPost({
        roomId: remote.roomId,
        text: request.text,
        images,
        ...(request.clientNonce ? { clientNonce: request.clientNonce } : {}),
      });
      if (result.timestampMs != null && request.clientNonce) {
        const entries = this.entriesFor(liveSession);
        const echo = [...entries]
          .reverse()
          .find(
            (transcriptEntry: TranscriptEntry) =>
              transcriptEntry.kind === "message" &&
              transcriptEntry.clientNonce === request.clientNonce,
          );
        if (echo != null)
          this.restampSessionEntry(liveSession, echo.id, result.timestampMs);
      }
    } catch (error) {
      console.warn(
        `[slate:sharing] mirror send failed room=${remote.roomId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      appendNotice(
        "The message couldn't be delivered to the shared chat. You may have lost access, or the connection failed.",
      );
    }
  }

  async listRoomAgentIds(roomId: string): Promise<string[]> {
    return (await this.listBoundRoomAgents(roomId)).map((agent) => agent.id);
  }

  async findRoomAgentId(roomId: string): Promise<string | null> {
    const boundAgents = await this.listBoundRoomAgents(roomId);
    if (boundAgents.length <= 1) return boundAgents[0]?.id ?? null;
    return (await this.measureRoomAgents(boundAgents)).canonical.agentId;
  }

  async listBoundRoomAgents(roomId: string): Promise<any[]> {
    const agents = await this.tm.sessionStore.listAgents();
    return agents
      .filter((agent: any) => {
        const dir = this.tm.sessionStore.getAgentDir(agent.id);
        return (
          readSlateGroupConfig(dir)?.sharedRoomId === roomId ||
          readSlateRemoteRoomConfig(dir)?.roomId === roomId
        );
      })
      .sort(
        (left: any, right: any) =>
          left.createdAt - right.createdAt || left.id.localeCompare(right.id),
      );
  }

  async readAgentEntries(agentId: string): Promise<TranscriptEntry[] | null> {
    if (this.tm.sessions.activeSession?.id === agentId) return getTranscript();
    try {
      return (
        await this.tm.sessions.resolveBackgroundSession(agentId)
      ).db.getTranscriptEntries();
    } catch {
      return null;
    }
  }

  async measureRoomAgents(boundAgents: readonly any[]): Promise<{
    canonical: { agentId: string; entryCount: number; isRemovable: boolean };
    measurements: Array<{
      agentId: string;
      entryCount: number;
      isRemovable: boolean;
    }>;
  }> {
    const measurements = [];
    for (const agent of boundAgents) {
      const entries = await this.readAgentEntries(agent.id);
      measurements.push({
        agentId: agent.id,
        entryCount: entries?.length ?? 0,
        isRemovable: entries != null && !entries.some(isRoomContentEntry),
      });
    }
    const canonical = measurements.reduce((best, candidate) =>
      candidate.entryCount > best.entryCount ? candidate : best,
    );
    return { canonical, measurements };
  }

  async resolveCanonicalRoomAgent(roomId: string): Promise<string | null> {
    const boundAgents = await this.listBoundRoomAgents(roomId);
    if (boundAgents.length <= 1) return boundAgents[0]?.id ?? null;
    const { canonical, measurements } = await this.measureRoomAgents(boundAgents);
    const removableIds: string[] = [];
    for (const extra of measurements) {
      if (extra.agentId === canonical.agentId) continue;
      if (!extra.isRemovable) {
        console.warn(
          `[slate:sharing] keeping duplicate room agent with content room=${roomId} agent=${extra.agentId} entries=${extra.entryCount} canonical=${canonical.agentId}`,
        );
      } else removableIds.push(extra.agentId);
    }
    if (removableIds.length > 0) {
      console.warn(
        `[slate:sharing] removing ${removableIds.length} empty duplicate room agent(s) room=${roomId} canonical=${canonical.agentId}`,
      );
      await this.tm.deleteAgents(removableIds);
    }
    return canonical.agentId;
  }

  async getSharedRoomIdForAgent(agentId: string): Promise<string | null> {
    const dir = this.tm.sessionStore.getAgentDir(agentId);
    return (
      readSlateGroupConfig(dir)?.sharedRoomId ??
      readSlateRemoteRoomConfig(dir)?.roomId ??
      null
    );
  }

  async ensureHostedSharedRoom(request: any): Promise<string | null> {
    const existingId = await this.resolveCanonicalRoomAgent(request.roomId);
    const agents = await this.tm.sessionStore.listAgents();
    const existingIds = new Set<string>(agents.map((agent: any) => agent.id));
    const oldMembers =
      existingId == null
        ? []
        : (readSlateGroupConfig(this.tm.sessionStore.getAgentDir(existingId))
            ?.remoteMembers ?? []);
    const storedAvatars = new Map(
      oldMembers.flatMap((member) =>
        member.avatarDataUrl == null
          ? []
          : [
              [
                `${member.ownerAuthId}\0${member.agentId}`,
                member.avatarDataUrl,
              ] as const,
            ],
      ),
    );
    const remoteMembers = request.remoteMembers.map((member: any) => {
      const avatarDataUrl =
        member.avatarDataUrl ??
        storedAvatars.get(`${member.ownerAuthId}\0${member.agentId}`);
      return { ...member, ...(avatarDataUrl == null ? {} : { avatarDataUrl }) };
    });
    const binding: SlateGroupConfig = {
      version: GROUP_CONFIG_VERSION,
      memberIds: request.localMemberIds.filter(
        (id: string) =>
          existingIds.has(id) && !this.tm.groupChat.isGroupAgentId(id),
      ),
      remoteMembers,
      sharedRoomId: request.roomId,
    };
    if (existingId != null) {
      writeSlateGroupConfig(
        this.tm.sessionStore.getAgentDir(existingId),
        binding,
      );
      await this.tm.roster.emitAgents();
      return existingId;
    }
    if (!request.isCreationAllowed) return null;
    const created = await this.tm.createBackgroundAgent(
      { name: request.name, description: "" },
      "user",
      {
        isIntroductionSuppressed: true,
        configureAgentDir: (dir: string) => writeSlateGroupConfig(dir, binding),
      },
    );
    return created.agent.id;
  }

  async ensureMirrorRoom(room: any, selfAuthId: string): Promise<string> {
    const writeBinding = (dir: string): void => {
      const previous = readSlateRemoteRoomConfig(dir);
      const stored = new Map(
        (previous?.members ?? []).flatMap((member) =>
          member.avatarUrl == null
            ? []
            : [
                [
                  `${member.authId}\0${member.agentId}`,
                  member.avatarUrl,
                ] as const,
              ],
        ),
      );
      const hostAvatarUrl =
        room.members.find(
          (member: any) =>
            member.kind === "human" && member.authId === room.hostAuthId,
        )?.avatarUrl ?? previous?.hostAvatarUrl;
      writeSlateRemoteRoomConfig(dir, {
        version: REMOTE_ROOM_CONFIG_VERSION,
        roomId: room.roomId,
        hostAuthId: room.hostAuthId,
        hostName: room.hostName,
        ...(hostAvatarUrl == null ? {} : { hostAvatarUrl }),
        members: room.members
          .filter((member: any) => member.authId !== selfAuthId)
          .map(({ avatarDataUrl, ...member }: any) => {
            const avatarUrl =
              member.avatarUrl ??
              avatarDataUrl ??
              stored.get(`${member.authId}\0${member.agentId}`);
            return { ...member, ...(avatarUrl == null ? {} : { avatarUrl }) };
          }),
      });
    };
    const existingId = await this.resolveCanonicalRoomAgent(room.roomId);
    if (existingId != null) {
      writeBinding(this.tm.sessionStore.getAgentDir(existingId));
      await this.applyMirrorRoomPicture(existingId, room.avatarDataUrl);
      await this.tm.roster.emitAgentUpdate(existingId);
      return existingId;
    }
    const created = await this.tm.createBackgroundAgent(
      { name: room.name, description: "" },
      "user",
      { isIntroductionSuppressed: true, configureAgentDir: writeBinding },
    );
    await this.applyMirrorRoomPicture(created.agent.id, room.avatarDataUrl);
    return created.agent.id;
  }

  async applyMirrorRoomPicture(
    agentId: string,
    roomAvatarDataUrl?: string,
  ): Promise<void> {
    if (roomAvatarDataUrl == null) return;
    try {
      const current = await this.tm.sessionStore.getAgentAvatar(agentId);
      if (current.dataUrl === roomAvatarDataUrl) return;
      const bytes = decodeAvatarDataUrl(roomAvatarDataUrl);
      if (bytes == null) return;
      const active = this.tm.sessions.activeSession;
      if (active?.id === agentId) {
        await this.tm.sessionStore.setAgentAvatarBytes(
          active.db,
          active.dbPath,
          agentId,
          bytes,
          agentId,
        );
      } else await this.tm.sessionStore.setAgentAvatarBytesById(agentId, bytes);
      await this.tm.roster.emitAgentUpdate(agentId);
    } catch {
      // Invalid or transiently unavailable avatars leave the local picture alone.
    }
  }

  async markMirrorRoomRevoked(roomId: string): Promise<void> {
    const agentId = await this.tm.findRoomAgentId(roomId);
    if (agentId == null) return;
    const dir = this.tm.sessionStore.getAgentDir(agentId);
    const roomConfig = readSlateRemoteRoomConfig(dir);
    if (roomConfig == null || roomConfig.isRevoked === true) return;
    writeSlateRemoteRoomConfig(dir, { ...roomConfig, isRevoked: true });
    await this.tm.roster.emitAgentUpdate(agentId);
  }

  async appendSharedRoomActivityNotice(request: {
    roomId: string;
    text: string;
  }): Promise<void> {
    const agentId = await this.tm.findRoomAgentId(request.roomId);
    if (agentId == null) return;
    let liveSession: LiveSession;
    try {
      liveSession = await this.tm.sessions.resolveBackgroundSession(agentId);
    } catch {
      return;
    }
    const notice: TranscriptEntry = {
      kind: "notice",
      id: `notice-xuser-turn-${randomUUID()}`,
      text: request.text,
      timestampMs: Date.now(),
    };
    this.publishEntry(liveSession, notice, { raiseActivity: true });
  }

  async appendMirrorRoomEntry(request: any): Promise<boolean> {
    const agentId = await this.tm.findRoomAgentId(request.roomId);
    if (agentId == null) return false;
    let liveSession: LiveSession;
    try {
      liveSession = await this.tm.sessions.resolveBackgroundSession(agentId);
    } catch {
      return false;
    }
    if (!this.tm.groupChat.isRemoteRoomSession(liveSession)) return false;
    const isActive = this.tm.sessions.activeSession?.id === liveSession.id;
    const entries = this.entriesFor(liveSession, isActive);
    const localId = `xu-${request.entry.entryId}`;
    if (entries.some((transcriptEntry: TranscriptEntry) => transcriptEntry.id === localId))
      return true;
    if (
      request.entry.clientNonce &&
      entries.some(
        (transcriptEntry: TranscriptEntry) =>
          transcriptEntry.kind === "message" &&
          transcriptEntry.clientNonce === request.entry.clientNonce,
      )
    )
      return true;

    const images = await this.tm.sendPipeline.materializeInlineImages(
      liveSession,
      request.entry.images,
    );
    const transcriptEntry: TranscriptEntry =
      request.entry.kind === "human-message"
        ? {
            kind: "message",
            id: localId,
            role: "user",
            content: request.entry.text,
            isStreaming: false,
            timestampMs: request.entry.timestampMs,
            ...(request.entry.clientNonce
              ? { clientNonce: request.entry.clientNonce }
              : {}),
            ...(request.entry.authorAuthId === request.selfAuthId
              ? {}
              : {
                  fromUser: {
                    name: request.entry.authorName,
                    ...(request.entry.authorAuthId
                      ? { authId: request.entry.authorAuthId }
                      : {}),
                    ...(request.entry.authorAvatarUrl
                      ? { avatarUrl: request.entry.authorAvatarUrl }
                      : {}),
                  },
                }),
            ...(images.length > 0 ? { images } : {}),
          }
        : {
            kind: "send-message",
            id: localId,
            message: {
              type: "text",
              content: request.entry.text,
              ...(images.length > 0 ? { images } : {}),
            },
            timestampMs: request.entry.timestampMs,
            author: {
              id: formatRemoteAgentId({
                ownerAuthId: request.entry.agentOwnerAuthId ?? "",
                agentId: request.entry.agentId ?? "",
              }),
              name: request.entry.authorName,
            },
          };
    this.publishEntry(liveSession, transcriptEntry, {
      raiseActivity: raisesUserActivity(transcriptEntry),
    });
    return true;
  }

  restampSessionEntry(
    liveSession: LiveSession,
    entryId: string,
    timestampMs: number,
  ): void {
    const stamp = (transcriptEntry: TranscriptEntry): TranscriptEntry =>
      transcriptEntry.kind === "message" || transcriptEntry.kind === "send-message"
        ? { ...transcriptEntry, timestampMs }
        : transcriptEntry;
    if (this.tm.sessions.activeSession?.id === liveSession.id) {
      const updated = updateEntry(entryId, stamp);
      if (updated != null)
        this.tm.roster.emit({ type: "updated", transcriptEntry: updated });
    }
    liveSession.db.updateTranscriptEntry(entryId, stamp);
  }

  async restampRoomEntry(request: {
    roomId: string;
    entryId: string;
    timestampMs: number;
  }): Promise<void> {
    const agentId = await this.tm.findRoomAgentId(request.roomId);
    if (agentId == null) return;
    try {
      const liveSession = await this.tm.sessions.resolveBackgroundSession(agentId);
      this.restampSessionEntry(liveSession, request.entryId, request.timestampMs);
    } catch {
      return;
    }
  }

  async postSharedRoomGuestMessage(request: any): Promise<void> {
    const agentId = await this.tm.findRoomAgentId(request.roomId);
    if (agentId == null) return;
    let liveSession: LiveSession;
    try {
      liveSession = await this.tm.sessions.resolveBackgroundSession(agentId);
    } catch {
      return;
    }
    if (this.sharedRoomConfigOf(liveSession) == null) return;
    const text = clampAgentMessage(request.text);
    if (text.length === 0 && request.images.length === 0) return;
    const active = this.tm.sessions.activeSession?.id === liveSession.id;
    const entries = this.entriesFor(liveSession, active);
    if (
      request.clientNonce &&
      entries.some(
        (transcriptEntry: TranscriptEntry) =>
          transcriptEntry.kind === "message" && transcriptEntry.clientNonce === request.clientNonce,
      )
    )
      return;
    const images = await this.tm.sendPipeline.materializeInlineImages(
      liveSession,
      request.images,
    );
    const transcriptEntry: TranscriptEntry = {
      kind: "message",
      id: allocateTranscriptEntryId(entries, "user-message"),
      role: "user",
      content: text,
      isStreaming: false,
      timestampMs: request.timestampMs ?? Date.now(),
      fromUser: {
        name: request.authorName,
        authId: request.authorAuthId,
        ...(request.authorAvatarUrl ? { avatarUrl: request.authorAvatarUrl } : {}),
      },
      ...(request.clientNonce ? { clientNonce: request.clientNonce } : {}),
      ...(images.length > 0 ? { images } : {}),
    };
    this.publishEntry(liveSession, transcriptEntry, { raiseActivity: true });
    this.publishSharedRoomEntryIfNeeded(liveSession, transcriptEntry);
    const epoch = this.tm.sendPipeline.nextTurnEpoch(liveSession);
    this.tm.runLifecycle.beginSessionRun(liveSession);
    this.startAgentTurn(liveSession, epoch);
  }

  async runRemoteRequestedMemberTurn(request: any): Promise<string[]> {
    if (!this.tm.execution.canExecuteGroupMember) return [];
    if (this.tm.groupChat.isGroupAgentId(request.agentId)) return [];
    if (this.tm.groupChat.isRemoteRoomAgentId(request.agentId)) return [];
    let liveSession: LiveSession;
    try {
      liveSession = await this.tm.groupChat.pinMemberSessionForGroupTurn(
        request.agentId,
      );
    } catch {
      return [];
    }
    const sent: string[] = [];
    const transport = {
      onUpdate: (update: any) => {
        if (
          update.type === "send-message" &&
          update.message?.type === "text" &&
          !isPassContent(update.message.content)
        )
          sent.push(update.message.content);
      },
      lastReactionApplied: () => false,
    };
    await this.tm.runLifecycle.enqueueExclusiveRun(
      liveSession.id,
      async () => {
        this.tm.turnRuntime.activeRequestSources.set(liveSession.id, "agent");
        try {
          const runner = this.tm.execution.createGroupMemberRunner(
            liveSession,
            this.tm.runnerRegistry.runnerHooksFor(liveSession, transport),
            { systemPrompt: request.systemPrompt, isSharedRoomTurn: true },
          );
          this.tm.runnerRegistry.wireRunnerLifecycle(
            runner,
            liveSession,
            liveSession.id,
          );
          await runner.run(request.prompt, {});
        } catch {
          return;
        } finally {
          this.tm.runLifecycle.endSessionRun(liveSession);
        }
      },
      { lane: "background", source: "group-member" },
    );
    return sent;
  }
}
