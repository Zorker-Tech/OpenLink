/**
 * Offloading the transcript mirror to a worker: the entry the host ships, how conversations are sharded across the
 * pool, how one conversation's writes are serialized and coalesced, what a dead or failing worker does, closing every
 * worker, and the mirror that offloads when it can and writes inline when it cannot.
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  DEFAULT_MIRROR_WORKERS,
  defaultMirrorWorkerEntryPath,
  OffloadingTranscriptMirror,
  TranscriptMirrorOffloadPool,
} from "../../source/host/agents/isolation/transcript-mirror-offload.ts";
import { WorkerBlobStore } from "../../source/host/agents/isolation/worker-blob-store.ts";
import { LegacyFileTranscriptMirror } from "../../source/host/transcript/mirror/legacy-transcript-mirror.ts";
import { pinHostDiagnosticsReporter, type HostDiagnostic } from "../../source/host/host-diagnostics.ts";

const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length > 0) restores.pop()?.();
});

/** A worker of the test's own: it holds requests, answers by the id it was given, refuses and dies on demand. */
function fakeWorkerPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "slate-mirror-offload-"));
  const path = join(directory, "fake-mirror-worker.mjs");
  writeFileSync(
    path,
    [
      'import { parentPort } from "node:worker_threads";',
      "parentPort.on('message', (request) => {",
      "  if (request.kind === 'close') { parentPort.postMessage({ kind: 'close-ok', requestId: request.requestId }); parentPort.close(); return; }",
      "  const byte = request.stateBlobId?.[0] ?? 0;",
      "  if (byte === 1 && String(request.conversationId).startsWith('die')) { process.exit(0); return; }",
      "  if (byte === 1 && String(request.conversationId).startsWith('fail')) { parentPort.postMessage({ kind: 'error', requestId: request.requestId, message: 'the fake worker refused' }); return; }",
      "  parentPort.postMessage({ kind: 'mirror-write-ok', requestId: request.requestId, written: byte % 2 === 0, durationMs: 1 });",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );
  return path;
}

function jobFor(conversationId: string, firstByte: number) {
  return {
    conversationId,
    stateBlobId: new Uint8Array([firstByte, 1, 2, 3]),
    blobDbPaths: ["/blobs/one.db"],
    transcriptsDir: "/transcripts",
  };
}

function poolWorld(options: { maxWorkers?: number; workerEntryPath?: string } = {}) {
  const pool = new TranscriptMirrorOffloadPool({
    workerEntryPath: options.workerEntryPath ?? fakeWorkerPath(),
    maxWorkers: options.maxWorkers ?? 1,
  });
  restores.push(() => {
    void pool.closeAll();
  });
  return pool;
}

function diagnosticWorld() {
  const diagnostics: HostDiagnostic[] = [];
  pinHostDiagnosticsReporter((diagnostic) => diagnostics.push(diagnostic));
  restores.push(() => pinHostDiagnosticsReporter(null));
  return { diagnostics, named: (kind: string) => diagnostics.filter((diagnostic) => diagnostic.kind === kind) };
}

/** An inline mirror that writes down what it was asked and answers what the test told it to. */
function inlineMirror(options: { incremental?: number | null; full?: boolean } = {}) {
  const calls: Array<{ call: string; conversationId: string; previous?: number }> = [];
  return {
    calls,
    mirror: {
      async writeIncremental(_ctx: unknown, conversationId: string, _state: unknown, _store: unknown, previous: number) {
        calls.push({ call: "incremental", conversationId, previous });
        return options.incremental === undefined ? null : options.incremental;
      },
      async writeFull(_ctx: unknown, conversationId: string) {
        calls.push({ call: "full", conversationId });
        return options.full ?? true;
      },
    },
  };
}

function stateOf(promptCount: number) {
  return { rootPromptMessagesJson: Array.from({ length: promptCount }, (_, index) => index) };
}

describe("the mirror worker pool", () => {
  it("knows the worker the host ships, and shards conversations the same way every time", () => {
    assert.equal(DEFAULT_MIRROR_WORKERS, 2);
    const entry = defaultMirrorWorkerEntryPath();
    assert.deepEqual([entry.endsWith(join("agent-isolation", "transcript-mirror-worker.cjs")), entry.startsWith("/")], [true, true]);
    const pool = poolWorld({ maxWorkers: 3 });
    assert.deepEqual(
      ["conv-1", "conv-2", "a", "b", "zzz"].map((id) => pool.workerIndexFor(id)),
      [0, 2, 1, 2, 0],
    );
    // The same conversation always lands on the same worker, and every index is one of the pool's.
    assert.deepEqual([pool.workerIndexFor("conv-1"), pool.workerIndexFor("conv-1")], [0, 0]);
    for (const id of ["conv-1", "conv-2", "a", "b", "zzz"]) assert.equal(pool.workerIndexFor(id) >= 0 && pool.workerIndexFor(id) < 3, true);
  });

  it("runs one conversation's writes in turn, and the newest of what queued up is what runs", async () => {
    const pool = poolWorld();
    // Three writes at once: the first runs, the two that follow coalesce into one.
    const firstJob = jobFor("conv-1", 0);
    const queuedJob = jobFor("conv-1", 1);
    const first = pool.write(firstJob);
    const second = pool.write(jobFor("conv-1", 1));
    const third = pool.write(jobFor("conv-1", 2));
    assert.deepEqual([await first, await second, await third], [true, true, true]);
    // The blob id that was sent is transferred rather than copied; the one that never ran is left alone.
    assert.deepEqual([firstJob.stateBlobId.buffer.byteLength, queuedJob.stateBlobId.buffer.byteLength], [0, 4]);
    assert.deepEqual([pool.lanes.size, pool.workers.filter((worker) => worker != null).length], [0, 1]);
  });

  it("keeps a conversation's lane going after a write failed, and a worker that died is replaced", async () => {
    const pool = poolWorld();
    await assert.rejects(() => pool.write(jobFor("fail-1", 1)), /the fake worker refused/);
    // Two conversations that share a worker are both answered, neither waiting for the other.
    assert.deepEqual(await Promise.all([pool.write(jobFor("conv-a", 0)), pool.write(jobFor("conv-b", 0))]), [true, true]);
    // The failure did not leave the lane behind, and the next write for that conversation is answered.
    assert.equal(pool.lanes.size, 0);
    assert.equal(await pool.write(jobFor("fail-1", 2)), true);
    // A worker that exits takes the write it owed with it, and the next write gets a fresh one for that conversation.
    await assert.rejects(() => pool.write(jobFor("die-1", 1)), /mirror worker exited with code 0/);
    assert.deepEqual(await pool.write(jobFor("die-1", 2)), true);
  });

  it("closes every worker it holds, and takes no more work", async () => {
    const pool = poolWorld({ maxWorkers: 2 });
    assert.equal(await pool.write(jobFor("conv-1", 0)), true);
    assert.equal(await pool.write(jobFor("conv-2", 0)), true);
    assert.deepEqual(pool.workers.filter((worker) => worker != null).length, 2);
    await pool.closeAll();
    assert.deepEqual(pool.workers, [null, null]);
    await assert.rejects(() => pool.write(jobFor("conv-1", 0)), /mirror offload pool is closed/);
  });
});

describe("the mirror that offloads when it can", () => {
  it("writes inline while the transcript has not moved past what it already wrote", async () => {
    const inline = inlineMirror({ incremental: 3 });
    const asked: unknown[] = [];
    const mirror = new OffloadingTranscriptMirror(inline.mirror, () => ({ write: async (job: unknown) => (asked.push(job), true) }) as never, { blobDbPaths: ["/blobs.db"], transcriptsDir: "/transcripts" });
    await mirror.write({}, "conv-1", stateOf(3), {});
    assert.deepEqual(inline.calls, [{ call: "incremental", conversationId: "conv-1", previous: 0 }]);
    assert.deepEqual([mirror.previousRootPromptCount, asked.length], [3, 0]);
  });

  it("writes in full when the store is not the worker's, and says so when that failed", async () => {
    const diagnostics = diagnosticWorld();
    const good = inlineMirror({ incremental: null, full: true });
    const mirror = new OffloadingTranscriptMirror(good.mirror, () => ({ write: async () => true }) as never, { blobDbPaths: [], transcriptsDir: "/transcripts" }, 2);
    await mirror.write({}, "conv-1", stateOf(5), {});
    assert.deepEqual(good.calls, [{ call: "incremental", conversationId: "conv-1", previous: 2 }, { call: "full", conversationId: "conv-1" }]);
    assert.equal(mirror.previousRootPromptCount, 5);
    // A full write that did not happen leaves the count where it was, and is reported as a stale mirror.
    const bad = inlineMirror({ incremental: null, full: false });
    const failing = new OffloadingTranscriptMirror(bad.mirror, () => ({ write: async () => true }) as never, { blobDbPaths: [], transcriptsDir: "/transcripts" }, 2);
    await failing.write({}, "conv-2", stateOf(5), {});
    assert.deepEqual([failing.previousRootPromptCount, diagnostics.named("transcript_mirror_stale").map((diagnostic) => diagnostic.reason)], [2, ["full-write-failed"]]);
  });

  it("offloads to the worker when the store is the worker's, and reports what came back", async () => {
    const diagnostics = diagnosticWorld();
    const asked: Array<Record<string, unknown>> = [];
    let answer = true;
    const pool = () => ({ write: async (job: Record<string, unknown>) => { asked.push(job); return answer; } }) as never;
    const inline = inlineMirror({ incremental: null });
    const mirror = new OffloadingTranscriptMirror(inline.mirror, pool, { blobDbPaths: ["/blobs.db", "/more.db"], transcriptsDir: "/transcripts" });
    const store = new WorkerBlobStore({} as never, "agent-1", "/blobs.db");
    const stateBlobId = new Uint8Array([7, 7, 7]);
    await mirror.write({}, "conv-1", stateOf(4), store, stateBlobId);
    // What the caller handed over is copied for the worker rather than taken from the caller.
    assert.deepEqual([asked.length, stateBlobId.byteLength], [1, 3]);
    assert.deepEqual(
      [asked[0]?.conversationId, (asked[0]?.stateBlobId as Uint8Array).length, asked[0]?.blobDbPaths, asked[0]?.transcriptsDir],
      ["conv-1", 3, ["/blobs.db", "/more.db"], "/transcripts"],
    );
    assert.deepEqual([mirror.previousRootPromptCount, diagnostics.named("transcript_mirror_stale").length], [4, 0]);
    // What the worker did not write is a stale mirror, and so is a pool that refused outright.
    answer = false;
    await mirror.write({}, "conv-2", stateOf(4), store, new Uint8Array([1]));
    const refusing = new OffloadingTranscriptMirror(inline.mirror, (() => ({ write: async () => { throw new Error("the pool is down"); } })) as never, { blobDbPaths: [], transcriptsDir: "/transcripts" });
    await refusing.write({}, "conv-3", stateOf(4), store, new Uint8Array([1]));
    assert.deepEqual(diagnostics.named("transcript_mirror_stale").map((diagnostic) => [diagnostic.reason, diagnostic.agentId]), [["worker-write-failed", "conv-2"], ["worker-write-failed", "conv-3"]]);
    assert.equal(diagnostics.named("transcript_mirror_stale").some((diagnostic) => diagnostic.errorClass !== undefined), true);
  });

  it("does not offload a state with no checkpoint blob, and writes are serialized per mirror", async () => {
    const diagnostics = diagnosticWorld();
    let asked = 0;
    const pool = () => ({ write: async () => (asked += 1, true) }) as never;
    const inline = inlineMirror({ incremental: null });
    const mirror = new OffloadingTranscriptMirror(inline.mirror, pool, { blobDbPaths: [], transcriptsDir: "/transcripts" });
    const store = new WorkerBlobStore({} as never, "agent-1", "/blobs.db");
    await mirror.write({}, "conv-1", stateOf(2), store);
    await mirror.write({}, "conv-1", stateOf(2), store, new Uint8Array());
    assert.deepEqual([asked, diagnostics.named("transcript_mirror_stale").map((diagnostic) => diagnostic.reason)], [0, ["worker-unavailable", "worker-unavailable"]]);
    // Two writes at once are run one after the other, not together.
    let running = 0;
    let overlapped = false;
    const slow = {
      async writeIncremental() {
        running += 1;
        if (running > 1) overlapped = true;
        await new Promise((resolve) => setTimeout(resolve, 5));
        running -= 1;
        return 1;
      },
      async writeFull() {
        return true;
      },
    };
    const serialized = new OffloadingTranscriptMirror(slow, pool, { blobDbPaths: [], transcriptsDir: "/transcripts" });
    await Promise.all([serialized.write({}, "conv-1", stateOf(1), {}), serialized.write({}, "conv-2", stateOf(1), {})]);
    assert.deepEqual([overlapped, serialized.previousRootPromptCount], [false, 1]);
    // A write that threw does not hold up the next write on the same mirror.
    let attempts = 0;
    const flaky = {
      async writeIncremental() {
        attempts += 1;
        if (attempts === 1) throw new Error("the inline mirror broke");
        return 1;
      },
      async writeFull() {
        return true;
      },
    };
    const recovering = new OffloadingTranscriptMirror(flaky, pool, { blobDbPaths: [], transcriptsDir: "/transcripts" });
    await assert.rejects(() => recovering.write({}, "conv-1", stateOf(1), {}), /the inline mirror broke/);
    await recovering.write({}, "conv-1", stateOf(1), {});
    assert.equal(recovering.previousRootPromptCount, 1);
  });

  it("builds a mirror over a transcripts directory", () => {
    const mirror = OffloadingTranscriptMirror.forTranscriptsDir(() => ({}) as never, { blobDbPaths: ["/blobs.db"], transcriptsDir: "/transcripts" }, 3);
    assert.equal(mirror.inline instanceof LegacyFileTranscriptMirror, true);
    assert.deepEqual([mirror.previousRootPromptCount, mirror.options.transcriptsDir], [3, "/transcripts"]);
  });
});
