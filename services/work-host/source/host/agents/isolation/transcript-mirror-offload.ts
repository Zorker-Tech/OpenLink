/**
 * Offloading a conversation's transcript mirror to a worker.
 *
 * The offload keeps one worker per conversation, hands it the checkpoint to mirror and the databases to read it from,
 * waits for what the worker says, and falls back to mirroring in the caller's own thread when a worker cannot be had:
 * a mirror that cannot be offloaded must not become a mirror that did not happen.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { errorLogTag } from "../../../shared/errors/summary.ts";
import { invariant } from "../../../shared/invariant.ts";
import { reportHostDiagnostic } from "../../host-diagnostics.ts";
import {
  LegacyFileTranscriptMirror,
  type LegacyTranscriptBlobStore,
  type LegacyTranscriptState
} from "../../transcript/mirror/legacy-transcript-mirror.ts";
import { WorkerBlobStore } from "./worker-blob-store.ts";

export const DEFAULT_MIRROR_WORKERS = 2;

export function defaultMirrorWorkerEntryPath(): string {
  const bundleDirectory =
    typeof __dirname === "string"
      ? __dirname
      : dirname(fileURLToPath(import.meta.url));
  return join(
    bundleDirectory,
    "agent-isolation",
    "transcript-mirror-worker.cjs",
  );
}

export interface TranscriptMirrorJob {
  readonly conversationId: string;
  readonly stateBlobId: Uint8Array<ArrayBuffer>;
  readonly blobDbPaths: readonly string[];
  readonly transcriptsDir: string;
}

interface MirrorWorkerResponse {
  readonly kind: string;
  readonly requestId: number;
  readonly written?: boolean;
  readonly message?: string;
}

interface PendingMirrorRequest {
  resolve(workerResponse: MirrorWorkerResponse): void;
  reject(error: Error): void;
}

class MirrorWorkerConnection {
  readonly worker: Worker;
  readonly pending = new Map<number, PendingMirrorRequest>();
  private nextSequence = 1;
  private isDead = false;

  constructor(
    workerEntryPath: string,
    readonly whenExited: (workerConnection: MirrorWorkerConnection) => void
  ) {
    this.worker = new Worker(workerEntryPath);
    this.worker.on("message", workerResponse => {
      this.onMessage(workerResponse as MirrorWorkerResponse);
    });
    this.worker.on("error", error => this.die(error));
    this.worker.on("exit", code => {
      this.die(new Error(`mirror worker exited with code ${code}`));
    });
  }

  private onMessage(workerResponse: MirrorWorkerResponse): void {
    const entryItem = this.pending.get(workerResponse.requestId);
    if (entryItem == null) return;
    this.pending.delete(workerResponse.requestId);

    if (workerResponse.kind === "error") {
      entryItem.reject(new Error(workerResponse.message));
    } else {
      entryItem.resolve(workerResponse);
    }
  }

  private die(reason: unknown): void {
    if (this.isDead) return;
    this.isDead = true;
    const error = reason instanceof Error ? reason : new Error(String(reason));
    for (const entryItem of this.pending.values()) entryItem.reject(error);
    this.pending.clear();
    this.whenExited(this);
  }

  isAlive(): boolean {
    return !this.isDead;
  }

  private send(
    buildRequest: (requestId: number) => object,
    transferList: ArrayBuffer[] = []
  ): Promise<MirrorWorkerResponse> {
    if (this.isDead) {
      return Promise.reject(new Error("mirror worker is no longer running"));
    }

    const requestId = this.nextSequence++;
    return new Promise<MirrorWorkerResponse>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      this.worker.postMessage(buildRequest(requestId), transferList);
    });
  }

  async write(mirrorJob: TranscriptMirrorJob): Promise<boolean> {
    const workerResponse = await this.send(
      requestId => ({
        kind: "mirror-write",
        requestId,
        ...mirrorJob
      }),
      [mirrorJob.stateBlobId.buffer]
    );
    return workerResponse.written as boolean;
  }

  async close(): Promise<void> {
    if (this.isDead) return;
    try {
      await this.send(requestId => ({ kind: "close", requestId }));
    } catch {
      // A worker that died while closing has already rejected all callers.
    }
    await this.worker.terminate();
  }
}

interface MirrorResolver {
  resolve(shipped: boolean): void;
  reject(error: Error): void;
}

interface QueuedMirrorJob {
  job: TranscriptMirrorJob;
  readonly resolvers: MirrorResolver[];
}

interface ConversationLane {
  isRunning: boolean;
  queued: QueuedMirrorJob | null;
}

export interface TranscriptMirrorOffloadPoolOptions {
  readonly workerEntryPath?: string;
  readonly maxWorkers?: number;
}

/**
 * Consistently shards conversations across workers and serializes writes per
 * conversation. While one write is running, newer checkpoints coalesce into a
 * single queued job; every waiter resolves from that newest write.
 */
export class TranscriptMirrorOffloadPool {
  readonly workerEntryPath: string;
  readonly maxWorkers: number;
  readonly workers: Array<MirrorWorkerConnection | null>;
  readonly lanes = new Map<string, ConversationLane>();
  private isClosed = false;

  constructor(settings: TranscriptMirrorOffloadPoolOptions = {}) {
    this.workerEntryPath = settings.workerEntryPath ?? defaultMirrorWorkerEntryPath();
    this.maxWorkers = settings.maxWorkers ?? DEFAULT_MIRROR_WORKERS;
    this.workers = new Array(this.maxWorkers).fill(null);
  }

  workerIndexFor(conversationId: string): number {
    let hash = 0;
    for (let workerSlot = 0; workerSlot < conversationId.length; workerSlot += 1) {
      hash = hash * 31 + conversationId.charCodeAt(workerSlot) | 0;
    }
    return Math.abs(hash) % this.maxWorkers;
  }

  private connectionFor(
    conversationId: string
  ): MirrorWorkerConnection {
    invariant(!this.isClosed, "mirror offload pool is closed");

    const workerSlot = this.workerIndexFor(conversationId);
    const reusableConnection = this.workers[workerSlot];
    if (reusableConnection != null && reusableConnection.isAlive()) return reusableConnection;

    const whenExited = (settlingConnection: MirrorWorkerConnection) => {
      if (this.workers[workerSlot] === settlingConnection) this.workers[workerSlot] = null;
    };
    const workerConnection = new MirrorWorkerConnection(this.workerEntryPath, whenExited);
    this.workers[workerSlot] = workerConnection;
    return workerConnection;
  }

  write(mirrorJob: TranscriptMirrorJob): Promise<boolean> {
    if (this.isClosed) {
      return Promise.reject(new Error("mirror offload pool is closed"));
    }

    const conversationLane = this.lanes.get(mirrorJob.conversationId) ?? {
      isRunning: false,
      queued: null
    };
    this.lanes.set(mirrorJob.conversationId, conversationLane);

    return new Promise<boolean>((resolve, reject) => {
      const waiter = { resolve, reject };
      if (conversationLane.isRunning) {
        if (conversationLane.queued == null) {
          conversationLane.queued = { job: mirrorJob, resolvers: [waiter] };
        } else {
          conversationLane.queued.job = mirrorJob;
          conversationLane.queued.resolvers.push(waiter);
        }
        return;
      }

      conversationLane.isRunning = true;
      void this.runJob(conversationLane, { job: mirrorJob, resolvers: [waiter] });
    });
  }

  private async runJob(
    conversationLane: ConversationLane,
    entryItem: QueuedMirrorJob
  ): Promise<void> {
    try {
      const shipped = await this.connectionFor(entryItem.job.conversationId)
        .write(entryItem.job);
      for (const waiter of entryItem.resolvers) waiter.resolve(shipped);
    } catch (reason) {
      const error = reason instanceof Error ? reason : new Error(String(reason));
      for (const waiter of entryItem.resolvers) waiter.reject(error);
    } finally {
      const next = conversationLane.queued;
      conversationLane.queued = null;
      if (next != null) {
        void this.runJob(conversationLane, next);
      } else {
        conversationLane.isRunning = false;
        this.lanes.delete(entryItem.job.conversationId);
      }
    }
  }

  async closeAll(): Promise<void> {
    this.isClosed = true;
    const open = this.workers.filter(
      (worker): worker is MirrorWorkerConnection => worker != null
    );
    this.workers.fill(null);
    await Promise.all(open.map(worker => worker.close()));
  }
}

export interface InlineTranscriptMirror<State, Store> {
  writeIncremental(
    ctx: unknown,
    conversationId: string,
    state: State,
    blobStore: Store,
    previousRootPromptCount: number
  ): Promise<number | null>;
  writeFull(
    ctx: unknown,
    conversationId: string,
    state: State,
    blobStore: Store
  ): Promise<boolean>;
}

export interface OffloadingTranscriptMirrorOptions {
  readonly blobDbPaths: string[];
  readonly transcriptsDir: string;
}

function warnStaleMirror(
  conversationId: string,
  reason: "full-write-failed" | "worker-unavailable" | "worker-write-failed",
  error?: unknown
): void {
  reportHostDiagnostic({
    kind: "transcript_mirror_stale",
    agentId: conversationId,
    reason,
    ...(error === undefined ? {} : { errorClass: errorLogTag(error) })
  });
}

export class OffloadingTranscriptMirror<
  State extends { readonly rootPromptMessagesJson: readonly unknown[] },
  Store
> {
  previousRootPromptCount: number;
  private writeLane: Promise<void> = Promise.resolve();

  constructor(
    readonly inline: InlineTranscriptMirror<State, Store>,
    readonly pool: () => TranscriptMirrorOffloadPool,
    readonly options: OffloadingTranscriptMirrorOptions,
    previousRootPromptCount = 0
  ) {
    this.previousRootPromptCount = previousRootPromptCount;
  }

  static forTranscriptsDir(
    pool: () => TranscriptMirrorOffloadPool,
    settings: OffloadingTranscriptMirrorOptions,
    previousRootPromptCount = 0
  ): OffloadingTranscriptMirror<LegacyTranscriptState, LegacyTranscriptBlobStore> {
    return new OffloadingTranscriptMirror(
      new LegacyFileTranscriptMirror(settings.transcriptsDir),
      pool,
      settings,
      previousRootPromptCount
    );
  }

  private async writeSerialized(
    ctx: unknown,
    conversationId: string,
    state: State,
    blobStore: Store,
    stateBlobId?: Uint8Array
  ): Promise<void> {
    const writtenCount = await this.inline.writeIncremental(
      ctx,
      conversationId,
      state,
      blobStore,
      this.previousRootPromptCount
    );
    if (writtenCount != null) {
      this.previousRootPromptCount = writtenCount;
      return;
    }

    if (!(blobStore instanceof WorkerBlobStore)) {
      const shipped = await this.inline.writeFull(
        ctx,
        conversationId,
        state,
        blobStore
      );
      if (shipped) {
        this.previousRootPromptCount = state.rootPromptMessagesJson.length;
      } else {
        warnStaleMirror(conversationId, "full-write-failed");
      }
      return;
    }

    if (stateBlobId == null || stateBlobId.length === 0) {
      warnStaleMirror(conversationId, "worker-unavailable");
      return;
    }

    try {
      const shipped = await this.pool().write({
        conversationId,
        stateBlobId: new Uint8Array(stateBlobId),
        blobDbPaths: this.options.blobDbPaths,
        transcriptsDir: this.options.transcriptsDir
      });
      if (shipped) {
        this.previousRootPromptCount = state.rootPromptMessagesJson.length;
      } else {
        warnStaleMirror(conversationId, "worker-write-failed");
      }
    } catch (error) {
      warnStaleMirror(conversationId, "worker-write-failed", error);
    }
  }

  write(
    ctx: unknown,
    conversationId: string,
    state: State,
    blobStore: Store,
    stateBlobId?: Uint8Array
  ): Promise<void> {
    const write = this.writeLane.then(() => this.writeSerialized(
      ctx,
      conversationId,
      state,
      blobStore,
      stateBlobId
    ));
    this.writeLane = write.then(
      () => undefined,
      () => undefined
    );
    return write;
  }
}
