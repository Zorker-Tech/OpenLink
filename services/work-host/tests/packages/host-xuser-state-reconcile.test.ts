import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SlateXuserStateReconcile,
  type XuserRoom,
} from "../../source/host/rooms/xuser-state-reconcile.ts";

// ---------------------------------------------------------------------------------------------
// A host that keeps the state a reconciler writes and records what it was asked to do.
// ---------------------------------------------------------------------------------------------

interface HostOptions {
  enabled?: boolean;
  selfAuthId?: string | null;
  readSelfAuthIdResult?: string | null;
  rooms?: XuserRoom[];
  wire?: { pendingJoinRequests: Array<Record<string, unknown>>; rooms: XuserRoom[] };
  fetchThrows?: boolean;
  flushThrows?: boolean;
  abandoned?: string[];
  typing?: Array<{ key: string; roomId: string; authId: string }>;
  profiles?: Record<string, { name: string } | null>;
  avatars?: Record<string, string | undefined>;
  roomAgentIds?: Record<string, string | null>;
  findRoomAgentThrows?: boolean;
  hostedRoomId?: string | null;
  hostedRoomThrowsFor?: string[];
  pushThrows?: boolean;
  addOwnAgentRoom?: XuserRoom;
  setRoomPictureRoom?: XuserRoom;
}

function makeHarness(options: HostOptions = {}) {
  const calls: Array<{ call: string; args: unknown[] }> = [];
  const record = (call: string, ...args: unknown[]) => calls.push({ call, args });
  const disposed: string[] = [];
  const state: { enabled: boolean; selfAuthId: string | null; rooms: XuserRoom[]; pendingJoins: Array<Record<string, unknown>> } = {
    enabled: options.enabled ?? true,
    selfAuthId: options.selfAuthId ?? null,
    rooms: options.rooms ?? [],
    pendingJoins: [],
  };
  const typingUsers = new Map<string, { roomId: string; authId: string }>();
  for (const entry of options.typing ?? []) typingUsers.set(entry.key, { roomId: entry.roomId, authId: entry.authId });
  const typingExpiryHandles = new Map<string, { dispose(): void }>();
  for (const key of typingUsers.keys()) typingExpiryHandles.set(key, { dispose: () => { disposed.push(key); } });
  const departures = {
    isRoomAbandoned: (roomId: string) => (options.abandoned ?? []).includes(roomId),
    flushPendingDepartures: async () => { record("flushPendingDepartures"); if (options.flushThrows === true) throw new Error("flush failed"); },
    pruneRoomTombstones: (ids: ReadonlySet<string>) => { record("pruneRoomTombstones", [...ids]); },
  };
  const host = {
    relay: {
      fetchShareState: async () => {
        record("fetchShareState");
        if (options.fetchThrows === true) throw new Error("relay down");
        return options.wire ?? { pendingJoinRequests: [], rooms: [] };
      },
      addOwnAgent: async (args: unknown) => {
        record("addOwnAgent", args);
        if (options.pushThrows === true) throw new Error("push failed");
        return options.addOwnAgentRoom === undefined ? {} : { room: options.addOwnAgentRoom };
      },
      setRoomPicture: async (args: unknown) => {
        record("setRoomPicture", args);
        if (options.pushThrows === true) throw new Error("push failed");
        return options.setRoomPictureRoom === undefined ? {} : { room: options.setRoomPictureRoom };
      },
    },
    manager: {
      getAgentDisplayProfile: async (id: string) => options.profiles?.[id] ?? null,
      findRoomAgentId: async (roomId: string) => {
        if (options.findRoomAgentThrows === true) throw new Error("find failed");
        return options.roomAgentIds?.[roomId] ?? null;
      },
      ensureMirrorRoom: async (room: unknown, selfAuthId: string) => { record("ensureMirrorRoom", room, selfAuthId); },
      ensureHostedSharedRoom: async (args: unknown) => {
        record("ensureHostedSharedRoom", args);
        const requested = (args as { roomId?: string }).roomId ?? "";
        if ((options.hostedRoomThrowsFor ?? []).includes(requested)) throw new Error("hosted room failed");
        return options.hostedRoomId ?? null;
      },
    },
    isEnabled: () => state.enabled,
    getSelfAuthId: () => state.selfAuthId,
    setSelfAuthId: (id: string | null) => { state.selfAuthId = id; },
    readSelfAuthId: async (operation: string) => { record("readSelfAuthId", operation); return options.readSelfAuthIdResult ?? null; },
    getRooms: () => state.rooms,
    setRooms: (rooms: XuserRoom[]) => { record("setRooms", rooms); state.rooms = rooms; },
    setPendingJoinRequests: (requests: Array<Record<string, unknown>>) => { record("setPendingJoinRequests", requests); state.pendingJoins = requests; },
    typingUsers,
    typingExpiryHandles,
    emit: () => { record("emit"); },
    departures: () => departures,
    agentAvatarPayload: async (agentId: string) => options.avatars?.[agentId],
  };
  return { host, calls, disposed, state, reclaim: () => new SlateXuserStateReconcile(host as never) };
}

const human = (authId: string): { kind: string; authId: string } => ({ kind: "human", authId });
const agent = (authId: string, agentId: string, extra?: Record<string, unknown>) => ({ kind: "agent", authId, agentId, ...extra });
const sharedRoom = (roomId: string, hostAuthId: string, members: unknown[], extra?: Record<string, unknown>): XuserRoom =>
  ({ roomId, name: roomId, hostAuthId, members, ...extra }) as XuserRoom;

const ownRoom = () => sharedRoom("room-1", "self", [human("self"), agent("self", "agent-1", { displayName: "Helper" }), agent("friend", "agent-2", { avatarDataUrl: "data:friend" })]);
const foreignRoom = () => sharedRoom("room-2", "friend", [human("self"), human("friend")]);

describe("installing a room the host learned about", () => {
  it("replaces the room in place and leaves the rest of the list alone", async () => {
    const harness = makeHarness({ selfAuthId: "self", rooms: [sharedRoom("room-1", "self", []), sharedRoom("room-9", "friend", [])] });
    await harness.reclaim().installRoom(ownRoom());
    assert.deepEqual(harness.state.rooms.map((room) => room.roomId), ["room-9", "room-1"]);
    assert.equal(harness.calls.filter((call) => call.call === "emit").length, 1);
  });

  it("never installs a room this host has abandoned", async () => {
    const harness = makeHarness({ selfAuthId: "self", abandoned: ["room-1"] });
    await harness.reclaim().installRoom(ownRoom());
    assert.deepEqual(harness.state.rooms, []);
    assert.equal(harness.calls.some((call) => call.call === "emit"), false);
  });

  it("drops the typing markers the new membership no longer explains, and disposes their timers", async () => {
    const harness = makeHarness({
      selfAuthId: null,
      typing: [
        { key: "kept", roomId: "room-1", authId: "self" },
        { key: "not-a-human", roomId: "room-1", authId: "ghost" },
        { key: "another-room", roomId: "room-9", authId: "friend" },
      ],
    });
    await harness.reclaim().installRoom(ownRoom());
    assert.deepEqual([...harness.host.typingUsers.keys()], ["kept"]);
    assert.deepEqual(harness.disposed.sort(), ["another-room", "not-a-human"]);
  });

  it("materializes the room the way its host role decides", async () => {
    const hosted = makeHarness({ selfAuthId: "self" });
    await hosted.reclaim().installRoom(ownRoom());
    assert.deepEqual(hosted.calls.find((call) => call.call === "ensureHostedSharedRoom")?.args[0], {
      roomId: "room-1",
      name: "room-1",
      localMemberIds: ["agent-1"],
      remoteMembers: [{ ownerAuthId: "friend", agentId: "agent-2", name: "Agent", avatarDataUrl: "data:friend" }],
      isCreationAllowed: false,
    });

    const mirror = makeHarness({ selfAuthId: "self" });
    await mirror.reclaim().installRoom(foreignRoom());
    assert.equal(mirror.calls.some((call) => call.call === "ensureMirrorRoom"), true);

    const outsider = makeHarness({ selfAuthId: "self" });
    await outsider.reclaim().installRoom(sharedRoom("room-3", "friend", [human("friend")]));
    assert.equal(outsider.calls.some((call) => call.call === "ensureMirrorRoom"), false);

    const anonymous = makeHarness({ selfAuthId: null });
    await anonymous.reclaim().installRoom(ownRoom());
    assert.equal(anonymous.calls.some((call) => call.call === "ensureHostedSharedRoom" || call.call === "ensureMirrorRoom"), false);
  });
});

describe("a reconcile pass", () => {
  it("does nothing while sharing is disabled", async () => {
    const harness = makeHarness({ enabled: false });
    await harness.reclaim().reconcileShareState();
    assert.deepEqual(harness.calls, []);
  });

  it("stops when the relay cannot answer, after flushing what was pending", async () => {
    const harness = makeHarness({ selfAuthId: "self", fetchThrows: true });
    await harness.reclaim().reconcileShareState();
    assert.equal(harness.calls.some((call) => call.call === "setRooms"), false);
    assert.equal(harness.calls.some((call) => call.call === "emit"), false);
  });

  it("propagates a failure to flush the pending departures", async () => {
    const harness = makeHarness({ flushThrows: true });
    await assert.rejects(harness.reclaim().reconcileShareState(), { message: "flush failed" });
  });

  it("takes the identity it was missing and applies the report", async () => {
    const wire = {
      pendingJoinRequests: [{ requestId: "r1", nested: { a: 1 } }],
      rooms: [ownRoom(), foreignRoom(), sharedRoom("abandoned", "friend", [])],
    };
    const harness = makeHarness({ selfAuthId: null, readSelfAuthIdResult: "self", wire, abandoned: ["abandoned"] });
    const listedRequests = wire.pendingJoinRequests;
    await harness.reclaim().reconcileShareState();

    assert.deepEqual(harness.calls.find((call) => call.call === "readSelfAuthId")?.args, ["share-state reconcile"]);
    assert.equal(harness.state.selfAuthId, "self");
    assert.deepEqual(harness.state.rooms.map((room) => room.roomId), ["room-1", "room-2"]);
    assert.deepEqual(harness.calls.find((call) => call.call === "pruneRoomTombstones")?.args, [["room-1", "room-2", "abandoned"]], "every room the relay knows is tombstone-free, abandoned or not");
    const pending = harness.state.pendingJoins;
    assert.deepEqual(pending, [{ requestId: "r1", nested: { a: 1 } }]);
    assert.notEqual(pending[0], listedRequests[0], "the host gets its own copies of the report's requests");
    assert.equal(harness.calls.filter((call) => call.call === "emit").length, 1);
  });

  it("prunes typing markers a room no longer explains", async () => {
    const harness = makeHarness({
      selfAuthId: "self",
      wire: { pendingJoinRequests: [], rooms: [ownRoom()] },
      typing: [
        { key: "kept", roomId: "room-1", authId: "self" },
        { key: "gone", roomId: "room-gone", authId: "self" },
        { key: "not-a-human", roomId: "room-1", authId: "ghost" },
      ],
    });
    await harness.reclaim().reconcileShareState();
    assert.deepEqual([...harness.host.typingUsers.keys()], ["kept"]);
  });

  it("runs one pass at a time", async () => {
    const harness = makeHarness({ selfAuthId: "self" });
    const reconcile = harness.reclaim();
    const first = reconcile.reconcileShareState();
    const second = reconcile.reconcileShareState();
    assert.equal(second, first, "a second call while the first is in flight joins it");
    await first;
    await reconcile.reconcileShareState();
    assert.equal(harness.calls.filter((call) => call.call === "fetchShareState").length, 2, "a later call starts a new pass");
  });
});

describe("publishing what the relay should know", () => {
  it("pushes a changed own agent once, then remembers it", async () => {
    const harness = makeHarness({ selfAuthId: "self", rooms: [ownRoom()], profiles: { "agent-1": { name: "Renamed" } }, avatars: { "agent-1": "data:new" } });
    const reconcile = harness.reclaim();
    await reconcile.refreshPublishedProjections();
    await reconcile.refreshPublishedProjections();
    const pushes = harness.calls.filter((call) => call.call === "addOwnAgent");
    assert.equal(pushes.length, 1);
    assert.deepEqual(pushes[0]?.args[0], { roomId: "room-1", agentId: "agent-1", agentName: "Renamed", avatarDataUrl: "data:new" });
    assert.equal(reconcile.publishedProjectionPushes.get("member\0room-1\0agent-1"), "Renamed\0data:new");
  });

  it("installs a room a projection reports back", async () => {
    const reported = sharedRoom("room-9", "self", [human("self")]);
    const harness = makeHarness({ selfAuthId: "self", rooms: [ownRoom()], profiles: { "agent-1": { name: "Renamed" } }, addOwnAgentRoom: reported });
    await harness.reclaim().refreshPublishedProjections();
    assert.equal(harness.state.rooms.some((room) => room.roomId === "room-9"), true, "the room the relay reported back is installed");
  });

  it("pushes an avatar-only change, and a failed push is tried again", async () => {
    const harness = makeHarness({ selfAuthId: "self", rooms: [ownRoom()], profiles: { "agent-1": { name: "Helper" } }, avatars: { "agent-1": "data:new" } });
    const reconcile = harness.reclaim();
    await reconcile.refreshPublishedProjections();
    assert.equal(harness.calls.filter((call) => call.call === "addOwnAgent").length, 1);

    const failing = makeHarness({ selfAuthId: "self", rooms: [ownRoom()], profiles: { "agent-1": { name: "Renamed" } }, pushThrows: true });
    const retrying = failing.reclaim();
    await retrying.refreshPublishedProjections();
    assert.equal(failing.calls.filter((call) => call.call === "addOwnAgent").length, 1);
    assert.equal(retrying.publishedProjectionPushes.size, 0, "a push that failed is not remembered");
  });

  it("pushes the room picture only when it moved, and only for a room of ours", async () => {
    const harness = makeHarness({ selfAuthId: "self", rooms: [ownRoom(), foreignRoom()], profiles: { "agent-1": { name: "Helper" } }, roomAgentIds: { "room-1": "agent-1", "room-2": "agent-9" }, avatars: { "agent-1": "data:new-picture", "agent-9": "data:foreign" } });
    await harness.reclaim().refreshPublishedProjections();
    const pictures = harness.calls.filter((call) => call.call === "setRoomPicture");
    assert.deepEqual(pictures.map((call) => call.args[0]), [{ roomId: "room-1", avatarDataUrl: "data:new-picture" }]);

    const unchanged = makeHarness({ selfAuthId: "self", rooms: [ownRoom()], profiles: { "agent-1": { name: "Helper" } }, roomAgentIds: { "room-1": "agent-1" }, avatars: {} });
    await unchanged.reclaim().refreshPublishedProjections();
    assert.equal(unchanged.calls.some((call) => call.call === "setRoomPicture"), false);

    const lookupFails = makeHarness({ selfAuthId: "self", rooms: [ownRoom()], profiles: { "agent-1": { name: "Helper" } }, findRoomAgentThrows: true });
    await lookupFails.reclaim().refreshPublishedProjections();
    assert.equal(lookupFails.calls.some((call) => call.call === "setRoomPicture"), false, "a room-agent lookup that fails is not fatal");
  });

  it("keeps going when one room's materialization fails", async () => {
    const harness = makeHarness({
      selfAuthId: "self",
      rooms: [sharedRoom("room-bad", "self", [human("self")]), sharedRoom("room-good", "self", [human("self")])],
      hostedRoomThrowsFor: ["room-bad"],
    });
    await harness.reclaim().materializeRooms();
    assert.deepEqual(
      harness.calls.filter((call) => call.call === "ensureHostedSharedRoom").map((call) => (call.args[0] as { roomId: string }).roomId),
      ["room-bad", "room-good"],
      "the second room is still materialized after the first one failed",
    );
  });
});

describe("the per-room work queue", () => {
  it("runs one room's work in order, and one failure does not break the chain", async () => {
    const reconcile = makeHarness().reclaim();
    const order: string[] = [];
    const failing = reconcile.enqueueRoomAgentWork("room-1", async () => { order.push("first"); throw new Error("work failed"); });
    const next = reconcile.enqueueRoomAgentWork("room-1", async () => { order.push("second"); return "ok"; });
    const other = reconcile.enqueueRoomAgentWork("room-2", async () => { order.push("other"); return "other-ok"; });
    await assert.rejects(failing, { message: "work failed" });
    assert.equal(await next, "ok");
    assert.equal(await other, "other-ok");
    assert.deepEqual(order.filter((step) => step !== "other"), ["first", "second"], "one room's work runs in its queue's order");
  });

  it("keeps a settled promise in the queue after its work failed", async () => {
    const reconcile = makeHarness().reclaim();
    const failing = reconcile.enqueueRoomAgentWork("room-1", async () => { throw new Error("work failed"); });
    await assert.rejects(failing, { message: "work failed" });
    const stored = (reconcile as unknown as { roomAgentChains: Map<string, Promise<void>> }).roomAgentChains.get("room-1");
    assert.equal(stored === undefined ? "missing" : await stored.then(() => "settled", () => "rejected"), "settled", "a failure is not left as the room's queued promise");
  });

  it("splits a room into the agents this host runs and the agents it only knows", async () => {
    const harness = makeHarness({ selfAuthId: "self", hostedRoomId: "agent-created" });
    const created = await harness.reclaim().ensureHostedRoom(
      sharedRoom("room-9", "self", [
        human("self"),
        agent("self", "a1"),
        agent("friend", "a2"),
        agent("friend", "a3", { displayName: "Friend's agent", avatarDataUrl: "data:a3" }),
        { kind: "agent", authId: "friend" },
        { kind: "observer", authId: "self", agentId: "not-an-agent" },
      ]) as XuserRoom,
      { isCreationAllowed: true },
    );
    assert.equal(created, "agent-created");
    assert.deepEqual(harness.calls.find((call) => call.call === "ensureHostedSharedRoom")?.args[0], {
      roomId: "room-9",
      name: "room-9",
      localMemberIds: ["a1"],
      remoteMembers: [
        { ownerAuthId: "friend", agentId: "a2", name: "Agent" },
        { ownerAuthId: "friend", agentId: "a3", name: "Friend's agent", avatarDataUrl: "data:a3" },
      ],
      isCreationAllowed: true,
    });
  });
});