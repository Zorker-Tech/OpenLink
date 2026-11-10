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
import { parseAgentStoreWorkerReply } from "./agent-worker-protocol.ts";
import type {
  AgentStoreWorkerBoot,
  AgentStoreWorkerCommand,
  AgentStoreWorkerCommandFor,
  AgentStoreWorkerOperation,
  AgentStoreWorkerSuccess,
  AgentStoreWorkerSuccessFor,
} from "./agent-worker-protocol.ts";

export function defaultWorkerEntryPath(): string {
  if (typeof __dirname === "string") return join(__dirname, "agent-store-worker.cjs");
  const moduleUrl = import.meta.url;
  const here = dirname(fileURLToPath(moduleUrl));
  const extension = moduleUrl.endsWith(".ts") ? ".ts" : ".js";
  return join(here, `agent-store-worker${extension}`);
}

/** A call waiting for its worker reply. */
interface PendingWorkerRequest {
  resolve(response: AgentStoreWorkerSuccess): void;
  reject(error: Error): void;
}

/** A worker's error, as close to the one it threw as a message can carry: its name and code survive the trip. */
export function rebuildWorkerError(response: { readonly message: string; readonly name?: string; readonly code?: string }): Error {
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
type CreateWorker = (entryPath: string, boot: AgentStoreWorkerBoot) => Worker;

const spawnWorker: CreateWorker = (entryPath, boot) => new Worker(entryPath, { workerData: boot, stdout: true, stderr: true });

/** One worker and the requests it owes an answer to. */
export class AgentWorkerConnection {
  readonly worker: Worker;
  readonly pending = new Map<number, PendingWorkerRequest>();
  nextCallId = 1;
  isDead = false;
  lastActivityAt = Date.now();
  workerThreadId: number | null = null;
  workerPid: number | null = null;

  constructor(workerEntryPath: string, boot: AgentStoreWorkerBoot, readonly onExit: (self: AgentWorkerConnection) => void, createWorker: CreateWorker = spawnWorker) {
    this.worker = createWorker(workerEntryPath, boot);
    forwardStream(this.worker.stdout, (message) => console.log(message));
    forwardStream(this.worker.stderr, (message) => console.error(message));
    this.worker.on("message", (response) => this.settle(response));
    this.worker.on("error", (error) => this.die(error));
    this.worker.on("exit", (code) => this.die(code !== 0 ? new Error(`worker exited with code ${code}`) : new Error("worker exited")));
  }

  /** One reply settles one call; an answer nobody is waiting for is ignored. */
  private settle(message: unknown): void {
    const response = parseAgentStoreWorkerReply(message);
    if (response == null) {
      this.die(new TypeError("worker returned an invalid reply"));
      return;
    }
    const entry = this.pending.get(response.callId);
    if (entry == null) return;
    this.pending.delete(response.callId);
    this.lastActivityAt = Date.now();
    if (response.outcome === "failure") entry.reject(rebuildWorkerError(response));
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

  send(build: (callId: number) => AgentStoreWorkerCommand, transfer: readonly ArrayBuffer[] = []): Promise<AgentStoreWorkerSuccess> {
    if (this.isDead) return Promise.reject(new Error("worker is no longer running"));
    this.lastActivityAt = Date.now();
    const callId = this.nextCallId++;
    const request = build(callId);
    return new Promise((resolve, reject) => {
      this.pending.set(callId, {
        resolve: (response) => {
          this.lastActivityAt = Date.now();
          resolve(response);
        },
        reject: (error) => {
          this.lastActivityAt = Date.now();
          reject(error);
        },
      });
      try {
        this.worker.postMessage(request, [...transfer]);
      } catch (error) {
        this.pending.delete(callId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
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
   * Send one typed operation and read its operation-specific reply when the caller needs a value.
   */
  private async ask<Operation extends AgentStoreWorkerOperation, Value = void>(
    operation: Operation,
    build: (callId: number) => AgentStoreWorkerCommandFor<Operation>,
    pick?: (response: AgentStoreWorkerSuccessFor<Operation>) => Value,
  ): Promise<Value | undefined> {
    const response = await this.send(build);
    if (response.operation !== operation) throw new TypeError(`worker answered ${response.operation} for ${operation}`);
    return pick?.(response as AgentStoreWorkerSuccessFor<Operation>);
  }

  async init(): Promise<void> {
    const identity = await this.ask("worker.identify", (callId) => ({ operation: "worker.identify", callId }), (response) => ({
      threadId: response.workerThreadId,
      pid: response.processId,
    }));
    this.workerThreadId = identity!.threadId;
    this.workerPid = identity!.pid;
  }

  async setBlob(blobId: Uint8Array, blobData: Uint8Array): Promise<void> {
    await this.ask("blob.write", (callId) => ({ operation: "blob.write", callId, blobId, blobBytes: blobData }));
  }

  async getBlob(blobId: Uint8Array): Promise<Uint8Array | undefined> {
    return await this.ask("blob.read", (callId) => ({ operation: "blob.read", callId, blobId }), (response) => response.blobBytes);
  }

  async findLatestRootBlobId(): Promise<Uint8Array | undefined> {
    return await this.ask("root.find-latest", (callId) => ({ operation: "root.find-latest", callId }), (response) => response.latestRootId);
  }

  async clearBlobs(): Promise<void> {
    await this.ask("blob.clear", (callId) => ({ operation: "blob.clear", callId }));
  }

  async clearStaleCheckpointRoots(retainedRootIdHex: string): Promise<number> {
    return (await this.ask("checkpoint.prune", (callId) => ({ operation: "checkpoint.prune", callId, retainedRootIdHex }), (response) => response.deletedCount)) as number;
  }

  async collectGarbage(retainedRootIdHex: string, pendingWriteRetentionMs: number): Promise<unknown> {
    return await this.ask("conversation.collect-garbage", (callId) => ({ operation: "conversation.collect-garbage", callId, retainedRootIdHex, pendingWriteRetentionMs }), (response) => response.garbageReport);
  }

  async verifyLegacyBlobRetirement(retainedRootIdHex: string, legacyBlobDbPath: string): Promise<unknown> {
    return await this.ask("legacy.verify-retirement", (callId) => ({ operation: "legacy.verify-retirement", callId, retainedRootIdHex, legacyBlobDbPath }), (response) => response.retirementVerdict);
  }

  /** Closing is best effort: a worker that cannot be asked to close is still terminated. */
  async close(): Promise<void> {
    if (this.isDead) return;
    try {
      await this.ask("worker.close", (callId) => ({ operation: "worker.close", callId }));
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
    const boot: AgentStoreWorkerBoot = { agentId, blobDbPath, busyTimeoutMs: this.busyTimeoutMs, ...(legacyBlobDbPath == null ? {} : { legacyBlobDbPath }) };
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
    await connection.init();
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
