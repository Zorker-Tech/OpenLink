import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ROOM_TOMBSTONE_MIN_RETENTION_MS,
  SlateXuserDepartureObligations,
} from "../../source/host/rooms/xuser-departure-obligations.ts";
import {
  createInMemoryXuserPendingDepartures,
  type XuserDeparture,
} from "../../source/host/rooms/xuser-pending-departure-store.ts";
import {
  createInMemoryXuserRoomTombstones,
} from "../../source/host/rooms/xuser-room-tombstone-store.ts";
import { SlateXuserRelayHttpError } from "../../source/host/rooms/xuser-relay.ts";
import type { XuserDepartureHost } from "../../source/host/rooms/xuser-departure-obligations.ts";

function world() {
  const calls: string[] = [];
  let enabled = true;
  let selfAuthId: string | null = "owner-a";
  let nowMs = 10_000;
  let rooms: Array<{ roomId: string; members: Array<{ kind: string; authId: string; agentId?: string }> }> = [];
  let sharedRoomId: string | null = null;
  let roomAgentIds: string[] = [];
  let readAuth: () => Promise<string | null> = async () => selfAuthId;
  let markRevoked: (roomId: string) => Promise<void> = async () => {};
  let leaveRoom: (roomId: string) => Promise<unknown> = async () => {};
  let removeDeletedAgent: (agentId: string) => Promise<{ rooms: Array<{ roomId: string; members: [] }> }> = async () => ({ rooms: [] });
  let installRoom: (room: { roomId: string; members: [] }) => Promise<void> = async () => {};
  const pending = createInMemoryXuserPendingDepartures();
  const tombstones = createInMemoryXuserRoomTombstones();

  const host = {
    relay: {
      leaveRoom: async (roomId: string) => { calls.push(`leave:${roomId}`); return leaveRoom(roomId); },
      removeDeletedAgent: async (agentId: string) => { calls.push(`remove:${agentId}`); return removeDeletedAgent(agentId); },
    },
    manager: {
      getSharedRoomIdForAgent: async (agentId: string) => { calls.push(`shared:${agentId}`); return sharedRoomId; },
      listRoomAgentIds: async (roomId: string) => { calls.push(`members:${roomId}`); return roomAgentIds; },
      markMirrorRoomRevoked: async (roomId: string) => { calls.push(`revoke:${roomId}`); return markRevoked(roomId); },
    },
    clock: { now: () => nowMs },
    isEnabled: () => enabled,
    getSelfAuthId: () => selfAuthId,
    setSelfAuthId: (id: string) => { selfAuthId = id; calls.push(`set-auth:${id}`); },
    readSelfAuthId: async (operation: string) => { calls.push(`read-auth:${operation}`); return readAuth(); },
    getRooms: () => rooms,
    setRooms: (next: unknown[]) => { rooms = next as typeof rooms; calls.push("set-rooms"); },
    emit: () => { calls.push("emit"); },
    installRoom: async (room: unknown) => { calls.push(`install:${(room as { roomId: string }).roomId}`); return installRoom(room as { roomId: string; members: [] }); },
  } as unknown as XuserDepartureHost;
  const service = new SlateXuserDepartureObligations(host, pending, tombstones);

  return {
    calls,
    host,
    service,
    pending,
    tombstones,
    setEnabled(value: boolean) { enabled = value; },
    setSelfAuthId(value: string | null) { selfAuthId = value; },
    setNow(value: number) { nowMs = value; },
    setRooms(value: typeof rooms) { rooms = value; },
    setSharedRoomId(value: string | null) { sharedRoomId = value; },
    setRoomAgentIds(value: string[]) { roomAgentIds = value; },
    setReadAuth(value: () => Promise<string | null>) { readAuth = value; },
    setMarkRevoked(value: (roomId: string) => Promise<void>) { markRevoked = value; },
    setLeaveRoom(value: (roomId: string) => Promise<unknown>) { leaveRoom = value; },
    setRemoveDeletedAgent(value: (agentId: string) => Promise<{ rooms: Array<{ roomId: string; members: [] }> }>) { removeDeletedAgent = value; },
    setInstallRoom(value: (room: { roomId: string; members: [] }) => Promise<void>) { installRoom = value; },
  };
}

const room = (roomId: string, members: Array<{ kind: string; authId: string; agentId?: string }> = []) => ({ roomId, members });

describe("room departure obligations", () => {
  it("keeps a two-day tombstone retention and does nothing when the extension is off", async () => {
    const current = world();
    current.setEnabled(false);
    assert.equal(ROOM_TOMBSTONE_MIN_RETENTION_MS, 48 * 60 * 60_000);
    await current.service.noteAgentDeleted("agent-a");
    assert.deepEqual(current.calls, []);
    assert.deepEqual(current.pending.list(), []);
  });

  it("reads the current acting identity and caches only an identity that exists", async () => {
    const current = world();
    assert.equal(await current.service.resolveActingAuthId(), "owner-a");
    current.setReadAuth(async () => null);
    assert.equal(await current.service.resolveActingAuthId(), null);
    assert.deepEqual(current.calls, [
      "read-auth:acting-identity resolve", "set-auth:owner-a", "read-auth:acting-identity resolve",
    ]);
    assert.equal(current.service.host.getSelfAuthId(), "owner-a");
  });

  it("records a leave-room departure only when that room has no other agent", async () => {
    const current = world();
    current.setSharedRoomId("room-a");
    current.setRoomAgentIds(["agent-a"]);
    assert.deepEqual(await current.service.resolveDeparture("agent-a", "owner-a"), {
      kind: "leave-room", ownerAuthId: "owner-a", roomId: "room-a", agentId: "agent-a",
    });
    current.setRoomAgentIds(["agent-a", "agent-b"]);
    assert.equal(await current.service.resolveDeparture("agent-a", "owner-a"), null);
  });

  it("treats an empty manager membership list as an all-agent match", async () => {
    const current = world();
    current.setSharedRoomId("room-empty");
    current.setRoomAgentIds([]);
    assert.deepEqual(await current.service.resolveDeparture("agent-a", null), {
      kind: "leave-room", roomId: "room-empty", agentId: "agent-a",
    });
  });

  it("falls back to local membership and requires the acting owner for remove-agent", async () => {
    const current = world();
    current.setRooms([room("private-room", [
      { kind: "agent", authId: "owner-a", agentId: "agent-a" },
      { kind: "user", authId: "owner-a" },
    ])]);
    current.setSharedRoomId(null);
    assert.deepEqual(await current.service.resolveDeparture("agent-a", "owner-a"), {
      kind: "remove-agent", ownerAuthId: "owner-a", agentId: "agent-a",
    });
    assert.equal(await current.service.resolveDeparture("agent-a", null), null);
    assert.equal(await current.service.resolveDeparture("agent-b", "owner-a"), null);
  });

  it("abandons a shared room after a deleted agent leaves and records the owner tombstone", async () => {
    const current = world();
    current.setSharedRoomId("room-a");
    current.setRoomAgentIds(["agent-a"]);
    current.setRooms([room("room-a"), room("other-room")]);
    current.setMarkRevoked(async () => { throw new Error("mirror not available"); });
    await current.service.noteAgentDeleted("agent-a");

    assert.deepEqual(current.calls, [
      "read-auth:acting-identity resolve",
      "set-auth:owner-a",
      "shared:agent-a",
      "members:room-a",
      "revoke:room-a",
      "read-auth:acting-identity resolve",
      "set-auth:owner-a",
      "leave:room-a",
      "set-rooms",
      "emit",
    ]);
    assert.deepEqual(current.pending.list(), []);
    assert.deepEqual(current.tombstones.list(), [{ roomId: "room-a", ownerAuthId: "owner-a", tornDownAtMs: 10_000 }]);
    assert.deepEqual(current.host.getRooms().map((value) => value.roomId), ["other-room"]);
  });

  it("records a private-agent removal and installs each room returned by the relay", async () => {
    const current = world();
    current.setSharedRoomId(null);
    current.setRooms([room("private-room", [{ kind: "agent", authId: "owner-a", agentId: "agent-a" }])]);
    current.setRemoveDeletedAgent(async () => ({ rooms: [room("fresh-a") as never, room("fresh-b") as never] }));
    await current.service.noteAgentDeleted("agent-a");
    assert.deepEqual(current.calls.filter((call) => call.startsWith("install:")), ["install:fresh-a", "install:fresh-b"]);
    assert.deepEqual(current.pending.list(), []);
    assert.deepEqual(current.tombstones.list(), []);
  });

  it("does not read identity when there are no pending departures", async () => {
    const current = world();
    await current.service.flushPendingDepartures();
    assert.deepEqual(current.calls, []);
  });

  it("keeps pending work when the active identity cannot be read", async () => {
    const current = world();
    const pending: XuserDeparture = { kind: "leave-room", ownerAuthId: "owner-a", roomId: "room-a", agentId: "agent-a" };
    current.pending.record(pending);
    current.setReadAuth(async () => null);
    await current.service.flushPendingDepartures();
    assert.deepEqual(current.pending.list(), [pending]);
    assert.equal(current.calls.includes("leave:room-a"), false);
  });

  it("leaves an obligation owned by another account untouched", async () => {
    const current = world();
    const pending: XuserDeparture = { kind: "remove-agent", ownerAuthId: "owner-b", agentId: "agent-a" };
    current.pending.record(pending);
    await current.service.flushPendingDepartures();
    assert.deepEqual(current.pending.list(), [pending]);
    assert.equal(current.calls.some((call) => call.startsWith("remove:")), false);
  });

  it("claims a legacy unowned departure before a failed delivery", async () => {
    const current = world();
    current.pending.record({ kind: "remove-agent", agentId: "agent-a" });
    current.setRemoveDeletedAgent(async () => { throw new Error("relay offline"); });
    await current.service.flushPendingDepartures();
    assert.deepEqual(current.pending.list(), [{ kind: "remove-agent", ownerAuthId: "owner-a", agentId: "agent-a" }]);
  });

  it("treats relay 404 as an acknowledged departure but retains other failures", async () => {
    const current = world();
    current.setLeaveRoom(async () => { throw new SlateXuserRelayHttpError(404, "/rooms/room-a"); });
    assert.equal(await current.service.landDeparture({ kind: "leave-room", roomId: "room-a", agentId: "agent-a" }), true);
    current.setLeaveRoom(async () => { throw new SlateXuserRelayHttpError(503, "/rooms/room-a"); });
    assert.equal(await current.service.landDeparture({ kind: "leave-room", roomId: "room-a", agentId: "agent-a" }), false);
    current.setLeaveRoom(async () => { throw new Error("network down"); });
    assert.equal(await current.service.landDeparture({ kind: "leave-room", roomId: "room-a", agentId: "agent-a" }), false);
  });

  it("only clears tombstones owned by the active account", () => {
    const current = world();
    current.tombstones.record({ roomId: "room-a", ownerAuthId: "owner-a", tornDownAtMs: 1 });
    current.tombstones.record({ roomId: "room-a", ownerAuthId: "owner-b", tornDownAtMs: 2 });
    current.service.clearRoomTombstones("room-a");
    assert.deepEqual(current.tombstones.list(), [{ roomId: "room-a", ownerAuthId: "owner-b", tornDownAtMs: 2 }]);
  });

  it("prunes only owned, absent rooms whose tombstone has reached the retention age", () => {
    const current = world();
    current.setNow(100_000_000);
    current.tombstones.record({ roomId: "old", ownerAuthId: "owner-a", tornDownAtMs: 100_000_000 - ROOM_TOMBSTONE_MIN_RETENTION_MS });
    current.tombstones.record({ roomId: "young", ownerAuthId: "owner-a", tornDownAtMs: 100_000_000 - ROOM_TOMBSTONE_MIN_RETENTION_MS + 1 });
    current.tombstones.record({ roomId: "present", ownerAuthId: "owner-a", tornDownAtMs: 0 });
    current.tombstones.record({ roomId: "other-owner", ownerAuthId: "owner-b", tornDownAtMs: 0 });
    current.service.pruneRoomTombstones(new Set(["present"]));
    assert.deepEqual(current.tombstones.list().map(({ roomId }) => roomId).sort(), ["other-owner", "present", "young"]);
  });

  it("tracks owed or tombstoned rooms only for the active owner", () => {
    const current = world();
    current.pending.record({ kind: "leave-room", roomId: "owed", agentId: "agent-a" });
    current.tombstones.record({ roomId: "tombstoned", ownerAuthId: "owner-a", tornDownAtMs: 0 });
    current.tombstones.record({ roomId: "foreign", ownerAuthId: "owner-b", tornDownAtMs: 0 });
    assert.equal(current.service.isDepartureOwed("owed"), true);
    assert.equal(current.service.isRoomAbandoned("owed"), true);
    assert.equal(current.service.isRoomAbandoned("tombstoned"), true);
    assert.equal(current.service.isRoomAbandoned("foreign"), false);
  });

  it("prevents overlapping flushes of the same pending batch", async () => {
    const current = world();
    current.pending.record({ kind: "leave-room", ownerAuthId: "owner-a", roomId: "room-a", agentId: "agent-a" });
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    current.setLeaveRoom(async () => { started.resolve(); await release.promise; });

    const first = current.service.flushPendingDepartures();
    await started.promise;
    await current.service.flushPendingDepartures();
    assert.equal(current.calls.filter((call) => call === "leave:room-a").length, 1);
    release.resolve();
    await first;
    assert.deepEqual(current.pending.list(), []);
  });
});
