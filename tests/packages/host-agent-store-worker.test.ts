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
  let exitCode: number | undefined;
  const exited = new Promise<number>((resolve) => worker.on("exit", (code) => { exitCode = code ?? 0; resolve(exitCode); }));
  let nextCallId = 1;
  const send = (message: Record<string, unknown>) => { const callId = nextCallId++; worker.postMessage({ callId, ...message }); return callId; };
  const answer = async (callId: number) => {
    for (let attempt = 0; attempt < 2_000; attempt += 1) {
      const found = messages.find((message) => message.callId === callId);
      if (found !== undefined) return found;
      const workerError = messages.find((message) => message.kind === "worker-error");
      if (workerError !== undefined) throw new Error("worker failed before responding: " + String(workerError.message));
      if (exitCode !== undefined) throw new Error("worker exited before responding with code " + String(exitCode));
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("no answer to worker call " + callId + "; saw " + JSON.stringify(messages));
  };
  const close = async () => { await worker.terminate(); rmSync(directory, { recursive: true, force: true }); };
  return { worker, messages, exited, send, answer, close };
}

test("the worker refuses to run outside a worker thread", () => {
  assert.throws(() => runAgentStoreWorker(), /must run as a worker_thread/);
});

test("the worker identifies its thread and process", async () => {
  const world = workerWorld();
  try {
    const answer = await world.answer(world.send({ operation: "worker.identify" }));
    assert.equal(answer.outcome, "success");
    assert.equal(answer.operation, "worker.identify");
    assert.equal(answer.workerThreadId, world.worker.threadId);
    assert.equal(answer.processId, process.pid);
  } finally {
    await world.close();
  }
});

test("a blob is set and read back as a copy", async () => {
  const world = workerWorld();
  try {
    const id = new Uint8Array([1, 2, 3, 4]);
    assert.equal((await world.answer(world.send({ operation: "blob.write", blobId: id, blobBytes: new Uint8Array([9, 8, 7]) }))).operation, "blob.write");
    const read = await world.answer(world.send({ operation: "blob.read", blobId: id }));
    assert.equal(read.operation, "blob.read");
    assert.deepEqual([...(read.blobBytes as Uint8Array)], [9, 8, 7]);
    const again = await world.answer(world.send({ operation: "blob.read", blobId: id }));
    assert.deepEqual([...(again.blobBytes as Uint8Array)], [9, 8, 7]);
    const missing = await world.answer(world.send({ operation: "blob.read", blobId: new Uint8Array([5, 5, 5]) }));
    assert.equal(missing.operation, "blob.read");
    assert.equal(missing.blobBytes, undefined);
  } finally {
    await world.close();
  }
});

test("blobs are cleared and the latest root is answered", async () => {
  const world = workerWorld();
  try {
    const id = new Uint8Array([1]);
    await world.answer(world.send({ operation: "blob.write", blobId: id, blobBytes: new Uint8Array([1]) }));
    const root = await world.answer(world.send({ operation: "root.find-latest" }));
    assert.equal(root.operation, "root.find-latest");
    assert.equal("latestRootId" in root, true);
    assert.equal((await world.answer(world.send({ operation: "blob.clear" }))).operation, "blob.clear");
    assert.equal((await world.answer(world.send({ operation: "blob.read", blobId: id }))).blobBytes, undefined);
  } finally {
    await world.close();
  }
});

test("stale roots and garbage collection are answered", async () => {
  const world = workerWorld();
  try {
    const stale = await world.answer(world.send({ operation: "checkpoint.prune", retainedRootIdHex: "00".repeat(32) }));
    assert.equal(stale.operation, "checkpoint.prune");
    assert.equal(typeof stale.deletedCount, "number");
    const garbage = await world.answer(world.send({ operation: "conversation.collect-garbage", retainedRootIdHex: "00".repeat(32), pendingWriteRetentionMs: 1000 }));
    assert.equal(garbage.operation, "conversation.collect-garbage");
    assert.deepEqual(garbage.garbageReport, { outcome: "skipped", reason: "no-root" });
  } finally {
    await world.close();
  }
});

test("a bad request is answered with an error rather than crashing the worker", async () => {
  const world = workerWorld();
  try {
    const answer = await world.answer(world.send({ operation: "blob.write", blobId: "not-bytes", blobBytes: "text" }));
    assert.equal(answer.outcome, "failure");
    assert.equal(typeof answer.message, "string");
    assert.equal(answer.name, "TypeError");
    const empty = await world.answer(world.send({ operation: "blob.write" }));
    assert.equal(empty.outcome, "failure");
    assert.equal((empty.message as string).length > 0, true);
    assert.equal("code" in empty, false);
    // The worker still answers after the failed request.
    assert.equal((await world.answer(world.send({ operation: "worker.identify" }))).operation, "worker.identify");
  } finally {
    await world.close();
  }
});

test("a close is answered and the port is closed", async () => {
  const world = workerWorld();
  try {
    assert.equal((await world.answer(world.send({ operation: "worker.close" }))).operation, "worker.close");
    await world.exited;
  } finally {
    await world.close();
  }
});

test("an unknown operation is ignored without killing the listener", async () => {
  const world = workerWorld();
  try {
    world.send({ operation: "unknown" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal((await world.answer(world.send({ operation: "worker.identify" }))).operation, "worker.identify");
  } finally {
    await world.close();
  }
});

