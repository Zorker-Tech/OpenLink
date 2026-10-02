/**
 * The worker that owns one conversation's blobs: the messages it answers, what it answers with, what it does with a
 * request it cannot carry out, and what happens when the store cannot be opened at all.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Worker } from "node:worker_threads";

import { ConversationStateStructure } from "../../source/packages/proto/generated/agent/v1/agent_pb.ts";
import { runAgentStoreWorker } from "../../source/host/agents/isolation/agent-store-worker.ts";

const WORKER_URL = new URL("../../source/host/agents/isolation/agent-store-worker.ts", import.meta.url);
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
const sha = (bytes: Uint8Array): Uint8Array => createHash("sha256").update(bytes).digest();
const bytesOf = (fill: number, length = 32): Uint8Array => new Uint8Array(length).fill(fill);

/** A blob of some bytes, kept under the id those bytes hash to. */
function blobOf(bytes: Uint8Array) {
  return { bytes, id: sha(bytes) };
}
function checkpointRoot(turnIds: Uint8Array[]) {
  const rootBytes = new ConversationStateStructure({ turns: turnIds }).toBinary();
  return { rootBytes, rootId: sha(rootBytes) };
}

/** A real worker over this module, with everything it says written down. */
function workerWorld(
  boot: { agentId: string; blobDbPath: string; busyTimeoutMs?: number; legacyBlobDbPath?: string },
  options: { captureStderr?: boolean } = {},
) {
  const messages: Array<Record<string, unknown>> = [];
  const worker = new Worker(WORKER_URL, {
    workerData: boot,
    ...(options.captureStderr === true ? { stderr: true } : {}),
  });
  let stderrText = "";
  if (options.captureStderr === true) worker.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderrText += chunk));
  worker.on("message", (message: Record<string, unknown>) => messages.push(message));
  const exited = new Promise<number>((resolve) => worker.on("exit", (code) => resolve(code ?? 0)));
  const crash = new Promise<Error>((resolve) => worker.on("error", resolve));
  return {
    worker, messages, exited, crash,
    stderr: () => stderrText,
    send: (request: Record<string, unknown>) => worker.postMessage(request),
    /** The answer to one request, waiting for it to arrive rather than guessing how long it takes. */
    async answer(requestId: number): Promise<Record<string, unknown>> {
      for (let attempt = 0; attempt < 400; attempt += 1) {
        const found = messages.find((message) => message.requestId === requestId);
        if (found !== undefined) return found;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error(`no answer to request ${requestId}; saw ${JSON.stringify(messages.map((message) => [message.kind, message.requestId]))}`);
    },
    /** What the worker said after a request nobody answers. */
    async quietFor(ms = 60): Promise<Record<string, unknown>[]> {
      const before = messages.length;
      await new Promise((resolve) => setTimeout(resolve, ms));
      return messages.slice(before);
    },
  };
}

describe("answering what the store is asked", () => {
  it("refuses to run as anything but a worker", () => {
    // The module can be imported anywhere, but it is only meant to run as a worker: called directly it says so rather
    // than waiting for messages that will never come.
    assert.throws(() => runAgentStoreWorker(), /must run as a worker_thread/);
  });

  it("says who it is when it starts, and answers every request it knows", async () => {
    const directory = mkdtempSync(join(tmpdir(), "slate-asw-"));
    const world = workerWorld({ agentId: "agent-1", blobDbPath: join(directory, "conversation-blobs.db"), busyTimeoutMs: 250 });
    try {
      world.send({ kind: "init", requestId: 1 });
      const init = await world.answer(1);
      assert.deepEqual([init.kind, init.requestId, typeof init.threadId, typeof init.pid], ["init-ok", 1, "number", "number"]);
      // A blob written and read back is the same blob.
      world.send({ kind: "set-blob", requestId: 2, blobId: bytesOf(1), blobData: Uint8Array.from([1, 2, 3]) });
      assert.deepEqual(await world.answer(2), { kind: "set-blob-ok", requestId: 2 });
      world.send({ kind: "get-blob", requestId: 3, blobId: bytesOf(1) });
      const read = await world.answer(3);
      assert.deepEqual([read.kind, Array.from(read.blobData as Uint8Array)], ["get-blob-ok", [1, 2, 3]]);
      // A blob nobody has is answered with nothing at all, not with an error.
      world.send({ kind: "get-blob", requestId: 4, blobId: bytesOf(2) });
      assert.deepEqual(await world.answer(4), { kind: "get-blob-ok", requestId: 4, blobData: undefined });
      // Clearing takes everything with it.
      world.send({ kind: "clear-blobs", requestId: 5 });
      assert.deepEqual(await world.answer(5), { kind: "clear-blobs-ok", requestId: 5 });
      world.send({ kind: "get-blob", requestId: 6, blobId: bytesOf(1) });
      assert.equal((await world.answer(6)).blobData, undefined);
      world.send({ kind: "flush", requestId: 7 });
      assert.deepEqual(await world.answer(7), { kind: "flush-ok", requestId: 7 });
    } finally {
      await world.worker.terminate();
    }
  });

  it("hands back a copy of what it read, and answers about the roots and what may be collected", async () => {
    const directory = mkdtempSync(join(tmpdir(), "slate-asw-"));
    // An older database the worker will adopt when it opens, so the retirement question has a real answer to give.
    const legacyPath = join(directory, "legacy-blobs.db");
    const legacy = new DatabaseSync(legacyPath);
    legacy.exec(`CREATE TABLE IF NOT EXISTS blobs (id TEXT PRIMARY KEY, data BLOB NOT NULL) STRICT`);
    legacy.prepare("INSERT INTO blobs (id, data) VALUES (?, ?)").run(hex(bytesOf(7)), Uint8Array.from([7, 7, 7]));
    legacy.close();
    const world = workerWorld({ agentId: "agent-1", blobDbPath: join(directory, "conversation-blobs.db"), busyTimeoutMs: 250, legacyBlobDbPath: legacyPath });
    try {
      const turn = blobOf(Uint8Array.from([1, 2, 3]));
      const older = checkpointRoot([turn.id]);
      const newer = checkpointRoot([turn.id, sha(Uint8Array.from([4]))]);
      for (const [requestId, blobId, blobData] of [
        [1, turn.id, turn.bytes],
        [2, older.rootId, older.rootBytes],
        [3, newer.rootId, newer.rootBytes],
      ] as const) {
        world.send({ kind: "set-blob", requestId, blobId, blobData });
        assert.equal((await world.answer(requestId)).kind, "set-blob-ok");
      }
      world.send({ kind: "get-blob", requestId: 4, blobId: turn.id });
      const first = (await world.answer(4)).blobData as Uint8Array;
      first.fill(0);
      // What the caller does with the bytes it was handed does not reach the store.
      world.send({ kind: "get-blob", requestId: 5, blobId: turn.id });
      assert.deepEqual(Array.from((await world.answer(5)).blobData as Uint8Array), [1, 2, 3]);
      // The answer names a root the store actually holds. (Which of two roots is the better one is the finder's own
      // rule, and is covered by its tests.)
      world.send({ kind: "find-latest-root", requestId: 6 });
      assert.equal([hex(older.rootId), hex(newer.rootId)].includes(hex((await world.answer(6)).rootId as Uint8Array)), true);
      // One of the two checkpoint roots is a stale one.
      world.send({ kind: "clear-stale-roots", requestId: 7, retainedRootIdHex: hex(newer.rootId) });
      assert.deepEqual(await world.answer(7), { kind: "clear-stale-roots-ok", requestId: 7, deleted: 1 });
      // A collection over a root with nothing to reach takes what nothing points at, and keeps that root.
      const plainBytes = new ConversationStateStructure({ previousWorkspaceUris: ["file:///workspace"] }).toBinary();
      const plain = { rootBytes: plainBytes, rootId: sha(plainBytes) };
      world.send({ kind: "set-blob", requestId: 8, blobId: plain.rootId, blobData: plain.rootBytes });
      assert.equal((await world.answer(8)).kind, "set-blob-ok");
      world.send({ kind: "collect-garbage", requestId: 9, retainedRootIdHex: hex(plain.rootId), pendingWriteRetentionMs: 0 });
      const collected = await world.answer(9);
      assert.deepEqual([collected.kind, (collected.result as { outcome: string }).outcome], ["collect-garbage-ok", "collected"]);
      world.send({ kind: "get-blob", requestId: 10, blobId: plain.rootId });
      assert.deepEqual((await world.answer(10)).blobData, plain.rootBytes);
      // The retirement question is answered by the store, with the older file the request named: that file has been
      // adopted, so it can be retired, counted as the row it holds.
      world.send({ kind: "verify-legacy-blob-retirement", requestId: 11, retainedRootIdHex: hex(plain.rootId), legacyBlobDbPath: legacyPath });
      assert.deepEqual(await world.answer(11), { kind: "verify-legacy-blob-retirement-ok", requestId: 11, verdict: { isRetirable: true, legacyRows: 1, legacyBytes: 3 } });
    } finally {
      await world.worker.terminate();
    }
  });

  it("cannot carry a blob with no bytes in it across the boundary, and says so", async () => {
    const directory = mkdtempSync(join(tmpdir(), "slate-asw-"));
    const world = workerWorld({ agentId: "agent-1", blobDbPath: join(directory, "conversation-blobs.db") });
    try {
      // The store refuses a zero-length blob when it arrives over a message, and that is answered as an error rather
      // than stored as an empty one.
      world.send({ kind: "set-blob", requestId: 1, blobId: bytesOf(1), blobData: new Uint8Array(0) });
      const refused = await world.answer(1);
      assert.deepEqual([refused.kind, refused.code], ["error", "ERR_SQLITE_ERROR"]);
      assert.match(String(refused.message), /NOT NULL constraint failed/);
      world.send({ kind: "get-blob", requestId: 2, blobId: bytesOf(1) });
      assert.equal((await world.answer(2)).blobData, undefined);
    } finally {
      await world.worker.terminate();
    }
  });

  it("adopts an older database and closes itself when it is told to", async () => {
    const directory = mkdtempSync(join(tmpdir(), "slate-asw-"));
    const legacyPath = join(directory, "legacy-blobs.db");
    const legacy = new (await import("node:sqlite")).DatabaseSync(legacyPath);
    legacy.exec(`CREATE TABLE IF NOT EXISTS blobs (id TEXT PRIMARY KEY, data BLOB NOT NULL) STRICT`);
    legacy.prepare("INSERT INTO blobs (id, data) VALUES (?, ?)").run(hex(bytesOf(7)), Uint8Array.from([7]));
    legacy.close();
    const world = workerWorld({ agentId: "agent-1", blobDbPath: join(directory, "conversation-blobs.db"), legacyBlobDbPath: legacyPath });
    try {
      world.send({ kind: "get-blob", requestId: 1, blobId: bytesOf(7) });
      assert.deepEqual(Array.from((await world.answer(1)).blobData as Uint8Array), [7]);
      // Closing answers first, and then the worker is done: nothing more is answered.
      world.send({ kind: "close", requestId: 2 });
      assert.deepEqual(await world.answer(2), { kind: "close-ok", requestId: 2 });
      assert.equal(await world.exited, 0);
    } finally {
      await world.worker.terminate();
    }
  });
});

describe("what it does with a request it cannot carry out", () => {
  it("answers with what went wrong rather than falling over", async () => {
    const directory = mkdtempSync(join(tmpdir(), "slate-asw-"));
    const world = workerWorld({ agentId: "agent-1", blobDbPath: join(directory, "conversation-blobs.db") });
    try {
      // Something the store itself refuses, with the code the platform raised it with.
      world.send({ kind: "set-blob", requestId: 1, blobId: bytesOf(1), blobData: "not bytes" });
      const failed = await world.answer(1);
      assert.deepEqual([failed.kind, failed.requestId, failed.name, typeof failed.code], ["error", 1, "Error", "string"]);
      assert.match(String(failed.message), /BLOB column/);
      // A request the protocol does not know is not answered at all, and does not stop the ones that are.
      world.send({ kind: "not-a-kind", requestId: 2 });
      assert.deepEqual(await world.quietFor(), []);
      world.send({ kind: "init", requestId: 3 });
      assert.equal((await world.answer(3)).kind, "init-ok");
    } finally {
      await world.worker.terminate();
    }
  });

  it("says why it could not open the store, and ends", async () => {
    const directory = mkdtempSync(join(tmpdir(), "slate-asw-"));
    // A path that is a directory rather than a database: the store cannot be opened at all.
    const notADatabase = join(directory, "not-a-db");
    mkdirSync(notADatabase, { recursive: true });
    const world = workerWorld({ agentId: "agent-1", blobDbPath: notADatabase }, { captureStderr: true });
    try {
      assert.equal(await world.exited, 1);
      assert.match(world.stderr(), /failed to open blob db: agent=agent-1 code=/);
    } finally {
      await world.worker.terminate();
    }
  });
});
