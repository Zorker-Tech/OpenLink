/**
 * Catching the host up with the shared state that lives elsewhere.
 *
 * What the relay reports — rooms, pending joins, the host's own agents — is reconciled against what is known
 * locally: rooms that are gone are pruned, departures that were never delivered are flushed, and a room the host
 * has no agent in gets one.
 */
interface RoomMember { kind: string; authId: string; agentId?: string; displayName?: string; avatarDataUrl?: string }
export interface XuserRoom { roomId: string; name: string; hostAuthId: string; members: RoomMember[]; avatarDataUrl?: string }
interface DepartureFacade { isRoomAbandoned(roomId: string): boolean; flushPendingDepartures(): Promise<void>; pruneRoomTombstones(ids: ReadonlySet<string>): void }

/** What the relay offers: the report a pass works from, and the two pushes a projection makes. */
interface XuserRelayFacade {
  fetchShareState(): Promise<{ pendingJoinRequests: Array<Record<string, unknown>>; rooms: XuserRoom[] }>;
  addOwnAgent(args: unknown): Promise<{ room?: XuserRoom }>;
  setRoomPicture(args: unknown): Promise<{ room?: XuserRoom }>;
}

/** What the room manager offers: profiles, the room's own agent, and the two ways to materialize a room. */
interface XuserManagerFacade {
  getAgentDisplayProfile(id: string): Promise<{ name: string } | null>;
  findRoomAgentId(roomId: string): Promise<string | null>;
  ensureMirrorRoom(room: XuserRoom, selfAuthId: string): Promise<void>;
  ensureHostedSharedRoom(args: unknown): Promise<string | null>;
}

/** The host's own identity and room list, which a pass reads and replaces. */
interface XuserLocalState {
  isEnabled(): boolean;
  getSelfAuthId(): string | null;
  setSelfAuthId(id: string | null): void;
  readSelfAuthId(operation: string): Promise<string | null>;
  getRooms(): XuserRoom[];
  setRooms(rooms: XuserRoom[]): void;
  setPendingJoinRequests(requests: Array<Record<string, unknown>>): void;
  emit(): void;
}

/** The typing markers shared with the host, and what dismisses one. */
interface XuserTypingState {
  typingUsers: Map<string, { roomId: string; authId: string }>;
  typingExpiryHandles: Map<string, { dispose(): void }>;
}

/** Everything a reconciler may use from its host. */
export interface XuserStateReconcileHost extends XuserLocalState, XuserTypingState {
  relay: XuserRelayFacade;
  manager: XuserManagerFacade;
  departures(): DepartureFacade;
  agentAvatarPayload(agentId: string): Promise<string | undefined>;
}

/** Whether a room has this person in it. */
function hasHumanMember(sharedRoom: XuserRoom, authId: string): boolean {
  return sharedRoom.members.some((participant) => participant.kind === "human" && participant.authId === authId);
}

/** Whether an agent belongs to this host's own identity. */
function isOwnAgent(participant: RoomMember, ownAuthId: string): boolean {
  return participant.kind === "agent" && participant.authId === ownAuthId && participant.agentId != null;
}

/** The wire report a pass works from. */
type ShareStateReport = Awaited<ReturnType<XuserRelayFacade["fetchShareState"]>>;

/** A person typing, as the host map keys and describes it. */
interface TypingUser { roomId: string; authId: string }

export class SlateXuserStateReconcile {
  readonly publishedProjectionPushes = new Map<string, string>();
  private reconcileInFlight: Promise<void> | null = null;
  private readonly roomAgentChains = new Map<string, Promise<void>>();
  constructor(readonly host: XuserStateReconcileHost) {}

  /** Drops the typing markers a changed membership no longer explains. */
  private pruneTypingUsers(keep: (user: TypingUser) => boolean): void {
    for (const [key, user] of this.host.typingUsers) {
      if (keep(user)) continue;
      this.host.typingUsers.delete(key);
      this.host.typingExpiryHandles.get(key)?.dispose();
      this.host.typingExpiryHandles.delete(key);
    }
  }

  /** Whose typing markers the room list still explains: a known room with that person still in it. */
  private typingIsExplained(user: TypingUser): boolean {
    const known = this.host.getRooms().find((candidate) => candidate.roomId === user.roomId);
    return known !== undefined && hasHumanMember(known, user.authId);
  }

  private replaceRoom(incoming: XuserRoom): void {
    this.host.setRooms([...this.host.getRooms().filter((candidate) => candidate.roomId !== incoming.roomId), incoming]);
  }

  async installRoom(incoming: XuserRoom): Promise<void> {
    if (this.host.departures().isRoomAbandoned(incoming.roomId)) return;
    this.replaceRoom(incoming);
    this.pruneTypingUsers((user) => user.roomId === incoming.roomId && hasHumanMember(incoming, user.authId));
    await this.materializeRoom(incoming);
    this.host.emit();
  }

  reconcileShareState(): Promise<void> {
    if (this.reconcileInFlight != null) return this.reconcileInFlight;
    const pass = this.runReconcilePass().finally(() => {
      this.reconcileInFlight = null;
    });
    this.reconcileInFlight = pass;
    return pass;
  }

  /** Fetch the relay's report, or nothing when it could not answer this time. */
  private async fetchShareStateOrNothing(): Promise<ShareStateReport | null> {
    try {
      return await this.host.relay.fetchShareState();
    } catch {
      return null;
    }
  }

  /** The host's identity, read once and remembered, because a later pass may arrive without it. */
  private async ensureSelfAuthId(): Promise<void> {
    if (this.host.getSelfAuthId() != null) return;
    this.host.setSelfAuthId(await this.host.readSelfAuthId("share-state reconcile"));
  }

  /** The pending joins, as this pass's own copies so the report cannot be changed under the host. */
  private applyPendingJoins(report: ShareStateReport): void {
    this.host.setPendingJoinRequests(report.pendingJoinRequests.map((request) => ({ ...request })));
  }

  /** The room list, with the rooms this host has already abandoned left out. */
  private applyRoomList(rooms: readonly XuserRoom[]): void {
    this.host.setRooms(rooms.filter((candidate) => !this.host.departures().isRoomAbandoned(candidate.roomId)));
  }

  /** Every room the relay still knows, abandoned or not, is a room whose tombstone is no longer needed. */
  private pruneTombstonesFor(rooms: readonly XuserRoom[]): void {
    this.host.departures().pruneRoomTombstones(new Set(rooms.map((candidate) => candidate.roomId)));
  }

  async runReconcilePass(): Promise<void> {
    if (!this.host.isEnabled()) return;
    await this.host.departures().flushPendingDepartures();
    const report = await this.fetchShareStateOrNothing();
    if (report === null) return;
    await this.ensureSelfAuthId();
    this.applyPendingJoins(report);
    this.applyRoomList(report.rooms);
    this.pruneTombstonesFor(report.rooms);
    this.pruneTypingUsers((user) => this.typingIsExplained(user));
    await this.materializeRooms();
    await this.refreshPublishedProjections();
    this.host.emit();
  }

  async refreshPublishedProjections(): Promise<void> {
    const ownAuthId = this.host.getSelfAuthId();
    if (ownAuthId == null) return;
    for (const sharedRoom of this.host.getRooms()) {
      await this.refreshOwnAgentProjections(sharedRoom, ownAuthId);
      await this.refreshRoomPictureProjection(sharedRoom, ownAuthId);
    }
  }

  /** The name and avatar an own agent reports to the relay, pushed only when one of them moved. */
  private async refreshOwnAgentProjections(sharedRoom: XuserRoom, ownAuthId: string): Promise<void> {
    for (const participant of sharedRoom.members) {
      if (!isOwnAgent(participant, ownAuthId)) continue;
      const liveName = await this.changedDisplayName(participant);
      const liveAvatar = await this.changedAvatar(participant);
      if (liveName === undefined && liveAvatar === undefined) continue;
      const agentName = liveName ?? participant.displayName ?? "Agent";
      const avatarDataUrl = liveAvatar ?? participant.avatarDataUrl;
      await this.pushProjectionOnce({
        pushKey: `member\0${sharedRoom.roomId}\0${participant.agentId}`,
        payload: `${agentName}\0${avatarDataUrl ?? ""}`,
        push: () => this.host.relay.addOwnAgent({ roomId: sharedRoom.roomId, agentId: participant.agentId, agentName, ...(avatarDataUrl == null ? {} : { avatarDataUrl }) }),
      });
    }
  }

  private async changedDisplayName(participant: RoomMember): Promise<string | undefined> {
    const profile = await this.host.manager.getAgentDisplayProfile(participant.agentId as string);
    return profile != null && profile.name !== participant.displayName ? profile.name : undefined;
  }

  private async changedAvatar(participant: RoomMember): Promise<string | undefined> {
    const avatar = await this.host.agentAvatarPayload(participant.agentId as string);
    return avatar != null && avatar !== participant.avatarDataUrl ? avatar : undefined;
  }

  /** The picture a room carries for its own agent, pushed only when it moved. */
  private async refreshRoomPictureProjection(sharedRoom: XuserRoom, ownAuthId: string): Promise<void> {
    if (sharedRoom.hostAuthId !== ownAuthId) return;
    const roomAgentId = await this.host.manager.findRoomAgentId(sharedRoom.roomId).catch(() => null);
    if (roomAgentId == null) return;
    const avatar = await this.host.agentAvatarPayload(roomAgentId);
    if (avatar == null || avatar === sharedRoom.avatarDataUrl) return;
    await this.pushProjectionOnce({
      pushKey: `room\0${sharedRoom.roomId}`,
      payload: avatar,
      push: () => this.host.relay.setRoomPicture({ roomId: sharedRoom.roomId, avatarDataUrl: avatar }),
    });
  }

  /** One push per key, and only when what would travel changed; a failed push is retried next pass. */
  async pushProjectionOnce(request: { pushKey: string; payload: string; push(): Promise<{ room?: XuserRoom }> }): Promise<void> {
    if (this.publishedProjectionPushes.get(request.pushKey) === request.payload) return;
    try {
      const pushed = await request.push();
      this.publishedProjectionPushes.set(request.pushKey, request.payload);
      if (pushed.room != null) await this.installRoom(pushed.room);
    } catch {
      // A projection that could not be pushed is tried again by the next pass.
    }
  }

  async materializeRooms(): Promise<void> {
    for (const sharedRoom of this.host.getRooms()) {
      try {
        await this.materializeRoom(sharedRoom);
      } catch {
        // One room that cannot be materialized must not stop the others.
      }
    }
  }

  /** The work for one room runs in the order it was queued; one failure does not break the chain. */
  enqueueRoomAgentWork<T>(roomId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.roomAgentChains.get(roomId) ?? Promise.resolve();
    const run = Promise.allSettled([previous]).then(work);
    this.roomAgentChains.set(roomId, run.then(() => {}, () => {}));
    return run;
  }

  materializeRoom(sharedRoom: XuserRoom): Promise<void> {
    return this.enqueueRoomAgentWork(sharedRoom.roomId, () => this.materializeRoomNow(sharedRoom));
  }

  /** What a room needs locally: a hosted room of our own, or a mirror of somebody else's. */
  async materializeRoomNow(sharedRoom: XuserRoom): Promise<void> {
    const ownAuthId = this.host.getSelfAuthId();
    if (ownAuthId == null || this.host.departures().isRoomAbandoned(sharedRoom.roomId)) return;
    if (sharedRoom.hostAuthId === ownAuthId) {
      await this.ensureHostedRoom(sharedRoom, { isCreationAllowed: false });
      return;
    }
    if (hasHumanMember(sharedRoom, ownAuthId)) await this.host.manager.ensureMirrorRoom(sharedRoom, ownAuthId);
  }

  mintLocalRoomAgent(sharedRoom: XuserRoom): Promise<string | null> {
    return this.enqueueRoomAgentWork(sharedRoom.roomId, () => this.ensureHostedRoom(sharedRoom, { isCreationAllowed: true }));
  }

  /** The room split into the agents this host runs and the agents it only knows by their owners. */
  ensureHostedRoom(sharedRoom: XuserRoom, options: { isCreationAllowed: boolean }): Promise<string | null> {
    const ownAuthId = this.host.getSelfAuthId() ?? "";
    const localMemberIds: string[] = [];
    const remoteMembers: Array<Record<string, unknown>> = [];
    for (const participant of sharedRoom.members) {
      if (participant.kind !== "agent" || participant.agentId == null) continue;
      if (participant.authId === ownAuthId) localMemberIds.push(participant.agentId);
      else remoteMembers.push(this.remoteMemberRecord(participant));
    }
    return this.host.manager.ensureHostedSharedRoom({ roomId: sharedRoom.roomId, name: sharedRoom.name, localMemberIds, remoteMembers, isCreationAllowed: options.isCreationAllowed });
  }

  /** An agent owned by somebody else, as the hosted-room call names it. */
  private remoteMemberRecord(participant: RoomMember): Record<string, unknown> {
    return {
      ownerAuthId: participant.authId,
      agentId: participant.agentId,
      name: participant.displayName ?? "Agent",
      ...(participant.avatarDataUrl == null ? {} : { avatarDataUrl: participant.avatarDataUrl }),
    };
  }
}