/**
 * Sharing a room with another user's computer, as a service.
 *
 * The service takes a share from where it is offered to where it is used, checks it against the platform's policy, and
 * reports what it did rather than leaving a caller to guess.
 */
import { EMPTY_SLATE_SHARING_STATE, isPublishableShareAvatarDataUrl } from "../../shared/agents/sharing.ts";
import { normalizeSharedRoomName } from "../groups/xuser.ts";
import { SlateXuserDepartureObligations, type XuserDepartureHost } from "./xuser-departure-obligations.ts";
import { SlateXuserEntryPublisher, type PublishableEntry, type XuserEntryPublisherHost } from "./xuser-entry-publisher.ts";
import { createInMemoryXuserPendingDepartures } from "./xuser-pending-departure-store.ts";
import { SlateXuserRelayClient } from "./xuser-relay.ts";
import { SlateXuserRemoteTurns, type RemoteTurnsHost } from "./xuser-remote-turns.ts";
import { createInMemoryXuserRoomTombstones } from "./xuser-room-tombstone-store.ts";
import { SlateXuserStateReconcile, type XuserRoom, type XuserStateReconcileHost } from "./xuser-state-reconcile.ts";
import { createInMemoryXuserTurnDedupe, type XuserTurnDedupe } from "./xuser-turn-dedupe-store.ts";
import { normalizeInlineImages, normalizeMirrorEntry } from "./xuser-wire-normalization.ts";
import type { SharingDependencies, SharingManager, SlateSharingState } from "./xuser-sharing-contracts.ts";

export type { SharingDependencies, SharingManager, SlateSharingState } from "./xuser-sharing-contracts.ts";

interface SharedServicePorts {
  readonly relay: SlateXuserRelayClient;
  readonly manager: SharingManager;
  readonly clock: SharingDependencies["timing"]["clock"];
  readonly isEnabled: SharingDependencies["isEnabled"];
  readonly getSelfAuthId: () => string | null;
  readonly getRooms: () => XuserRoom[];
}

type SharingEventHandler = (event: Record<string, unknown>) => boolean | Promise<boolean>;

interface TypingPresence {
  readonly roomId: string;
  readonly authId: string;
  readonly name: string;
  readonly avatarUrl?: string;
  readonly expiresAtMs: number;
}

function visibleTypingUsers(users: Iterable<TypingPresence>, selfAuthId: string | null, now: number): TypingPresence[] {
  const visible: TypingPresence[] = [];
  for (const user of users) {
    if (user.expiresAtMs <= now || user.authId === selfAuthId) continue;
    visible.push(user);
  }
  return visible;
}

function sharedPorts(
  relay: SlateXuserRelayClient,
  dependencies: SharingDependencies,
  accountAuthId: () => string | null,
  activeRooms: () => XuserRoom[],
): SharedServicePorts {
  return {
    relay,
    manager: dependencies.manager,
    clock: dependencies.timing.clock,
    isEnabled: dependencies.isEnabled,
    getSelfAuthId: accountAuthId,
    getRooms: activeRooms,
  };
}

export const STATE_RECONCILE_INTERVAL_MS = 5 * 60_000;
export const SELF_IDENTITY_RETRY_MS = 1_000;
export class SlateXuserSharingService {
  readonly relay: SlateXuserRelayClient;
  readonly remoteTurns: SlateXuserRemoteTurns;
  readonly departures: SlateXuserDepartureObligations;
  readonly reconcile: SlateXuserStateReconcile;
  readonly publisher: SlateXuserEntryPublisher;
  readonly turnDedupe: XuserTurnDedupe;
  private readonly dependencies: SharingDependencies;
  private started = false;
  private startEpoch = 0;
  private accountAuthId: string | null = null;
  private queuedJoinRequests: Array<Record<string, unknown>> = [];
  private activeRooms: XuserRoom[] = [];
  readonly typingUsers = new Map<string, TypingPresence>();
  readonly typingExpiryHandles = new Map<string, { dispose(): void }>();
  private readonly roomCreationFlights = new Map<string, Promise<Record<string, unknown>>>();
  private reconciliationTimer: { dispose(): void } | null = null;
  private identityRetryTimer: { dispose(): void } | null = null;
  private readonly eventHandlers: Record<string, SharingEventHandler> = {
    "room-join-request": (event) => this.handleRoomJoinRequest(event),
    "room-join-decision": (event) => this.acceptRoomJoin(event),
    "room-upsert": (event) => this.applyRoomUpsert(event),
    "room-typing": (event) => this.handleRoomTyping(event),
    "room-post": (event) => this.handleRoomPost(event),
    "room-entry": (event) => this.handleRoomEntry(event),
    "turn-request": (event) => this.remoteTurns.handleTurnRequest(event),
    "turn-result": (event) => this.remoteTurns.handleTurnResult(event),
    "member-left": (event) => this.closeRoomFromRelay(event),
    "room-ended": (event) => this.closeRoomFromRelay(event),
  };
  constructor(deps: SharingDependencies) {
    this.dependencies = deps;
    this.turnDedupe = deps.turnDedupe ?? createInMemoryXuserTurnDedupe();
    this.relay = new SlateXuserRelayClient({
      getAccessToken: deps.getAccessToken,
      getBackendUrl: deps.getBackendUrl,
      ...(deps.fetchImpl == null ? {} : { fetchImpl: deps.fetchImpl }),
      clock: deps.timing.clock,
      pollPolicy: deps.timing.relayPoll,
      onEvent: (event) => this.handleEvent(event),
      ...(deps.isNotifyConnected == null ? {} : { isNotifyConnected: deps.isNotifyConnected }),
      ...(deps.isNotifySafetyPollEnabled == null ? {} : { isNotifySafetyPollEnabled: deps.isNotifySafetyPollEnabled }),
    });
    const ports = sharedPorts(this.relay, deps, () => this.accountAuthId, () => this.activeRooms);
    this.remoteTurns = new SlateXuserRemoteTurns({
      ...ports,
      remoteTurnDeadline: deps.timing.remoteTurnDeadline,
      turnDedupe: this.turnDedupe,
      reconcileShareState: () => this.reconcileShareState(),
    } as unknown as RemoteTurnsHost);
    this.departures = new SlateXuserDepartureObligations({
      ...ports,
      setSelfAuthId: (id: string) => { this.accountAuthId = id; },
      readSelfAuthId: (operation: string) => this.readSelfAuthId(operation),
      setRooms: (rooms: XuserRoom[]) => { this.activeRooms = rooms; },
      emit: () => this.emit(),
      installRoom: (room: XuserRoom) => this.reconcile.installRoom(room),
    } as unknown as XuserDepartureHost, deps.pendingDepartures ?? createInMemoryXuserPendingDepartures(), deps.roomTombstones ?? createInMemoryXuserRoomTombstones());
    this.reconcile = new SlateXuserStateReconcile({
      ...ports,
      setSelfAuthId: (id: string | null) => { this.accountAuthId = id; },
      readSelfAuthId: (operation: string) => this.readSelfAuthId(operation),
      setRooms: (rooms: XuserRoom[]) => { this.activeRooms = rooms; },
      setPendingJoinRequests: (requests: Array<Record<string, unknown>>) => { this.queuedJoinRequests = requests; },
      typingUsers: this.typingUsers,
      typingExpiryHandles: this.typingExpiryHandles,
      emit: () => this.emit(),
      departures: () => this.departures,
      agentAvatarPayload: (id: string) => this.agentAvatarPayload(id),
    } as unknown as XuserStateReconcileHost);
    this.publisher = new SlateXuserEntryPublisher({
      ...ports,
      resolveAttachment: deps.resolveAttachment,
    } as unknown as XuserEntryPublisherHost);
  }
  requestRelayDrain(): void { this.relay.requestDrain(); }
  async start(): Promise<void> {
    if (this.started) return;
    if (!this.dependencies.isEnabled()) {
      this.dependencies.emitSharing(EMPTY_SLATE_SHARING_STATE);
      return;
    }
    this.started = true;
    const startEpoch = ++this.startEpoch;
    await this.completeStartup(startEpoch);
  }

  private async completeStartup(startEpoch: number): Promise<void> {
    this.accountAuthId = await this.readSelfAuthId("start");
    if (!this.isCurrentStart(startEpoch)) return;
    await this.reconcileShareState();
    if (!this.isCurrentStart(startEpoch)) return;
    this.relay.start();
    this.startReconcilePolling();
    this.startSelfIdentityPolling();
  }

  private isCurrentStart(startEpoch: number): boolean {
    return this.started && this.startEpoch === startEpoch;
  }

  private startReconcilePolling(): void {
    let skipImmediateTick = true;
    this.reconciliationTimer = this.dependencies.timing.reconcilePoll.start(async () => {
      if (skipImmediateTick) {
        skipImmediateTick = false;
        return;
      }
      if (this.started && this.accountAuthId != null) await this.reconcileShareState();
    });
  }

  private startSelfIdentityPolling(): void {
    if (this.accountAuthId != null || this.identityRetryTimer != null) return;
    let skipImmediateTick = true;
    this.identityRetryTimer = this.dependencies.timing.selfIdentityRetry.start(async () => {
      if (skipImmediateTick) {
        skipImmediateTick = false;
        return;
      }
      if (!this.started || this.accountAuthId != null) return;
      const resolvedId = await this.readSelfAuthId("identity retry");
      if (resolvedId == null || !this.started) return;
      this.accountAuthId = resolvedId;
      this.identityRetryTimer?.dispose();
      this.identityRetryTimer = null;
      await this.reconcileShareState();
    });
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.startEpoch += 1;
    this.relay.stop();
    this.reconciliationTimer?.dispose();
    this.reconciliationTimer = null;
    this.identityRetryTimer?.dispose();
    this.identityRetryTimer = null;
    this.remoteTurns.stop();
    for (const expiry of this.typingExpiryHandles.values()) expiry.dispose();
    this.typingExpiryHandles.clear();
    this.typingUsers.clear();
  }

  getState(): SlateSharingState | typeof EMPTY_SLATE_SHARING_STATE {
    if (!this.dependencies.isEnabled()) return EMPTY_SLATE_SHARING_STATE;
    const now = this.dependencies.timing.clock.now();
    return {
      isEnabled: true,
      selfAuthId: this.accountAuthId,
      pendingJoinRequests: this.queuedJoinRequests,
      rooms: this.activeRooms,
      typingUsers: visibleTypingUsers(this.typingUsers.values(), this.accountAuthId, now),
    };
  }

  emit(): void {
    this.dependencies.emitSharing(this.getState());
  }

  installRoom(room: XuserRoom): Promise<void> {
    return this.reconcile.installRoom(room);
  }

  reconcileShareState(): Promise<void> {
    return this.reconcile.reconcileShareState();
  }

  isRoomAbandoned(roomId: string): boolean {
    return this.departures.isRoomAbandoned(roomId);
  }

  async handleEvent(event: Record<string, unknown>): Promise<boolean> {
    if (!this.dependencies.isEnabled()) return true;
    const kind = event.kind;
    if (typeof kind !== "string" || !Object.hasOwn(this.eventHandlers, kind)) return true;
    return this.eventHandlers[kind]!(event);
  }

  private async acceptRoomJoin(event: Record<string, unknown>): Promise<boolean> {
    if (event.isApproved !== true || event.room == null) return true;
    const acceptedRoom = event.room as XuserRoom;
    this.departures.clearRoomTombstones(acceptedRoom.roomId);
    await this.installRoom(acceptedRoom);
    return true;
  }

  private async applyRoomUpsert(event: Record<string, unknown>): Promise<boolean> {
    if (event.room != null) await this.installRoom(event.room as XuserRoom);
    return true;
  }

  private async closeRoomFromRelay(event: Record<string, unknown>): Promise<boolean> {
    const roomId = event.roomId;
    if (typeof roomId === "string") {
      await this.dependencies.manager.markMirrorRoomRevoked(roomId);
      this.departures.abandonRoomLocally(roomId);
    }
    await this.reconcileShareState();
    return true;
  }

  private handleRoomJoinRequest(event: Record<string, unknown>): boolean {
    if (typeof event.request !== "object" || event.request === null) return true;
    const request = event.request as Record<string, unknown>;
    const requestId = request.requestId;
    if (typeof requestId !== "string" || this.queuedJoinRequests.some((queued) => queued.requestId === requestId)) return true;

    const requesterName = typeof request.requesterName === "string" ? request.requesterName : "";
    const avatar = typeof request.requesterAvatarUrl === "string" && request.requesterAvatarUrl
      ? { requesterAvatarUrl: request.requesterAvatarUrl }
      : {};
    this.queuedJoinRequests.push({
      requestId,
      roomId: request.roomId ?? "",
      roomName: request.roomName ?? "Shared room",
      requesterAuthId: request.requesterAuthId ?? "",
      requesterName: normalizeSharedRoomName(requesterName),
      ...avatar,
      createdAtMs: request.createdAtMs ?? this.dependencies.timing.clock.now(),
    });
    this.emit();
    return true;
  }

  private handleRoomTyping(event: Record<string, unknown>): boolean {
    if (typeof event.user !== "object" || event.user === null) return true;
    const user = event.user as Record<string, unknown>;
    if (typeof user.roomId !== "string" || typeof user.authId !== "string" || typeof user.name !== "string" || typeof user.expiresAtMs !== "number") return true;

    const room = this.activeRooms.find((candidate) => candidate.roomId === user.roomId);
    const isKnownMember = room?.members.some((member) => member.kind === "human" && member.authId === user.authId) === true;
    if (!isKnownMember) return true;

    const key = `${user.roomId}\0${user.authId}`;
    this.typingExpiryHandles.get(key)?.dispose();
    this.typingExpiryHandles.delete(key);
    const now = this.dependencies.timing.clock.now();
    if (event.isTyping !== true || user.expiresAtMs <= now) {
      if (this.typingUsers.delete(key)) this.emit();
      return true;
    }

    const avatar = typeof user.avatarUrl === "string" && user.avatarUrl ? { avatarUrl: user.avatarUrl } : {};
    this.typingUsers.set(key, {
      roomId: user.roomId,
      authId: user.authId,
      name: normalizeSharedRoomName(user.name),
      ...avatar,
      expiresAtMs: user.expiresAtMs,
    });
    this.emit();
    const timeout = Math.max(0, user.expiresAtMs - now);
    const expiry = this.dependencies.timing.typingExpiry(timeout);
    const ticket = expiry.arm(key, () => {
      this.typingExpiryHandles.delete(key);
      if (this.typingUsers.get(key)?.expiresAtMs !== user.expiresAtMs) return;
      this.typingUsers.delete(key);
      this.emit();
    });
    this.typingExpiryHandles.set(key, ticket);
    return true;
  }

  private async handleRoomPost(event: Record<string, unknown>): Promise<boolean> {
    if (typeof event.roomId !== "string" || typeof event.authorAuthId !== "string" || this.isRoomAbandoned(event.roomId)) return true;
    const timestamp = typeof event.timestampMs === "number" && Number.isFinite(event.timestampMs)
      ? { timestampMs: event.timestampMs }
      : {};
    await this.dependencies.manager.postSharedRoomGuestMessage({
      roomId: event.roomId,
      authorAuthId: event.authorAuthId,
      authorName: normalizeSharedRoomName(typeof event.authorName === "string" ? event.authorName : ""),
      text: typeof event.text === "string" ? event.text : "",
      images: normalizeInlineImages(event.images),
      ...timestamp,
    });
    return true;
  }

  private async handleRoomEntry(event: Record<string, unknown>): Promise<boolean> {
    if (typeof event.roomId !== "string" || event.entry == null || this.isRoomAbandoned(event.roomId)) return true;
    if (this.accountAuthId == null) return false;
    const entry = normalizeMirrorEntry(event.entry, this.dependencies.timing.clock.now());
    if (entry == null) return true;
    return this.dependencies.manager.appendMirrorRoomEntry({
      roomId: event.roomId,
      entry,
      selfAuthId: this.accountAuthId,
    });
  }

  async agentAvatarPayload(agentId: string): Promise<string | undefined> {
    const profileImage = await this.dependencies.manager.getAgentAvatar(agentId).catch(() => null);
    const dataUrl = profileImage?.dataUrl ?? null;
    return dataUrl !== null && isPublishableShareAvatarDataUrl(dataUrl) ? dataUrl : undefined;
  }
  async createRoomFromAgent(agentId: string): Promise<Record<string, unknown>> {
    if (!this.dependencies.isEnabled()) return { status: "error", message: "Sharing isn't enabled." };
    const activeMint = this.roomCreationFlights.get(agentId);
    if (activeMint !== undefined) return activeMint;
    return this.createRoomInviteForAgent(agentId);
  }

  private async createRoomInviteForAgent(agentId: string): Promise<Record<string, unknown>> {
    const creation = this.mintRoomForAgent(agentId);
    this.roomCreationFlights.set(agentId, creation);
    try {
      return await creation;
    } finally {
      this.roomCreationFlights.delete(agentId);
    }
  }

  private async mintRoomForAgent(agentId: string): Promise<Record<string, unknown>> {
    const profile = await this.dependencies.manager.getAgentDisplayProfile(agentId);
    if (profile === null) return { status: "error", message: "That agent no longer exists." };

    const alreadySharedRoom = this.findAgentShareRoomId(agentId);
    if (alreadySharedRoom !== null) return this.relay.createRoomInvite(alreadySharedRoom);

    const avatarDataUrl = await this.agentAvatarPayload(agentId);
    const result = await this.relay.createRoomFromAgent({
      agentId,
      agentName: profile.name,
      ...(avatarDataUrl == null ? {} : { avatarDataUrl }),
    });
    if (result.status === "ok") await this.reconcileShareState();
    return result;
  }

  findAgentShareRoomId(agentId: string): string | null {
    const selfAuthId = this.accountAuthId;
    if (selfAuthId === null) return null;
    for (const room of this.activeRooms) {
      if (room.hostAuthId !== selfAuthId || this.isRoomAbandoned(room.roomId)) continue;
      const localAgents = room.members.filter((member) => member.kind === "agent");
      if (localAgents.length !== 1) continue;
      const localAgent = localAgents[0];
      if (localAgent?.authId !== selfAuthId || localAgent.agentId !== agentId) continue;
      return room.roomId;
    }
    return null;
  }

  createRoomInvite(roomId: string): Promise<Record<string, unknown>> {
    if (!this.dependencies.isEnabled()) return Promise.resolve({ status: "error", message: "Sharing isn't enabled." });
    return this.relay.createRoomInvite(roomId);
  }

  async joinRoom(link: string): Promise<Record<string, unknown>> {
    if (!this.dependencies.isEnabled()) return { status: "error", message: "Sharing isn't enabled." };
    const result = await this.relay.joinRoom(link);
    if (result.status === "already-member") await this.reconcileShareState();
    return result;
  }

  async respondToJoinRequest(args: { requestId: string; [key: string]: unknown }): Promise<unknown> {
    if (!this.dependencies.isEnabled()) return this.getState();
    try {
      const response = await this.relay.respondToJoinRequest<Record<string, unknown>>(args);
      this.queuedJoinRequests = this.queuedJoinRequests.filter((request) => request.requestId !== args.requestId);
      if (response.status === "approved" && response.room != null) {
        await this.installRoom(response.room as XuserRoom);
      } else {
        this.emit();
      }
    } catch {
      // A failed response leaves the request visible so the host can try it again.
    }
    return this.getState();
  }

  async createSharedRoom(args: { agents: Array<Record<string, unknown>>; [key: string]: unknown }): Promise<Record<string, unknown>> {
    if (!this.dependencies.isEnabled()) return { status: "error", message: "Sharing isn't enabled." };
    if (this.accountAuthId == null) return { status: "error", message: "Sign in to create shared groups." };
    try {
      const agentsWithAvatars = await Promise.all(args.agents.map((agent) => this.agentWithAvatar(agent)));
      const result = await this.relay.createRoom<Record<string, unknown>>({ ...args, agents: agentsWithAvatars });
      if (result.status !== "created" || result.room == null) return { status: "error", message: "The room couldn't be created." };
      const room = result.room as XuserRoom;
      await this.installRoom(room);
      const localRoomAgentId = await this.reconcile.mintLocalRoomAgent(room);
      return { status: "ok", roomId: room.roomId, localRoomAgentId };
    } catch {
      return { status: "error", message: "The room couldn't be created. Try again." };
    }
  }

  private async agentWithAvatar(agent: Record<string, unknown>): Promise<Record<string, unknown>> {
    const avatarDataUrl = typeof agent.agentId === "string" ? await this.agentAvatarPayload(agent.agentId) : undefined;
    return { ...agent, ...(avatarDataUrl == null ? {} : { avatarDataUrl }) };
  }

  async addOwnAgent(args: { agentId: string; [key: string]: unknown }): Promise<unknown> {
    if (!this.dependencies.isEnabled()) return this.getState();
    try {
      const avatarDataUrl = await this.agentAvatarPayload(args.agentId);
      const result = await this.relay.addOwnAgent<Record<string, unknown>>({
        ...args,
        ...(avatarDataUrl == null ? {} : { avatarDataUrl }),
      });
      if (result.room != null) await this.installRoom(result.room as XuserRoom);
    } catch {
      // The next reconciliation will retry the room projection.
    }
    return this.getState();
  }

  async removeOwnAgent(roomId: string, agentId: string): Promise<unknown> {
    if (!this.dependencies.isEnabled()) return this.getState();
    try {
      const result = await this.relay.removeOwnAgent<Record<string, unknown>>({ roomId, agentId });
      if (result.room != null) await this.installRoom(result.room as XuserRoom);
    } catch {
      // Keep the current view; reconciliation owns repair after a failed mutation.
    }
    return this.getState();
  }

  async leaveSharedRoom(roomId: string, targetAuthId?: string): Promise<unknown> {
    if (!this.dependencies.isEnabled()) return this.getState();
    try {
      await this.relay.leaveRoom(roomId, targetAuthId);
      const ownDeparture = targetAuthId == null || targetAuthId === this.accountAuthId;
      if (ownDeparture) {
        await this.dependencies.manager.markMirrorRoomRevoked(roomId);
        this.departures.abandonRoomLocally(roomId);
      }
      await this.reconcileShareState();
    } catch {
      // A failed leave does not discard the room's local view.
    }
    return this.getState();
  }

  async noteAgentDeleted(id: string): Promise<void> {
    await this.departures.noteAgentDeleted(id);
  }

  async readSelfAuthId(operation: string): Promise<string | null> {
    return this.dependencies.getSelfAuthId().catch(() => {
      console.warn(`[slate:sharing] self-identity read failed (${operation})`);
      return null;
    });
  }

  async setRoomTyping(roomId: string, isTyping: boolean): Promise<void> {
    if (this.dependencies.isEnabled()) await this.relay.send({ kind: "room-typing", roomId, isTyping });
  }

  prepareForUpgrade(): void {
    this.stop();
  }

  buildManagerDelegate(): { isEnabled(): boolean; publishRoomEntry(roomId: string, entry: PublishableEntry): void } {
    return {
      isEnabled: () => this.dependencies.isEnabled(),
      publishRoomEntry: (roomId, entry) => this.publisher.enqueuePublish(roomId, entry),
    };
  }
}
