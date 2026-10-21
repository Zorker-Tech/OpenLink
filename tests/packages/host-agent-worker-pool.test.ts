/**
 * The agent worker pool: how a worker's answers are matched to requests, how a worker that died is retired, and how the
 * pool keeps one worker per store without ever closing one that is in the middle of a call.
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";

import {
  AgentWorkerConnection,
  AgentWorkerPool,
  forwardStream,
  MAX_FORWARDED_WORKER_LINE_BYTES,
  rebuildWorkerError,
} from "../../source/host/agents/isolation/agent-worker-pool.ts";

/** A worker that does what the test tells it to: it records what it was asked and answers when told. */
class FakeWorker extends EventEmitter {
  readonly posted: Array<Record<string, unknown>> = [];
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  terminated = false;

  constructor(readonly entryPath: string, readonly boot: unknown) {
    super();
  }

  postMessage(request: Record<string, unknown>): void {
    this.posted.push(request);
    // `ensure` waits for `init` and `close` waits for `close`: a worker that never answered them would hang every test.
    if (request.kind === "init") this.answer(request.requestId as number, { threadId: 7, pid: 4242 });
    if (request.kind === "close") this.answer(request.requestId as number, {});
  }

  /** The id of the request that was posted last: tests ask for it rather than guessing. */
  lastRequestId(): number {
    return this.posted.at(-1)!.requestId as number;
  }

  answer(requestId: number, body: Record<string, unknown> = {}): void {
    this.emit("message", { kind: "ok", requestId, ...body });
  }

  fail(requestId: number, message: string, name?: string, code?: string): void {
    this.emit("message", { kind: "error", requestId, message, ...(name === undefined ? {} : { name }), ...(code === undefined ? {} : { code }) });
  }

  async terminate(): Promise<number> {
    this.terminated = true;
    return 0;
  }
}

function connectionWith(overrides: { onExit?: (self: AgentWorkerConnection) => void } = {}) {
  const workers: FakeWorker[] = [];
  const exits: AgentWorkerConnection[] = [];
  const connection = new AgentWorkerConnection(
    "/worker.cjs",
    { agentId: "agent-1", blobDbPath: "/store.db", busyTimeoutMs: 1_000 },
    (self) => {
      exits.push(self);
      overrides.onExit?.(self);
    },
    (entryPath, boot) => {
      const worker = new FakeWorker(entryPath, boot);
      workers.push(worker);
      return worker as never;
    },
  );
  return { connection, worker: workers[0]!, exits };
}

function poolWith(options: { maxWorkers?: number; idleTimeoutMs?: number; sweepIntervalMs?: number } = {}) {
  const workers: FakeWorker[] = [];
  const pool = new AgentWorkerPool({
    workerEntryPath: "/worker.cjs",
    busyTimeoutMs: 1_000,
    sweepIntervalMs: options.sweepIntervalMs ?? 5,
    ...(options.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.idleTimeoutMs }),
    ...(options.maxWorkers === undefined ? {} : { maxWorkers: options.maxWorkers }),
    createWorker: (entryPath, boot) => {
      const worker = new FakeWorker(entryPath, boot);
      workers.push(worker);
      return worker as never;
    },
  });
  return { pool, workers };
}

/** Lets the stream deliver what was written, since a stream's last chunk arrives on the next tick. */
const settleStream = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("a worker's errors and output", () => {
  it("carries the worker's own error name and code across the thread boundary", () => {
    const error = rebuildWorkerError({ message: "busy", name: "SQLITE_BUSY", code: "ERR_SQLITE" });
    assert.equal(error.message, "busy");
    assert.equal(error.name, "SQLITE_BUSY");
    assert.equal((error as Error & { code?: string }).code, "ERR_SQLITE");
    // A plain error keeps the defaults.
    assert.deepEqual([rebuildWorkerError({ message: "x" }).name, rebuildWorkerError({ message: "x" }).message], ["Error", "x"]);
  });

  it("forwards a stream line by line, cutting a long line and flushing what is left", async () => {
    const lines: string[] = [];
    const stream = new PassThrough();
    forwardStream(stream, (line) => lines.push(line));
    stream.write("one\r\ntwo\n\n");
    stream.write("three");
    stream.end();
    await settleStream();
    assert.deepEqual(lines, ["one", "two", "three"]);
    // A line past the cap is cut with a marker, and a chunk far past it is forwarded as it came.
    const cut: string[] = [];
    const big = new PassThrough();
    forwardStream(big, (line) => cut.push(line));
    big.write(`${"a".repeat(MAX_FORWARDED_WORKER_LINE_BYTES)}b\n`);
    big.write(`${"c".repeat(MAX_FORWARDED_WORKER_LINE_BYTES * 2 + 1)}\n`);
    big.end();
    await settleStream();
    // A line longer than the cap is cut, wherever the chunk boundary happened to fall: no forwarded line is unbounded.
    assert.equal(cut[0], `${"a".repeat(MAX_FORWARDED_WORKER_LINE_BYTES)}…[truncated]`);
    assert.equal(cut.length, 2);
    for (const line of cut) assert.equal(line.length <= MAX_FORWARDED_WORKER_LINE_BYTES + "…[truncated]".length, true);
    assert.equal(cut[1]!.endsWith("…[truncated]"), true);
  });

  it("forwards nothing for no stream, and swallows a stream error", () => {
    forwardStream(null, () => assert.fail("no stream means no lines"));
    const lines: string[] = [];
    const stream = new PassThrough();
    forwardStream(stream, (line) => lines.push(line));
    stream.destroy(new Error("gone"));
    assert.deepEqual(lines, []);
  });
});

describe("one worker connection", () => {
  it("settles each request with its own answer, and ignores an answer nobody is waiting for", async () => {
    const { connection, worker } = connectionWith();
    const first = connection.send((requestId) => ({ kind: "get-blob", requestId }));
    const firstId = worker.lastRequestId();
    const second = connection.send((requestId) => ({ kind: "get-blob", requestId }));
    const secondId = worker.lastRequestId();
    assert.deepEqual(worker.posted.map((request) => request.kind), ["get-blob", "get-blob"]);
    worker.answer(secondId, { blobData: new Uint8Array([2]) });
    worker.answer(firstId, { blobData: new Uint8Array([1]) });
    assert.deepEqual([...(await first).blobData!], [1]);
    assert.deepEqual([...(await second).blobData!], [2]);
    // A response for a request that is over is ignored, not thrown.
    worker.answer(999, {});
    assert.equal(connection.pending.size, 0);
  });

  it("rejects a failed request with the worker's error, and remembers the activity while doing it", async () => {
    const { connection, worker } = connectionWith();
    connection.lastActivityAt = 0;
    const request = connection.send((requestId) => ({ kind: "set-blob", requestId }));
    worker.fail(worker.lastRequestId(), "disk full", "SQLITE_FULL", "ENOSPC");
    await assert.rejects(() => request, (error: unknown) => error instanceof Error && error.name === "SQLITE_FULL" && (error as Error & { code?: string }).code === "ENOSPC");
    assert.notEqual(connection.activityAt(), 0);
  });

  it("takes its thread and process identity from the init answer", async () => {
    const { connection, worker } = connectionWith();
    await connection.init({ agentId: "agent-1", blobDbPath: "/store.db", busyTimeoutMs: 10 });
    assert.deepEqual([connection.threadId(), connection.pid(), worker.posted.at(-1)?.kind], [7, 4242, "init"]);
  });

  it("retires itself once when the worker exits, and rejects everything it owed", async () => {
    const { connection, worker, exits } = connectionWith();
    const first = connection.send((requestId) => ({ kind: "get-blob", requestId }));
    const second = connection.send((requestId) => ({ kind: "get-blob", requestId }));
    worker.emit("exit", 3);
    await assert.rejects(() => first, /worker exited with code 3/);
    await assert.rejects(() => second, /worker exited with code 3/);
    assert.equal(exits.length, 1);
    // A clean exit is still an exit, and a dead worker refuses new work.
    assert.equal(connection.isDead, true);
    await assert.rejects(() => connection.send((requestId) => ({ kind: "get-blob", requestId })), /no longer running/);
    worker.emit("error", new Error("late"));
    assert.equal(exits.length, 1);
  });

  it("closes by asking and then terminating, even when the worker will not answer", async () => {
    const { connection, worker } = connectionWith();
    const closing = connection.close();
    worker.answer(connection.pending.keys().next().value as number, {});
    await closing;
    assert.equal(worker.terminated, true);
    // A worker that is already dead is not asked anything.
    const dead = connectionWith();
    dead.worker.emit("exit", 0);
    await dead.connection.close();
    assert.equal(dead.worker.terminated, false);
  });
});

describe("the pool", () => {
  it("gives every store one worker, and reuses it", async () => {
    const { pool, workers } = poolWith();
    const first = await pool.ensure("agent-1", "/a.db");
    const second = await pool.ensure("agent-1", "/a.db");
    assert.equal(first, second);
    assert.equal(workers.length, 1);
    assert.deepEqual([pool.activeWorkerCount(), pool.describeWorkers()[0]!.threadId], [1, 7]);
    // Two stores are two workers.
    await pool.ensure("agent-2", "/b.db");
    assert.equal(workers.length, 2);
    await pool.closeAll();
    assert.equal(pool.activeWorkerCount(), 0);
  });

  it("evicts the least recently used idle worker, and never one that is in a call", async () => {
    const { pool, workers } = poolWith({ maxWorkers: 1 });
    await pool.ensure("agent-1", "/a.db");
    pool.connections.get("/a.db")!.lastActivityAt = 1;
    // The first store survives eviction while it is being used.
    const retained = pool.getBlob("agent-1", "/a.db", new Uint8Array([1]));
    await pool.ensure("agent-2", "/b.db");
    assert.deepEqual([pool.activeWorkerCount(), pool.connections.has("/b.db")], [2, true]);
    // The call finishes, so the store is no longer retained; a third store then makes the least recently used one way.
    workers[0]!.answer(workers[0]!.lastRequestId(), { blobData: new Uint8Array([1]) });
    await retained;
    pool.connections.get("/a.db")!.lastActivityAt = 1;
    pool.connections.get("/b.db")!.lastActivityAt = 2;
    await pool.ensure("agent-3", "/c.db");
    assert.deepEqual([...pool.connections.keys()].sort(), ["/b.db", "/c.db"]);
    await pool.closeAll();
  });

  it("keeps a worker that is not idle yet, and sweeps it once it is", async () => {
    const { pool, workers } = poolWith({ idleTimeoutMs: 60_000, sweepIntervalMs: 1 });
    await pool.ensure("agent-1", "/a.db");
    await new Promise((resolve) => setTimeout(resolve, 20));
    // A sweep that ran while the worker was recently active left it alone.
    assert.equal(pool.activeWorkerCount(), 1);
    pool.connections.get("/a.db")!.lastActivityAt = 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(pool.activeWorkerCount(), 0);
    await pool.closeAll();
  });

  it("sweeps a worker that has been idle, and stops sweeping when none is left", async () => {
    const { pool } = poolWith({ idleTimeoutMs: 0, sweepIntervalMs: 1 });
    await pool.ensure("agent-1", "/a.db");
    assert.notEqual(pool.sweepTimer, null);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(pool.activeWorkerCount(), 0);
    assert.equal(pool.sweepTimer, null);
  });

  it("does not sweep at all when the idle timeout is infinite", async () => {
    const { pool } = poolWith({ idleTimeoutMs: Number.POSITIVE_INFINITY });
    await pool.ensure("agent-1", "/a.db");
    assert.equal(pool.sweepTimer, null);
    await pool.closeAll();
  });

  it("forgets a worker that died, and closes one store on its own", async () => {
    const { pool, workers } = poolWith();
    await pool.ensure("agent-1", "/a.db");
    workers[0]!.emit("exit", 0);
    assert.deepEqual([pool.activeWorkerCount(), pool.sweepTimer], [0, null]);
    // closeStore on a store with no worker is a no-op; on one with a worker it closes it.
    await pool.closeStore("/missing.db");
    await pool.ensure("agent-2", "/b.db");
    await pool.closeStore("/b.db");
    assert.equal(pool.activeWorkerCount(), 0);
  });

  it("releases the store even when the operation fails", async () => {
    const { pool, workers } = poolWith();
    const call = pool.getBlob("agent-1", "/a.db", new Uint8Array([1]));
    // The worker is started and the read is posted on the next turn, so the failure is aimed at the read itself.
    await settleStream();
    workers[0]!.fail(workers[0]!.lastRequestId(), "cannot read");
    await assert.rejects(() => call, /cannot read/);
    // Nothing is retained once the call is over, so the sweep can close it.
    assert.equal(pool.activeOps.size, 0);
    await pool.closeAll();
  });
});
