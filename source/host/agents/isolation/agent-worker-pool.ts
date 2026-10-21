/**
 * Running agents' work off the main thread.
 *
 * A pool of workers does the work that must not stall the host — reading stores, walking transcripts — so this file is
 * about the two things a pool has to get right:
 *
 * - **one worker per store, and no more** — a worker is keyed by the store it opened, so two callers on one store share the
 *   same worker instead of fighting over the same SQLite file; a chatty store is *retained* for the length of its call, and
 *   a retained worker is never evicted or swept, because closing it mid-call would fail the caller's work;
 * - **a worker that died is gone, not stuck** — an exit or an error rejects everything still pending on that worker, once,
 *   and removes it from the pool; the next call starts a fresh one.
 *
 * The pool's own operations (set, get, find, clear, prune, collect, verify) are all the same shape — retain, take the
 * worker, ask it one thing, release — so they are written once in `withWorker` and named by their request.
 */
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

export function defaultWorkerEntryPath(): string {
  const here = typeof __dirname === "string" ? __dirname : dirname(fileURLToPath(import.meta.url));
  return join(here, "agent-isolation", "agent-store-worker.cjs");
}

/** What a worker answers: one response per request id, or an error with the worker's own name and code. */
interface WorkerResponse {
  readonly kind: string;
  readonly requestId: number;
  readonly threadId?: number;
  readonly pid?: number;
  readonly blobData?: Uint8Array;
  readonly rootId?: Uint8Array;
  readonly deleted?: number;
  readonly result?: unknown;
  readonly verdict?: unknown;
  readonly message?: string;
  readonly name?: string;
  readonly code?: string;
}

interface WorkerBoot {
  readonly agentId: string;
  readonly blobDbPath: string;
  readonly busyTimeoutMs: number;
  readonly legacyBlobDbPath?: string;
}

interface PendingWorkerRequest {
  resolve(response: WorkerResponse): void;
  reject(error: Error): void;
}

/** A worker's error, as close to the one it threw as a message can carry: its name and code survive the trip. */
export function rebuildWorkerError(response: Pick<WorkerResponse, "message" | "name" | "code">): Error {
  const error = new Error(response.message);
  if (response.name != null) error.name = response.name;
  if (response.code != null) Object.assign(error, { code: response.code });
  return error;
}

/** A line forwarded from a worker is cut here: a broken worker's output must not become an unbounded log line. */
export const MAX_FORWARDED_WORKER_LINE_BYTES = 8 * 1024;

/**
 * Forwards a worker's output line by line, with three bounds: a line is truncated, a chunk that is far larger than a line
 * is emitted as one (rather than being scanned for newlines), and whatever is left when the stream ends is emitted last.
 * An empty line is not forwarded, and a stream error is not the caller's to handle.
 */
export function forwardStream(stream: Readable | null, emit: (line: string) => void): void {
  if (stream == null) return;
  let buffered = "";
  const emitLine = (line: string): void => {
    if (line.length === 0) return;
    emit(line.length > MAX_FORWARDED_WORKER_LINE_BYTES ? `${line.slice(0, MAX_FORWARDED_WORKER_LINE_BYTES)}…[truncated]` : line);
  };
  const flush = (): void => {
    const remainder = buffered;
    buffered = "";
    emitLine(remainder);
  };
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buffered += chunk;
    if (buffered.length > MAX_FORWARDED_WORKER_LINE_BYTES * 2) {
      emitLine(buffered);
      buffered = "";
      return;
    }
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) emitLine(line.replace(/\r$/, ""));
  });
  stream.on("end", flush);
  stream.on("close", flush);
  stream.on("error", () => {});
}

/** How a connection gets its worker: the real thread by default, and something else in a test. */
type CreateWorker = (entryPath: string, boot: WorkerBoot) => Worker;

const spawnWorker: CreateWorker = (entryPath, boot) => new Worker(entryPath, { workerData: boot, stdout: true, stderr: true });

/** One worker and the requests it owes an answer to. */
export class AgentWorkerConnection {
  readonly worker: Worker;
  readonly pending = new Map<number, PendingWorkerRequest>();
  nextRequestId = 1;
  isDead = false;
  lastActivityAt = Date.now();
  workerThreadId: number | null = null;
  workerPid: number | null = null;

  constructor(workerEntryPath: string, boot: WorkerBoot, readonly onExit: (self: AgentWorkerConnection) => void, createWorker: CreateWorker = spawnWorker) {
    this.worker = createWorker(workerEntryPath, boot);
    forwardStream(this.worker.stdout, (message) => console.log(message));
    forwardStream(this.worker.stderr, (message) => console.error(message));
    this.worker.on("message", (response) => this.settle(response as WorkerResponse));
    this.worker.on("error", (error) => this.die(error));
    this.worker.on("exit", (code) => this.die(code !== 0 ? new Error(`worker exited with code ${code}`) : new Error("worker exited")));
  }

  /** One answer settles one request; an answer nobody is waiting for is ignored (a late response to a dead caller). */
  private settle(response: WorkerResponse): void {
    const entry = this.pending.get(response.requestId);
    if (entry == null) return;
    this.pending.delete(response.requestId);
    this.lastActivityAt = Date.now();
    if (response.kind === "error") entry.reject(rebuildWorkerError(response));
    else entry.resolve(response);
  }

  /** The worker is gone: everything it owed is rejected with the reason, once. */
  private die(reason: unknown): void {
    if (this.isDead) return;
    const error = reason instanceof Error ? reason : new Error(String(reason));
    this.isDead = true;
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
    this.onExit(this);
  }

  send(build: (requestId: number) => object, transfer: readonly ArrayBuffer[] = []): Promise<WorkerResponse> {
    if (this.isDead) return Promise.reject(new Error("worker is no longer running"));
    this.lastActivityAt = Date.now();
    const requestId = this.nextRequestId++;
    const request = build(requestId);
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, {
        resolve: (response) => {
          this.lastActivityAt = Date.now();
          resolve(response);
        },
        reject: (error) => {
          this.lastActivityAt = Date.now();
          reject(error);
        },
      });
      this.worker.postMessage(request, [...transfer]);
    });
  }

  activityAt(): number {
    return this.lastActivityAt;
  }

  threadId(): number | null {
    return this.workerThreadId;
  }

  pid(): number | null {
    return this.workerPid;
  }

  /**
   * One request: the worker's request id, the body built for it, and — when the caller wants a field — the answer picked
   * apart with `pick`. Answer shapes are the worker's protocol, so each public method below names the field it reads.
   */
  private async ask<T>(kind: string, body: () => Record<string, unknown> = () => ({}), pick?: (response: WorkerResponse) => T): Promise<T | undefined> {
    const response = await this.send((requestId) => ({ kind, requestId, ...body() }));
    return pick?.(response);
  }

  async init(boot: WorkerBoot): Promise<void> {
    const identity = await this.ask("init", () => ({ agentId: boot.agentId, blobDbPath: boot.blobDbPath, busyTimeoutMs: boot.busyTimeoutMs }), (response) => ({
      threadId: response.threadId as number,
      pid: response.pid as number,
    }));
    this.workerThreadId = identity!.threadId;
    this.workerPid = identity!.pid;
  }

  async setBlob(blobId: Uint8Array, blobData: Uint8Array): Promise<void> {
    await this.ask("set-blob", () => ({ blobId, blobData }));
  }

  async getBlob(blobId: Uint8Array): Promise<Uint8Array | undefined> {
    return await this.ask("get-blob", () => ({ blobId }), (response) => response.blobData);
  }

  async findLatestRootBlobId(): Promise<Uint8Array | undefined> {
    return await this.ask("find-latest-root", undefined, (response) => response.rootId);
  }

  async clearBlobs(): Promise<void> {
    await this.ask("clear-blobs");
  }

  async clearStaleCheckpointRoots(retainedRootIdHex: string): Promise<number> {
    return (await this.ask("clear-stale-roots", () => ({ retainedRootIdHex }), (response) => response.deleted)) as number;
  }

  async collectGarbage(retainedRootIdHex: string, pendingWriteRetentionMs: number): Promise<unknown> {
    return await this.ask("collect-garbage", () => ({ retainedRootIdHex, pendingWriteRetentionMs }), (response) => response.result);
  }

  async verifyLegacyBlobRetirement(retainedRootIdHex: string, legacyBlobDbPath: string): Promise<unknown> {
    return await this.ask("verify-legacy-blob-retirement", () => ({ retainedRootIdHex, legacyBlobDbPath }), (response) => response.verdict);
  }

  /** Closing is best effort: a worker that cannot be asked to close is still terminated. */
  async close(): Promise<void> {
    if (this.isDead) return;
    try {
      await this.ask("close");
    } catch {
      // A worker that will not answer "close" is terminated below either way.
    }
    await this.worker.terminate();
  }
}

export const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000;
export const DEFAULT_MAX_WORKERS = 64;
export const DEFAULT_SWEEP_INTERVAL_MS = 30_000;

export interface AgentWorkerPoolOptions {
  readonly workerEntryPath?: string;
  readonly busyTimeoutMs?: number;
  readonly idleTimeoutMs?: number;
  readonly maxWorkers?: number;
  readonly sweepIntervalMs?: number;
  /** How a worker is created; the real thread unless a caller supplies one. */
  readonly createWorker?: CreateWorker;
}

/** The pool: one worker per store, retained while it is being used, swept when it is not. */
export class AgentWorkerPool {
  readonly workerEntryPath: string;
  readonly busyTimeoutMs: number;
  readonly idleTimeoutMs: number;
  readonly maxWorkers: number;
  readonly sweepIntervalMs: number;
  readonly connections = new Map<string, AgentWorkerConnection>();
  readonly activeOps = new Map<string, number>();
  readonly createWorker: CreateWorker;
  sweepTimer: NodeJS.Timeout | null = null;

  constructor(options: AgentWorkerPoolOptions = {}) {
    this.workerEntryPath = options.workerEntryPath ?? defaultWorkerEntryPath();
    this.busyTimeoutMs = options.busyTimeoutMs ?? 5_000;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.maxWorkers = options.maxWorkers ?? DEFAULT_MAX_WORKERS;
    this.sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.createWorker = options.createWorker ?? spawnWorker;
  }

  /** The worker for this store, started if it is not there and made room for if the pool is full. */
  async ensure(agentId: string, blobDbPath: string, legacyBlobDbPath?: string): Promise<AgentWorkerConnection> {
    const existing = this.connections.get(blobDbPath);
    if (existing != null) return existing;
    this.evictForCapacity();
    const boot: WorkerBoot = { agentId, blobDbPath, busyTimeoutMs: this.busyTimeoutMs, ...(legacyBlobDbPath == null ? {} : { legacyBlobDbPath }) };
    const connection = new AgentWorkerConnection(
      this.workerEntryPath,
      boot,
      (self) => {
        // A worker that died takes itself out of the pool; the sweep has nothing left to do when it was the last one.
        if (this.connections.get(blobDbPath) === self) {
          this.connections.delete(blobDbPath);
          if (this.connections.size === 0) this.stopSweep();
        }
      },
      this.createWorker,
    );
    this.connections.set(blobDbPath, connection);
    this.startSweep();
    await connection.init(boot);
    console.log(`[agent-isolation] spawned worker for agent ${agentId} on thread ${connection.threadId()} (pid ${connection.pid()}, active workers: ${this.connections.size})`);
    return connection;
  }

  /**
   * The only way the pool talks to a worker: the store is retained for the length of the operation, so the worker cannot be
   * evicted or swept from under the call, and it is released even when the operation throws.
   */
  private async withWorker<T>(args: { readonly agentId: string; readonly blobDbPath: string; readonly legacyBlobDbPath?: string | undefined }, operation: (connection: AgentWorkerConnection) => Promise<T>): Promise<T> {
    this.retain(args.blobDbPath);
    try {
      return await operation(await this.ensure(args.agentId, args.blobDbPath, args.legacyBlobDbPath));
    } finally {
      this.release(args.blobDbPath);
    }
  }

  private retain(blobDbPath: string): void {
    this.activeOps.set(blobDbPath, (this.activeOps.get(blobDbPath) ?? 0) + 1);
  }

  private release(blobDbPath: string): void {
    const next = (this.activeOps.get(blobDbPath) ?? 0) - 1;
    if (next <= 0) this.activeOps.delete(blobDbPath);
    else this.activeOps.set(blobDbPath, next);
  }

  private isRetained(blobDbPath: string): boolean {
    return (this.activeOps.get(blobDbPath) ?? 0) > 0;
  }

  async setBlob(agentId: string, blobDbPath: string, blobId: Uint8Array, blobData: Uint8Array, legacyBlobDbPath?: string): Promise<void> {
    await this.withWorker({ agentId, blobDbPath, ...(legacyBlobDbPath === undefined ? {} : { legacyBlobDbPath }) }, (connection) => connection.setBlob(blobId, blobData));
  }

  async getBlob(agentId: string, blobDbPath: string, blobId: Uint8Array, legacyBlobDbPath?: string): Promise<Uint8Array | undefined> {
    return await this.withWorker({ agentId, blobDbPath, ...(legacyBlobDbPath === undefined ? {} : { legacyBlobDbPath }) }, (connection) => connection.getBlob(blobId));
  }

  async findLatestRootBlobId(args: { readonly agentId: string; readonly blobDbPath: string; readonly legacyBlobDbPath?: string }): Promise<Uint8Array | undefined> {
    return await this.withWorker(args, (connection) => connection.findLatestRootBlobId());
  }

  async clearBlobs(agentId: string, blobDbPath: string, legacyBlobDbPath?: string): Promise<void> {
    await this.withWorker({ agentId, blobDbPath, ...(legacyBlobDbPath === undefined ? {} : { legacyBlobDbPath }) }, (connection) => connection.clearBlobs());
  }

  async clearStaleCheckpointRoots(agentId: string, blobDbPath: string, retainedRootIdHex: string, legacyBlobDbPath?: string): Promise<number> {
    return await this.withWorker({ agentId, blobDbPath, ...(legacyBlobDbPath === undefined ? {} : { legacyBlobDbPath }) }, (connection) => connection.clearStaleCheckpointRoots(retainedRootIdHex));
  }

  async collectConversationGarbage(args: {
    readonly agentId: string;
    readonly blobDbPath: string;
    readonly retainedRootIdHex: string;
    readonly pendingWriteRetentionMs: number;
    readonly legacyBlobDbPath?: string;
  }): Promise<unknown> {
    return await this.withWorker(args, (connection) => connection.collectGarbage(args.retainedRootIdHex, args.pendingWriteRetentionMs));
  }

  async verifyLegacyBlobRetirement(args: {
    readonly agentId: string;
    readonly blobDbPath: string;
    readonly retainedRootIdHex: string;
    readonly legacyBlobDbPath: string;
  }): Promise<unknown> {
    return await this.withWorker(args, (connection) => connection.verifyLegacyBlobRetirement(args.retainedRootIdHex, args.legacyBlobDbPath));
  }

  async closeStore(blobDbPath: string): Promise<void> {
    const connection = this.connections.get(blobDbPath);
    if (connection == null) return;
    this.connections.delete(blobDbPath);
    if (this.connections.size === 0) this.stopSweep();
    await connection.close();
  }

  async closeAll(): Promise<void> {
    this.stopSweep();
    const all = [...this.connections.values()];
    this.connections.clear();
    await Promise.all(all.map((connection) => connection.close()));
  }

  activeWorkerCount(): number {
    return this.connections.size;
  }

  describeWorkers(): Array<{ blobDbPath: string; threadId: number | null; pid: number | null }> {
    return [...this.connections].map(([blobDbPath, connection]) => ({ blobDbPath, threadId: connection.threadId(), pid: connection.pid() }));
  }

  /** Evicts the least recently used worker that is not in the middle of a call; if every worker is retained, none is. */
  private evictForCapacity(): void {
    if (this.connections.size < this.maxWorkers) return;
    let victimPath: string | null = null;
    let oldestActivity = Infinity;
    for (const [blobDbPath, connection] of this.connections) {
      if (this.isRetained(blobDbPath)) continue;
      if (connection.activityAt() < oldestActivity) {
        oldestActivity = connection.activityAt();
        victimPath = blobDbPath;
      }
    }
    if (victimPath == null) return;
    const victim = this.connections.get(victimPath);
    if (victim == null) return;
    this.connections.delete(victimPath);
    void victim.close();
  }

  private startSweep(): void {
    if (this.sweepTimer != null) return;
    // An idle timeout of infinity is a pool that never sweeps: a timer that fires forever to do nothing is not wanted.
    if (!Number.isFinite(this.idleTimeoutMs)) return;
    const timer = setInterval(() => this.sweepIdle(), this.sweepIntervalMs);
    timer.unref();
    this.sweepTimer = timer;
  }

  private stopSweep(): void {
    if (this.sweepTimer == null) return;
    clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  private sweepIdle(): void {
    const now = Date.now();
    for (const [blobDbPath, connection] of [...this.connections]) {
      if (this.isRetained(blobDbPath)) continue;
      if (now - connection.activityAt() < this.idleTimeoutMs) continue;
      this.connections.delete(blobDbPath);
      void connection.close();
    }
    if (this.connections.size === 0) this.stopSweep();
  }
}
