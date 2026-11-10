import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
  SLATE_XUSER_ROOM_TOMBSTONE_FILE_NAME,
  SlateXuserRoomTombstoneStore,
  createInMemoryXuserRoomTombstones,
  parseTombstoneFile,
  tombstoneKey,
} from "../../source/host/rooms/xuser-room-tombstone-store.ts";

const roots: string[] = [];
const scratch = (): string => {
  const root = mkdtempSync(join(tmpdir(), "slate-tombstones-"));
  roots.push(root);
  return root;
};
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const stored = (raw: string | null) => [...parseTombstoneFile(raw).entries()];

describe("what a tombstone is filed under", () => {
  it("is the owner it belonged to and the room itself", () => {
    assert.equal(tombstoneKey({ roomId: "r" }), "\u0000r");
    assert.equal(tombstoneKey({ roomId: "r", ownerAuthId: "o" }), "o\u0000r");
    assert.notEqual(tombstoneKey({ roomId: "a\u0000b" }), tombstoneKey({ roomId: "b", ownerAuthId: "a" }), "a room cannot pose as an owner");
  });
});

describe("a file of tombstones", () => {
  it("is read into the tombstones it holds, by their key", () => {
    const read = stored('{"version":1,"tombstones":[{"roomId":"a","ownerAuthId":"o","tornDownAtMs":7},{"roomId":"b"}]}');
    assert.deepEqual(read.map(([key]) => key), ["o\u0000a", "\u0000b"]);
    assert.deepEqual(read[0]?.[1], { roomId: "a", ownerAuthId: "o", tornDownAtMs: 7 });
    assert.deepEqual(read[1]?.[1], { roomId: "b", tornDownAtMs: 0 }, "a moment that was not recorded is zero");
  });

  it("is nothing at all when it is missing, unreadable or of another shape", () => {
    for (const raw of [null, "", "not json", "null", "[]", "{}", '{"tombstones":"no"}']) assert.deepEqual(stored(raw), [], String(raw));
  });

  it("leaves out a tombstone that does not say which room it is", () => {
    const read = stored('{"tombstones":[{"roomId":""},{"roomId":5},null,5,{"roomId":"kept"}]}');
    assert.deepEqual(read.map(([, tombstone]) => (tombstone as { roomId: string }).roomId), ["kept"]);
  });

  it("does not keep an owner that is not a text, and does not keep an empty one", () => {
    assert.deepEqual(stored('{"tombstones":[{"roomId":"a","ownerAuthId":""}]}')[0]?.[1], { roomId: "a", tornDownAtMs: 0 });
    assert.deepEqual(stored('{"tombstones":[{"roomId":"a","ownerAuthId":5}]}')[0]?.[1], { roomId: "a", tornDownAtMs: 0 });
  });
});

describe("a store of tombstones", () => {
  it("remembers a room once, keeping the moment it was first written", () => {
    const store = new SlateXuserRoomTombstoneStore(scratch());
    store.record({ roomId: "a", tornDownAtMs: 1 });
    store.record({ roomId: "a", tornDownAtMs: 2 });
    assert.deepEqual(store.list(), [{ roomId: "a", tornDownAtMs: 1 }]);
  });

  it("writes beside its file and renames over it, so what is on disk is whole", () => {
    const root = scratch();
    const store = new SlateXuserRoomTombstoneStore(root);
    store.record({ roomId: "a", tornDownAtMs: 1 });
    assert.equal(store.filePath, join(root, SLATE_XUSER_ROOM_TOMBSTONE_FILE_NAME));
    const written = JSON.parse(readFileSync(store.filePath, "utf8")) as { version: number; tombstones: unknown[] };
    assert.equal(written.version, 1);
    assert.deepEqual(written.tombstones, [{ roomId: "a", tornDownAtMs: 1 }]);
  });

  it("forgets a room it remembered, and answers the same with or without one", () => {
    const store = new SlateXuserRoomTombstoneStore(scratch());
    store.record({ roomId: "a", tornDownAtMs: 1 });
    store.clear({ roomId: "a" });
    store.clear({ roomId: "never" });
    assert.deepEqual(store.list(), []);
  });

  it("reads what is on disk when it is made, and remembers it from then on", () => {
    const root = scratch();
    const first = new SlateXuserRoomTombstoneStore(root);
    first.record({ roomId: "a", tornDownAtMs: 1 });
    const second = new SlateXuserRoomTombstoneStore(root);
    assert.deepEqual(second.list(), [{ roomId: "a", tornDownAtMs: 1 }]);
    writeFileSync(second.filePath, "not json");
    assert.deepEqual(second.list(), [{ roomId: "a", tornDownAtMs: 1 }], "a file rewritten under it does not change what it read");
  });

  it("keeps the same rules in memory, for a caller with no directory", () => {
    const store = createInMemoryXuserRoomTombstones();
    store.record({ roomId: "a", tornDownAtMs: 1 });
    store.record({ roomId: "a", tornDownAtMs: 2 });
    assert.deepEqual(store.list(), [{ roomId: "a", tornDownAtMs: 2 }], "in memory the last write wins");
    store.clear({ roomId: "a" });
    assert.deepEqual(store.list(), []);
  });
});
