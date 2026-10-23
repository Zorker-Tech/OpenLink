import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

import { runAgentStoreWorker } from "../../source/host/agents/isolation/agent-store-worker.ts";

const WORKER_URL = new URL("../../source/host/agents/isolation/agent-store-worker.ts", import.meta.url);

function workerWorld() {
  const directory = mkdtempSync(join(tmpdir(), "slate-agent-store-worker-"));
  const messages: Array<Record<string, unknown>> = [];
  const worker = new Worker(WORKER_URL, { workerData: { agentId: "agent-1", blobDbPath: join(directory, "blobs.db") } });
  worker.on("message", (message: Record<string, unknown>) => messages.push(message));
  worker.on("error", (error) => messages.push({ kind: "worker-error", message: String(error) }));
  const exited = new Promise<number>((resolve) => worker.on("exit", (code) => resolve(code ?? 0)));
  let nextId = 1;
  const send = (message: Record<string, unknown>) => { const requestId = nextId++; worker.postMessage({ requestId, ...message }); return requestId; };
  const answer = async (requestId: number) => {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const found = messages.find((message) => message.requestId === requestId);
      if (found !== undefined) return found;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("no answer to request " + requestId + "; saw " + JSON.stringify(messages));
  };
  const close = async () => { await worker.terminate(); rmSync(directory, { recursive: true, force: true }); };
  return { worker, messages, exited, send, answer, close };
}

test("the worker refuses to run outside a worker thread", () => {
  assert.throws(() => runAgentStoreWorker(), /must run as a worker_thread/);
});

test("the worker answers an init with its thread and process", async () => {
  const world = workerWorld();
  try {
    const answer = await world.answer(world.send({ kind: "init" }));
    assert.equal(answer.kind, "init-ok");
    assert.equal(answer.threadId, world.worker.threadId);
    assert.equal(answer.pid, process.pid);
  } finally {
    await world.close();
  }
});

test("a blob is set and read back as a copy", async () => {
  const world = workerWorld();
  try {
    const id = new Uint8Array([1, 2, 3, 4]);
    assert.equal((await world.answer(world.send({ kind: "set-blob", blobId: id, blobData: new Uint8Array([9, 8, 7]) }))).kind, "set-blob-ok");
    const read = await world.answer(world.send({ kind: "get-blob", blobId: id }));
    assert.equal(read.kind, "get-blob-ok");
    assert.deepEqual([...(read.blobData as Uint8Array)], [9, 8, 7]);
    const again = await world.answer(world.send({ kind: "get-blob", blobId: id }));
    assert.deepEqual([...(again.blobData as Uint8Array)], [9, 8, 7]);
    const missing = await world.answer(world.send({ kind: "get-blob", blobId: new Uint8Array([5, 5, 5]) }));
    assert.equal(missing.kind, "get-blob-ok");
    assert.equal(missing.blobData, undefined);
  } finally {
    await world.close();
  }
});

test("blobs are cleared and the latest root is answered", async () => {
  const world = workerWorld();
  try {
    const id = new Uint8Array([1]);
    await world.answer(world.send({ kind: "set-blob", blobId: id, blobData: new Uint8Array([1]) }));
    const root = await world.answer(world.send({ kind: "find-latest-root" }));
    assert.equal(root.kind, "find-latest-root-ok");
    assert.equal("rootId" in root, true);
    assert.equal((await world.answer(world.send({ kind: "clear-blobs" }))).kind, "clear-blobs-ok");
    assert.equal((await world.answer(world.send({ kind: "get-blob", blobId: id }))).blobData, undefined);
  } finally {
    await world.close();
  }
});

test("stale roots and garbage collection are answered", async () => {
  const world = workerWorld();
  try {
    const stale = await world.answer(world.send({ kind: "clear-stale-roots", retainedRootIdHex: "00".repeat(32) }));
    assert.equal(stale.kind, "clear-stale-roots-ok");
    assert.equal(typeof stale.deleted, "number");
    const garbage = await world.answer(world.send({ kind: "collect-garbage", retainedRootIdHex: "00".repeat(32), pendingWriteRetentionMs: 1000 }));
    assert.equal(garbage.kind, "collect-garbage-ok");
    assert.deepEqual(garbage.result, { outcome: "skipped", reason: "no-root" });
  } finally {
    await world.close();
  }
});

test("a bad request is answered with an error rather than crashing the worker", async () => {
  const world = workerWorld();
  try {
    const answer = await world.answer(world.send({ kind: "set-blob", blobId: "not-bytes", blobData: "text" }));
    assert.equal(answer.kind, "error");
    assert.equal(typeof answer.message, "string");
    assert.equal(answer.name, "TypeError");
    assert.equal(answer.code, "ERR_INVALID_ARG_TYPE");
    const empty = await world.answer(world.send({ kind: "set-blob" }));
    assert.equal(empty.kind, "error");
    assert.equal((empty.message as string).length > 0, true);
    assert.equal("code" in empty, false);
    // The worker still answers after the failed request.
    assert.equal((await world.answer(world.send({ kind: "init" }))).kind, "init-ok");
  } finally {
    await world.close();
  }
});

test("a close is answered and the port is closed", async () => {
  const world = workerWorld();
  try {
    assert.equal((await world.answer(world.send({ kind: "close" }))).kind, "close-ok");
    await world.exited;
  } finally {
    await world.close();
  }
});

test("an unknown request kind is unanswered but does not kill the listener", async () => {
  const world = workerWorld();
  try {
    world.send({ kind: "unknown" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal((await world.answer(world.send({ kind: "init" }))).kind, "init-ok");
  } finally {
    await world.close();
  }
});

