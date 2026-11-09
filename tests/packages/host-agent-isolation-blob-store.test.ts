/**
 * The blobs one conversation keeps: reading and writing them by content id, adopting an older database once, what may
 * be collected and what a root with unresolved references holds back, and what the store does once it is closed.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { ConversationBlobStoreDb } from "../../source/host/agents/isolation/conversation-blob-store.ts";
import { CONVERSATION_BLOB_ADOPTION_COMPLETE, CONVERSATION_BLOB_SCHEMA } from "../../source/host/agents/isolation/conversation-blob-db.ts";
import { ConversationStateStructure } from "../../source/adapters/interop/proto/generated/agent/v1/agent_pb.ts";
import { encodeInteropAgentConversationCheckpoint } from "../../source/adapters/interop/agent/agent-conversation-protobuf-adapter.ts";
import { createSlateAgentConversationTurn } from "../../source/packages/agent/conversation-turn-state.ts";
import { slateConversationTurnSerde } from "../../source/adapters/interop/agent/agent-conversation-state-serdes-adapter.ts";

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
const sha = (bytes: Uint8Array): Uint8Array => createHash("sha256").update(bytes).digest();
const bytesOf = (fill: number, length = 32): Uint8Array => new Uint8Array(length).fill(fill);

/** A store of its own, over a real database in a fresh directory. */
function storeWorld(options: { legacy?: "rows" | "garbage" } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "slate-blob-store-"));
  const blobDbPath = join(directory, "conversation-blobs.db");
  const logs: string[] = [];
  let legacyBlobDbPath: string | undefined;
  if (options.legacy !== undefined) {
    legacyBlobDbPath = join(directory, "legacy-blobs.db");
    if (options.legacy === "rows") {
      const legacy = new DatabaseSync(legacyBlobDbPath);
      legacy.exec(CONVERSATION_BLOB_SCHEMA);
      legacy.prepare("INSERT INTO blobs (id, data) VALUES (?, ?)").run(hex(bytesOf(7)), Uint8Array.from([7, 7, 7]));
      legacy.close();
    } else writeFileSync(legacyBlobDbPath, "not a database");
  }
  const store = new ConversationBlobStoreDb({
    agentId: "agent-1",
    blobDbPath,
    busyTimeoutMs: 250,
    ...(legacyBlobDbPath === undefined ? {} : { legacyBlobDbPath }),
    log: (message) => logs.push(message),
  });
  return {
    store, directory, blobDbPath, logs,
    rows: () => store.scanBlobIndexStmt.all() as Array<{ id: string; len: number }>,
    version: () => (store.db.prepare("PRAGMA user_version").get() as { user_version?: number }).user_version,
  };
}

/** A checkpoint root over the turn ids it names. */
function checkpointRoot(turnIds: Uint8Array[]) {
  const rootBytes = new ConversationStateStructure({ turns: turnIds }).toBinary();
  return { rootBytes, rootId: sha(rootBytes) };
}

/** A turn blob the garbage walk can actually resolve, kept under the id its bytes hash to. */
function turnBlob() {
  const turnBytes = slateConversationTurnSerde.serialize(createSlateAgentConversationTurn({
    userMessageBlobId: new Uint8Array(),
    stepBlobIds: [],
    sendMessageStepIndices: [],
  }));
  return { turnBytes, turnId: sha(turnBytes) };
}

describe("what the store keeps", () => {
  it("reads and writes blobs by their content id, and forgets them when told to", () => {
    const world = storeWorld();
    const id = bytesOf(1);
    assert.equal(world.store.getBlob(id), undefined);
    world.store.setBlob(id, Uint8Array.from([1, 2, 3]));
    assert.deepEqual(Array.from(world.store.getBlob(id) ?? []), [1, 2, 3]);
    // Writing the same id again replaces what was there rather than failing.
    world.store.setBlob(id, Uint8Array.from([9]));
    assert.deepEqual(Array.from(world.store.getBlob(id) ?? []), [9]);
    assert.deepEqual(world.rows().map((row) => [row.len, typeof row.id]), [[1, "string"]]);
    world.store.clearBlobs();
    assert.deepEqual([world.rows().length, world.store.getBlob(id)], [0, undefined]);
    world.store.close();
  });

  it("reads a content id from only the view a caller passed", () => {
    const world = storeWorld();
    const padded = Uint8Array.from([99, ...bytesOf(7), 88]);
    const idView = padded.subarray(1, 33);
    const data = Uint8Array.from([3, 2, 1]);
    world.store.setBlob(idView, data);
    assert.deepEqual(Array.from(world.store.getBlob(bytesOf(7)) ?? []), [3, 2, 1]);
    assert.equal(world.rows()[0]?.id, hex(bytesOf(7)));
    world.store.close();
  });

  it("answers nothing at all once it is closed", () => {
    const world = storeWorld();
    world.store.setBlob(bytesOf(1), Uint8Array.from([1]));
    world.store.close();
    assert.equal(world.store.isClosed, true);
    assert.equal(world.store.getBlob(bytesOf(1)), undefined);
    world.store.setBlob(bytesOf(2), Uint8Array.from([2]));
    world.store.clearBlobs();
    assert.equal(world.store.findLatestRootBlobId(), undefined);
    assert.equal(world.store.clearStaleCheckpointRoots(hex(bytesOf(1))), 0);
    assert.deepEqual(world.store.collectGarbage({ retainedRootIdHex: hex(bytesOf(1)), pendingWriteRetentionMs: 0 }), {
      outcome: "skipped",
      reason: "no-root",
    });
    assert.deepEqual(world.store.verifyLegacyBlobRetirement(hex(bytesOf(1)), "/tmp/legacy.db"), {
      isRetirable: false,
      reason: "store-closed",
      legacyRows: 0,
      legacyBytes: 0,
    });
    // Closing twice is the same as closing once, and what was written stays written.
    assert.doesNotThrow(() => world.store.close());
    const check = new DatabaseSync(world.blobDbPath);
    assert.equal((check.prepare("SELECT count(*) AS count FROM blobs").get() as { count: number }).count, 1);
    check.close();
  });

  it("remembers what was written recently, in the order it was written", () => {
    const world = storeWorld();
    world.store.setBlob(bytesOf(1), Uint8Array.from([1]));
    world.store.setBlob(bytesOf(2), Uint8Array.from([2]));
    assert.deepEqual([...world.store.recentWriteMsByHexId.keys()], [hex(bytesOf(1)), hex(bytesOf(2))]);
    // Writing an id again moves it to the end rather than leaving a stale entry behind.
    world.store.setBlob(bytesOf(1), Uint8Array.from([1, 1]));
    assert.deepEqual([...world.store.recentWriteMsByHexId.keys()], [hex(bytesOf(2)), hex(bytesOf(1))]);
    // The bookkeeping is bounded, so a conversation that writes a great deal does not remember all of it forever: the
    // oldest entry goes when the next one arrives.
    const bound = 16_384;
    world.store.recentWriteMsByHexId.clear();
    for (let index = 0; index < bound; index += 1) world.store.recentWriteMsByHexId.set(`tracked-${index}`, 1);
    world.store.setBlob(bytesOf(3), Uint8Array.from([3]));
    assert.deepEqual(
      [world.store.recentWriteMsByHexId.size, world.store.recentWriteMsByHexId.has("tracked-0"), world.store.recentWriteMsByHexId.has(hex(bytesOf(3)))],
      [bound, false, true],
    );
    world.store.close();
  });
});

describe("adopting what was written before this store existed", () => {
  it("keeps what the conversation already has when the older file holds the same id", () => {
    const directory = mkdtempSync(join(tmpdir(), "slate-blob-store-conflict-"));
    const blobDbPath = join(directory, "conversation-blobs.db");
    const id = bytesOf(7);
    // The conversation already has a blob under this id; the older file has a different one under the same id.
    const existing = new DatabaseSync(blobDbPath);
    existing.exec(CONVERSATION_BLOB_SCHEMA);
    existing.prepare("INSERT INTO blobs (id, data) VALUES (?, ?)").run(hex(id), Uint8Array.from([1, 1, 1]));
    existing.close();
    const legacyPath = join(directory, "legacy-blobs.db");
    const legacy = new DatabaseSync(legacyPath);
    legacy.exec(CONVERSATION_BLOB_SCHEMA);
    legacy.prepare("INSERT INTO blobs (id, data) VALUES (?, ?)").run(hex(id), Uint8Array.from([2, 2, 2]));
    legacy.close();
    const store = new ConversationBlobStoreDb({ agentId: "agent-1", blobDbPath, busyTimeoutMs: 250, legacyBlobDbPath: legacyPath, log: () => {} });
    assert.deepEqual(Array.from(store.getBlob(id) ?? []), [1, 1, 1]);
    store.close();
  });

  it("takes an older database's blobs once, and says the conversation was adopted", () => {
    const world = storeWorld({ legacy: "rows" });
    assert.deepEqual(world.rows().map((row) => row.id), [hex(bytesOf(7))]);
    assert.deepEqual(Array.from(world.store.getBlob(bytesOf(7)) ?? []), [7, 7, 7]);
    assert.equal(world.version(), CONVERSATION_BLOB_ADOPTION_COMPLETE);
    assert.deepEqual(world.logs, []);
    world.store.close();
    // A store whose conversation is already adopted leaves the older file alone, even when something new was written
    // into it in the meantime.
    const legacyPath = join(world.directory, "legacy-blobs.db");
    const later = new DatabaseSync(legacyPath);
    later.prepare("INSERT INTO blobs (id, data) VALUES (?, ?)").run(hex(bytesOf(8)), Uint8Array.from([8]));
    later.close();
    const adopted = new ConversationBlobStoreDb({
      agentId: "agent-1",
      blobDbPath: world.blobDbPath,
      busyTimeoutMs: 250,
      legacyBlobDbPath: legacyPath,
      log: (message) => world.logs.push(message),
    });
    assert.deepEqual(adopted.scanBlobIndexStmt.all().map((row) => row.id), [hex(bytesOf(7))]);
    assert.equal(adopted.getBlob(bytesOf(8)), undefined);
    assert.deepEqual(world.logs, []);
    adopted.close();
  });

  it("says so when an older database cannot be adopted, and leaves the state as it was", () => {
    const world = storeWorld({ legacy: "garbage" });
    assert.deepEqual(world.logs.length, 1);
    assert.match(String(world.logs[0]), /legacy blob adoption failed/);
    assert.equal(world.version(), 0);
    world.store.close();
  });
});

describe("what may be collected", () => {
  it("collects what nothing points at, and keeps what was written a moment ago", () => {
    const world = storeWorld();
    const { rootBytes, rootId } = checkpointRoot([]);
    world.store.setBlob(rootId, rootBytes);
    world.store.setBlob(bytesOf(4), Uint8Array.from([4, 4, 4, 4, 4, 4, 4, 4]));
    // The root is kept, the unreferenced blob is not; the deletion is most of what is left, so it is worth vacuuming.
    const collected = world.store.collectGarbage({ retainedRootIdHex: hex(rootId), pendingWriteRetentionMs: 0 });
    assert.deepEqual(collected, {
      outcome: "collected",
      deletedRows: 1,
      deletedBytes: 8,
      liveRows: 1,
      liveBytes: rootBytes.length,
      retainedPendingRows: 0,
      vacuumed: true,
    });
    assert.deepEqual(world.rows().map((row) => row.id), [hex(rootId)]);
    world.store.close();
    // A blob written within the retention window is kept even though nothing points at it.
    const retained = storeWorld();
    const root = checkpointRoot([]);
    retained.store.setBlob(root.rootId, root.rootBytes);
    retained.store.setBlob(bytesOf(5), Uint8Array.from([5, 5]));
    const held = retained.store.collectGarbage({ retainedRootIdHex: hex(root.rootId), pendingWriteRetentionMs: 60 * 60_000 });
    assert.deepEqual([held.outcome, held.deletedRows, held.retainedPendingRows, held.liveRows], ["collected", 0, 1, 2]);
    retained.store.close();
  });

  it("keeps what the root reaches and collects what it does not", () => {
    const world = storeWorld();
    const { turnBytes, turnId } = turnBlob();
    world.store.setBlob(turnId, turnBytes);
    const { rootBytes, rootId } = checkpointRoot([turnId]);
    world.store.setBlob(rootId, rootBytes);
    world.store.setBlob(bytesOf(4), Uint8Array.from([4, 4]));
    const collected = world.store.collectGarbage({ retainedRootIdHex: hex(rootId), pendingWriteRetentionMs: 0 });
    assert.deepEqual([collected.outcome, collected.deletedRows, collected.liveRows], ["collected", 1, 2]);
    assert.deepEqual(world.rows().map((row) => row.id).sort(), [hex(rootId), hex(turnId)].sort());
    assert.equal(world.store.getBlob(bytesOf(4)), undefined);
    world.store.close();
  });

  it("keeps turn blobs reached from a Slate checkpoint root", () => {
    const world = storeWorld();
    const { turnBytes, turnId } = turnBlob();
    world.store.setBlob(turnId, turnBytes);
    const rootBytes = encodeInteropAgentConversationCheckpoint(new ConversationStateStructure({ turns: [turnId] }));
    const rootId = sha(rootBytes);
    world.store.setBlob(rootId, rootBytes);
    world.store.setBlob(bytesOf(4), Uint8Array.from([4, 4]));

    const collected = world.store.collectGarbage({ retainedRootIdHex: hex(rootId), pendingWriteRetentionMs: 0 });
    assert.deepEqual([collected.outcome, collected.deletedRows, collected.liveRows], ["collected", 1, 2]);
    assert.deepEqual(world.rows().map((row) => row.id).sort(), [hex(rootId), hex(turnId)].sort());
    world.store.close();
  });

  it("expires a pending write at the exact retention boundary", () => {
    const originalNow = Date.now;
    let now = 1_000;
    Date.now = () => now;
    try {
      const world = storeWorld();
      const { rootBytes, rootId } = checkpointRoot([]);
      world.store.setBlob(rootId, rootBytes);
      world.store.setBlob(bytesOf(6), Uint8Array.from([6]));
      now = 1_001;
      world.store.setBlob(bytesOf(7), Uint8Array.from([7]));

      now = 2_000;
      const result = world.store.collectGarbage({ retainedRootIdHex: hex(rootId), pendingWriteRetentionMs: 1_000 });
      assert.deepEqual([result.outcome, result.deletedRows, result.retainedPendingRows], ["collected", 1, 1]);
      assert.equal(world.store.getBlob(bytesOf(6)), undefined);
      assert.deepEqual(Array.from(world.store.getBlob(bytesOf(7)) ?? []), [7]);
      world.store.close();
    } finally {
      Date.now = originalNow;
    }
  });

  it("holds back when the root is missing, unreadable or points at something that is not there", () => {
    const world = storeWorld();
    // No blob for the root the caller named.
    assert.deepEqual(world.store.collectGarbage({ retainedRootIdHex: hex(bytesOf(9)), pendingWriteRetentionMs: 0 }), { outcome: "skipped", reason: "no-root" });
    // A root that cannot be read as the structure it claims to be.
    const garbageId = sha(Uint8Array.from([255, 254, 253]));
    world.store.setBlob(garbageId, Uint8Array.from([255, 254, 253]));
    assert.deepEqual(world.store.collectGarbage({ retainedRootIdHex: hex(garbageId), pendingWriteRetentionMs: 0 }), { outcome: "skipped", reason: "root-undecodable" });
    // A root whose references do not all resolve is left alone rather than collected from.
    const { rootBytes, rootId } = checkpointRoot([bytesOf(9)]);
    world.store.setBlob(rootId, rootBytes);
    const unresolved = world.store.collectGarbage({ retainedRootIdHex: hex(rootId), pendingWriteRetentionMs: 0 });
    assert.deepEqual([unresolved.outcome, unresolved.reason, unresolved.unresolvedProtoRefs], ["skipped", "unresolved-refs", 1]);
    assert.equal(world.rows().length >= 2, true);
    world.store.close();
  });
});

describe("what may be cleared and checked", () => {
  it("clears an older checkpoint root, and keeps the one the conversation is on", () => {
    const world = storeWorld();
    const turnBytes = Uint8Array.from([1, 2, 3]);
    const turnId = sha(turnBytes);
    world.store.setBlob(turnId, turnBytes);
    const older = checkpointRoot([turnId]);
    const newer = checkpointRoot([turnId, sha(Uint8Array.from([4]))]);
    world.store.setBlob(older.rootId, older.rootBytes);
    world.store.setBlob(newer.rootId, newer.rootBytes);
    // The older root is a valid checkpoint, so it is cleared; the one in use is not.
    assert.equal(world.store.clearStaleCheckpointRoots(hex(newer.rootId)), 1);
    assert.deepEqual([world.store.getBlob(older.rootId), world.store.getBlob(newer.rootId) !== undefined], [undefined, true]);
    // Nothing else is stale.
    assert.equal(world.store.clearStaleCheckpointRoots(hex(newer.rootId)), 0);
    // A blob whose id is not the hash of its own bytes is not a checkpoint, even when what it holds looks exactly like
    // one: only content that names itself may be cleared.
    const misnamed = bytesOf(3);
    world.store.setBlob(misnamed, checkpointRoot([turnId]).rootBytes);
    assert.equal(world.store.clearStaleCheckpointRoots(hex(newer.rootId)), 0);
    assert.equal(world.store.getBlob(misnamed) !== undefined, true);
    world.store.close();
  });

  it("keeps checkpoint candidates with no turns or a malformed turn id", () => {
    const world = storeWorld();
    const empty = checkpointRoot([]);
    const malformedTurn = Uint8Array.from([3, 4]);
    const malformed = checkpointRoot([malformedTurn]);
    world.store.setBlob(empty.rootId, empty.rootBytes);
    world.store.setBlob(malformedTurn, Uint8Array.from([1, 2, 3]));
    world.store.setBlob(malformed.rootId, malformed.rootBytes);

    assert.equal(world.store.clearStaleCheckpointRoots(hex(bytesOf(99))), 0);
    assert.notEqual(world.store.getBlob(empty.rootId), undefined);
    assert.notEqual(world.store.getBlob(malformed.rootId), undefined);
    world.store.close();
  });

  it("finds the root the conversation is on, and hands the retirement question to the database", () => {
    const world = storeWorld({ legacy: "rows" });
    const turnBytes = Uint8Array.from([1, 2, 3]);
    const turnId = sha(turnBytes);
    world.store.setBlob(turnId, turnBytes);
    const { rootBytes, rootId } = checkpointRoot([turnId]);
    world.store.setBlob(rootId, rootBytes);
    // The root comes back as bytes of the same id, whatever kind of byte array either side happens to be.
    assert.equal(hex(world.store.findLatestRootBlobId() ?? new Uint8Array()), hex(rootId));
    // The store's own retirement check is the database's, once the store itself is open — and since the store adopted
    // the older file when it opened, the older file can now be retired, counted as what it holds.
    const verdict = world.store.verifyLegacyBlobRetirement(hex(rootId), join(world.directory, "legacy-blobs.db"));
    assert.deepEqual([verdict.isRetirable, (verdict as { legacyRows?: number }).legacyRows, (verdict as { legacyBytes?: number }).legacyBytes], [true, 1, 3]);
    world.store.close();
  });
});
