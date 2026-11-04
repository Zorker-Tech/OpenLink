/**
 * The worker that mirrors a conversation's checkpoint into its transcript files: the store it reads blobs through (and
 * never writes them), the messages it answers, and what it answers with when the checkpoint cannot be read.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Worker } from "node:worker_threads";

import { ReadOnlySqliteBlobStore, runTranscriptMirrorWorker } from "../../source/host/agents/isolation/transcript-mirror-worker.ts";
import { ConversationStateStructure } from "../../source/adapters/interop/proto/generated/agent/v1/agent_pb.ts";

const WORKER_URL = new URL("../../source/host/agents/isolation/transcript-mirror-worker.ts", import.meta.url);
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
const sha = (bytes: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(bytes).digest());
const textBytes = (text: string): Uint8Array => new TextEncoder().encode(text);

/** A database of blobs, keyed by the hex id they are stored under. */
function blobDatabase(path: string, entries: Array<[Uint8Array, Uint8Array]>): void {
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE IF NOT EXISTS blobs (id TEXT PRIMARY KEY, data BLOB NOT NULL) STRICT");
  const insert = db.prepare("INSERT INTO blobs (id, data) VALUES (?, ?)");
  for (const [id, data] of entries) insert.run(hex(id), data);
  db.close();
}

/** A real worker over this module, with everything it says written down. */
function workerWorld(request: { conversationId: string; stateBlobId: Uint8Array; blobDbPaths: string[]; transcriptsDir: string }) {
  const messages: Array<Record<string, unknown>> = [];
  const worker = new Worker(WORKER_URL);
  worker.on("message", (message: Record<string, unknown>) => messages.push(message));
  const exited = new Promise<number>((resolve) => worker.on("exit", (code) => resolve(code ?? 0)));
  return {
    worker,
    messages,
    exited,
    send: (message: Record<string, unknown>) => worker.postMessage(message),
    /** The answer to one request, waiting for it to arrive rather than guessing how long it takes. */
    async answer(requestId: number): Promise<Record<string, unknown>> {
      for (let attempt = 0; attempt < 400; attempt += 1) {
        const found = messages.find((message) => message.requestId === requestId);
        if (found !== undefined) return found;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error(`no answer to request ${requestId}; saw ${JSON.stringify(messages)}`);
    },
    request(requestId: number) {
      return { kind: "mirror", requestId, ...request };
    },
  };
}

describe("reading blobs read-only", () => {
  it("refuses to run as anything but a worker", () => {
    assert.throws(() => runTranscriptMirrorWorker(), /must run as a worker_thread/);
  });

  it("reads a blob from any of its databases, by the id it was stored under", async () => {
    const directory = mkdtempSync(join(tmpdir(), "slate-mirror-worker-"));
    const first = join(directory, "one.db");
    const second = join(directory, "two.db");
    const wanted = sha(textBytes("the blob"));
    blobDatabase(first, [[sha(textBytes("other")), textBytes("not what was asked for")]]);
    blobDatabase(second, [[wanted, textBytes("the blob")]]);
    // A database that is not there is passed over rather than failing the read.
    const store = new ReadOnlySqliteBlobStore([join(directory, "missing.db"), first, second]);
    // The id may be a view into a larger buffer: only its own bytes are looked up.
    const view = new Uint8Array(wanted.length + 8);
    view.set(wanted, 4);
    assert.deepEqual(await store.getBlob({}, wanted), textBytes("the blob"));
    assert.deepEqual(await store.getBlob({}, view.subarray(4, 4 + wanted.length)), textBytes("the blob"));
    assert.equal(await store.getBlob({}, sha(textBytes("never stored"))), undefined);
  });

  it("keeps the connection it opened", async () => {
    const directory = mkdtempSync(join(tmpdir(), "slate-mirror-worker-"));
    const path = join(directory, "blobs.db");
    const id = sha(textBytes("kept"));
    blobDatabase(path, [[id, textBytes("kept")]]);
    const store = new ReadOnlySqliteBlobStore([path]);
    assert.deepEqual(await store.getBlob({}, id), textBytes("kept"));
    // The file is gone, and the connection that was already open still answers.
    rmSync(path);
    assert.deepEqual(await store.getBlob({}, id), textBytes("kept"));
  });

  it("leaves a database it cannot read alone, and says so once", async () => {
    const directory = mkdtempSync(join(tmpdir(), "slate-mirror-worker-"));
    const broken = join(directory, "broken.db");
    writeFileSync(broken, "this is not a database at all", "utf8");
    const good = join(directory, "good.db");
    const id = sha(textBytes("from the good one"));
    blobDatabase(good, [[id, textBytes("from the good one")]]);
    const logged: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args);
    };
    try {
      const store = new ReadOnlySqliteBlobStore([broken, good]);
      assert.deepEqual(await store.getBlob({}, id), textBytes("from the good one"));
      assert.equal(await store.getBlob({}, sha(textBytes("nothing"))), undefined);
    } finally {
      console.error = originalError;
    }
    // One line, the first time it was tried, naming the file.
    assert.equal(logged.length, 1);
    assert.equal(logged[0]?.some((value) => String(value).includes(broken)), true);
  });

  it("never writes a blob, and flushing is nothing to do", async () => {
    // The invariant's own message is stripped in packaged builds, so what identifies the refusal is its kind.
    const refuses = (error: unknown) => error instanceof Error && error.name === "SlateInvariantViolation";
    const store = new ReadOnlySqliteBlobStore([]);
    await assert.rejects(() => store.setBlob(), refuses);
    await assert.rejects(() => store.setBlobLocallyOnly(), refuses);
    await store.flush();
  });
});

describe("what the mirror worker answers", () => {
  it("mirrors a checkpoint into the conversation's transcript files", async () => {
    const directory = mkdtempSync(join(tmpdir(), "slate-mirror-worker-"));
    const transcriptsDir = join(directory, "transcripts");
    mkdirSync(transcriptsDir, { recursive: true });
    const message = textBytes(JSON.stringify({ role: "user", content: "what the user asked" }));
    const messageId = sha(message);
    const state = new ConversationStateStructure({ rootPromptMessagesJson: [messageId] });
    const stateBytes = state.toBinary();
    const stateId = sha(stateBytes);
    const dbPath = join(directory, "blobs.db");
    blobDatabase(dbPath, [
      [stateId, stateBytes],
      [messageId, message],
    ]);
    const world = workerWorld({ conversationId: "conv-1", stateBlobId: stateId, blobDbPaths: [dbPath], transcriptsDir });
    try {
      world.send(world.request(1));
      const answer = await world.answer(1);
      assert.deepEqual([answer.kind, answer.requestId, answer.written], ["mirror-write-ok", 1, true]);
      assert.equal(typeof answer.durationMs, "number");
      const written = readFileSync(join(transcriptsDir, "conv-1", "conv-1.jsonl"), "utf8");
      assert.equal(written.includes("what the user asked"), true);
    } finally {
      await world.worker.terminate();
    }
  });

  it("answers a checkpoint it cannot find with an error, and closes when it is told to", async () => {
    const directory = mkdtempSync(join(tmpdir(), "slate-mirror-worker-"));
    const dbPath = join(directory, "blobs.db");
    blobDatabase(dbPath, []);
    const world = workerWorld({ conversationId: "conv-1", stateBlobId: sha(textBytes("missing")), blobDbPaths: [dbPath], transcriptsDir: join(directory, "transcripts") });
    try {
      world.send(world.request(7));
      const answer = await world.answer(7);
      assert.deepEqual([answer.kind, answer.requestId, answer.message], ["error", 7, "transcript mirror checkpoint blob is unavailable"]);
      // The worker keeps working: it is the request that failed, not the worker.
      world.send({ kind: "close", requestId: 8 });
      assert.deepEqual(await world.answer(8), { kind: "close-ok", requestId: 8 });
      assert.equal(await world.exited, 0);
    } finally {
      await world.worker.terminate();
    }
  });
});
