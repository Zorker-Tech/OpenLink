/**
 * The content search, as a service.
 *
 * The index is built and refreshed in the background, a search reads it rather than the transcripts, and what a search
 * answers with says which agent and which entry matched. This module is the lifecycle around that index: opening and
 * migrating its database, queueing the work a writer asks for one job at a time, replacing an index one too many reads
 * found corrupt, respawning a worker that went away, and saying so through a health reporter when a limit is reached.
 */
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { DatabaseSync } from "node:sqlite";
import { errorLogTag } from "../../../shared/errors/summary.ts";
import { SQLITE_DB_SIDECAR_SUFFIXES } from "../../storage/store-db.ts";
import { isSqliteCorruptError } from "../../storage/sqlite-busy.ts";
import {
  ensureSearchIndexSchema,
  openSearchIndexDb,
  readReconcileDone,
  readSearchIndexSchemaVersion,
  SEARCH_INDEX_SCHEMA_VERSION,
  searchMedia,
  searchMessages,
  stampSearchIndexSchemaVersion,
} from "./search-index-db.ts";
import type { IndexEntry, SearchIndexJob } from "./search-index-writer.ts";

export const MAX_INDEX_REBUILDS = 3;
export const MAX_WORKER_RESPAWNS = 3;
export const MAX_FAILED_JOB_RECONCILES = 3;
export const SEARCH_INDEX_DISPOSE_TIMEOUT_MS = 2_000;

export interface SearchIndexJobFailure {
  readonly ok: false;
  readonly message: string;
  readonly isIndexCorrupt: boolean;
  readonly isWorkerUnavailable: boolean;
}

export type SearchIndexJobResult = { readonly ok: true } | SearchIndexJobFailure;

export interface SearchIndexJobPort {
  post(job: SearchIndexJob): Promise<SearchIndexJobResult>;
  terminate(): Promise<void>;
}

/** The packaged parts of the host bundle a search-index worker entry sits under. */
const WORKER_BUNDLE_PARTS = ["extensions", "content-search", "search-index-worker.cjs"] as const;

/** Where the host bundle keeps the extension workers, whatever loaded this module. */
const hostBundleDirectory = typeof __dirname === "string" ? __dirname : dirname(fileURLToPath(import.meta.url));

export function defaultWorkerEntryPath(): string {
  return join(hostBundleDirectory, ...WORKER_BUNDLE_PARTS);
}

/** What a worker answers for one request; only a failure carries a reason and a kind. */
interface WorkerResponse {
  requestId: number;
  ok: boolean;
  message?: string;
  isIndexCorrupt?: boolean;
}

/** The answer a request gets when its worker is already gone. */
const missingWorkerFailure = (): SearchIndexJobFailure => ({
  ok: false,
  message: "search-index worker is no longer running",
  isIndexCorrupt: false,
  isWorkerUnavailable: true,
});

export class WorkerSearchIndexJobPort implements SearchIndexJobPort {
  private readonly worker: Worker;
  private readonly waiting = new Map<number, (result: SearchIndexJobResult) => void>();
  private nextRequestId = 1;
  private isDead = false;

  constructor(
    entryPath: string,
    config: { indexDbPath: string; agentsRootDir: string },
  ) {
    this.worker = new Worker(entryPath, { workerData: config });
    this.worker.on("message", (response: WorkerResponse) => this.settle(response));
    this.worker.on("error", (error) =>
      this.die(error instanceof Error ? error : new Error(String(error))),
    );
    this.worker.on("exit", (code) =>
      this.die(new Error(`search-index worker exited (${code})`)),
    );
  }

  /** Answers the request a worker returned, when that request is still waiting. */
  private settle(response: WorkerResponse): void {
    const resolve = this.waiting.get(response.requestId);
    if (resolve == null) return;
    this.waiting.delete(response.requestId);
    resolve(
      response.ok
        ? { ok: true }
        : {
            ok: false,
            message: response.message ?? "search index job failed",
            isIndexCorrupt: response.isIndexCorrupt === true,
            isWorkerUnavailable: false,
          },
    );
  }

  /** The worker is gone: every request still waiting is answered as a worker failure, and later posts answer at once. */
  private die(error: Error): void {
    if (this.isDead) return;
    this.isDead = true;
    const failure: SearchIndexJobFailure = {
      ok: false,
      message: error.message,
      isIndexCorrupt: false,
      isWorkerUnavailable: true,
    };
    for (const resolve of this.waiting.values()) resolve(failure);
    this.waiting.clear();
  }

  post(job: SearchIndexJob): Promise<SearchIndexJobResult> {
    if (this.isDead) return Promise.resolve(missingWorkerFailure());
    const requestId = this.nextRequestId++;
    return new Promise((resolve) => {
      this.waiting.set(requestId, resolve);
      this.worker.postMessage({ requestId, job });
    });
  }

  async terminate(): Promise<void> {
    this.die(new Error("search-index worker terminated"));
    await this.worker.terminate();
  }
}

export type TranscriptMutation =
  | {
      readonly kind: "entries-upserted";
      readonly agentId: string;
      readonly entries: readonly IndexEntry[];
    }
  | {
      readonly kind: "entry-deleted";
      readonly agentId: string;
      readonly entryId: string;
    }
  | {
      readonly kind: "conversation-cleared" | "agent-removed" | "agent-needs-reindex";
      readonly agentId: string;
    };

export interface SearchIndexHealth {
  readonly kind: string;
  readonly [key: string]: unknown;
}

/** What this service keeps of its own: the open index, its one worker, and the counters that bound both. */
export class SlateSearchIndexService {
  private readonly indexPath: string;
  private readonly agentsRoot: string;
  private readonly makeJobPort: (
    config: { indexDbPath: string; agentsRootDir: string },
  ) => SearchIndexJobPort;
  private readonly shutdownDeadline: {
    run<T>(operation: () => Promise<T>): Promise<T>;
  };
  private readonly publish: (health: SearchIndexHealth) => void;
  private database: DatabaseSync | undefined;
  private workerPort: SearchIndexJobPort | undefined;
  private unavailable = false;
  private disposed = false;
  private reconcileDone = false;
  private rebuildPending = false;
  private pendingReindexes = 0;
  private rebuilds = 0;
  private workerRespawns = 0;
  private failedReconciles = 0;
  private jobQueue: Promise<void> = Promise.resolve();

  constructor(options: {
    readonly indexDbPath: string;
    readonly agentsRootDir: string;
    readonly createJobPort?: (
      config: { indexDbPath: string; agentsRootDir: string },
    ) => SearchIndexJobPort;
    readonly workerEntryPath?: string;
    readonly disposeDeadline: {
      run<T>(operation: () => Promise<T>): Promise<T>;
    };
    readonly report?: (health: SearchIndexHealth) => void;
  }) {
    this.indexPath = options.indexDbPath;
    this.agentsRoot = options.agentsRootDir;
    this.shutdownDeadline = options.disposeDeadline;
    this.publish = options.report ?? (() => {});
    const entryPath = options.workerEntryPath ?? defaultWorkerEntryPath();
    this.makeJobPort =
      options.createJobPort ??
      ((config) => new WorkerSearchIndexJobPort(entryPath, config));
  }

  /** Whether this service can take work at all: it is neither stopped nor unavailable, and an index is open. */
  private get canServe(): boolean {
    return !this.disposed && !this.unavailable && this.database != null;
  }

  /** Whether an index is open to read from. */
  private get canRead(): boolean {
    return this.database != null && !this.unavailable;
  }

  start(): void {
    if (this.disposed || this.unavailable) return;
    if (this.database == null) {
      try {
        this.database = this.openIndex();
      } catch (error) {
        this.markUnavailable("open", error);
        return;
      }
      this.reconcileDone = this.readReconcileState();
    }
    this.queue({ kind: "reconcile" });
  }

  get isSearchReady(): boolean {
    return (
      this.database != null &&
      !this.unavailable &&
      this.reconcileDone &&
      this.pendingReindexes === 0
    );
  }

  /** Reads one search, answering nothing rather than failing when the index cannot be read. */
  private search<T>(stage: string, read: (database: DatabaseSync) => T): T | null {
    const database = this.database;
    if (database == null || this.unavailable) return null;
    try {
      return read(database);
    } catch (error) {
      this.handleIndexFailure(stage, error);
      return null;
    }
  }

  searchMessages(query: string, limit: number) {
    return this.search("search-messages", (database) => searchMessages(database, query, limit));
  }

  searchMedia(query: string, limit: number) {
    return this.search("search-media", (database) => searchMedia(database, query, limit));
  }

  /**
   * Applies what a writer changed: entries are queued as one upsert, a deletion asks the worker to delete one entry, and
   * a conversation that was cleared or an agent that was removed both empty that agent's part of the index. A reindex
   * request is counted so search is not called ready while it waits.
   */
  applyMutation(mutation: TranscriptMutation): void {
    if (mutation.kind === "entries-upserted") return this.upsertEntries(mutation.agentId, mutation.entries);
    if (mutation.kind === "entry-deleted") return this.deleteEntry(mutation.agentId, mutation.entryId);
    if (mutation.kind === "conversation-cleared" || mutation.kind === "agent-removed") return this.clearAgent(mutation.agentId);
    if (mutation.kind === "agent-needs-reindex") return this.requestReindex(mutation.agentId);
  }

  private upsertEntries(agentId: string, entries: readonly IndexEntry[]): void {
    if (entries.length === 0) return;
    this.queue({ kind: "upsert-entries", agentId, entries });
  }

  private deleteEntry(agentId: string, entryId: string): void {
    this.queue({ kind: "delete-entry", agentId, entryId });
  }

  private clearAgent(agentId: string): void {
    this.queue({ kind: "clear-agent", agentId });
  }

  private requestReindex(agentId: string): void {
    if (!this.canServe) return;
    this.pendingReindexes += 1;
    this.queue({ kind: "reindex-agents", agentIds: [agentId] });
  }

  whenIdle(): Promise<void> {
    return this.jobQueue;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.shutdownDeadline
      .run(async () => await this.jobQueue)
      .catch((error) => {
        this.publish({ kind: "dispose_drain_cut", errorClass: errorLogTag(error) });
      });
    await this.terminateWorker(this.workerPort, "dispose");
    this.workerPort = undefined;
    this.closeDatabase();
  }

  /** Stops one worker port, reporting a failure rather than throwing it. */
  private async terminateWorker(
    port: SearchIndexJobPort | undefined,
    stage: string,
  ): Promise<void> {
    if (port == null) return;
    await port.terminate().catch((error) => {
      this.publish({ kind: "worker_terminate_failed", stage, errorClass: errorLogTag(error) });
    });
  }

  /** Closes the open database, ignoring a close that fails. */
  private closeDatabase(): void {
    try {
      this.database?.close();
    } catch {}
    this.database = undefined;
  }

  /** Stops taking work for the rest of this service's life, reports why, and lets go of the index and the worker. */
  private markUnavailable(stage: string, error: unknown): void {
    this.unavailable = true;
    const port = this.workerPort;
    this.workerPort = undefined;
    void this.terminateWorker(port, "unavailable teardown");
    this.closeDatabase();
    this.publish({ kind: "unavailable", stage, errorClass: errorLogTag(error) });
  }

  private readReconcileState(): boolean {
    const database = this.database;
    if (database == null) return false;
    try {
      return readReconcileDone(database);
    } catch {
      return false;
    }
  }

  /**
   * Opens the index, replacing its files when they cannot be opened or are not this version's schema. An index still at
   * version zero with nothing in it has simply never been stamped, so it is stamped rather than replaced.
   */
  private openIndex(): DatabaseSync {
    mkdirSync(dirname(this.indexPath), { recursive: true });
    let database: DatabaseSync;
    try {
      database = openSearchIndexDb(this.indexPath);
      ensureSearchIndexSchema(database);
    } catch (error) {
      if (isFts5MissingError(error)) throw error;
      return this.recreateIndexFile();
    }
    const version = readSearchIndexSchemaVersion(database);
    if (version === SEARCH_INDEX_SCHEMA_VERSION) return database;
    if (version === 0 && this.countIndexedMessages(database) === 0) {
      stampSearchIndexSchemaVersion(database);
      return database;
    }
    try {
      database.close();
    } catch {}
    return this.recreateIndexFile();
  }

  /** A fresh index over the same path, stamped as this schema's version. */
  private recreateIndexFile(): DatabaseSync {
    this.removeIndexFiles();
    const database = openSearchIndexDb(this.indexPath);
    ensureSearchIndexSchema(database);
    stampSearchIndexSchemaVersion(database);
    return database;
  }

  /** Removes the index and every sidecar file sqlite may have left with it. */
  private removeIndexFiles(): void {
    for (const suffix of ["", ...SQLITE_DB_SIDECAR_SUFFIXES]) {
      rmSync(`${this.indexPath}${suffix}`, { force: true });
    }
  }

  private countIndexedMessages(database: DatabaseSync): number {
    try {
      const row = database.prepare("SELECT COUNT(*) AS count FROM messages").get() as
        | { count?: unknown }
        | undefined;
      return typeof row?.count === "number" ? row.count : 0;
    } catch {
      return 0;
    }
  }

  /** One failed read: a corrupt index schedules a rebuild, and any other failure is only reported. */
  private handleIndexFailure(stage: string, error: unknown): void {
    if (this.disposed || this.unavailable) return;
    if (isSqliteCorruptError(error)) {
      this.scheduleRebuild(stage, error);
      return;
    }
    this.publish({ kind: "stage_failed", stage, errorClass: errorLogTag(error) });
  }

  /**
   * Replaces a corrupt index behind the job queue, or stops the service once too many rebuilds have been needed. The
   * reconcile that follows is queued after the replacement, so it runs against the new file.
   */
  private scheduleRebuild(stage: string, error: unknown): void {
    if (this.disposed || this.unavailable || this.rebuildPending) return;
    this.rebuilds += 1;
    if (this.rebuilds > MAX_INDEX_REBUILDS) {
      this.markUnavailable(stage, error);
      return;
    }
    this.publish({ kind: "corrupt_rebuild", stage, count: this.rebuilds });
    this.reconcileDone = false;
    this.rebuildPending = true;
    const port = this.workerPort;
    this.workerPort = undefined;
    this.jobQueue = this.jobQueue
      .then(async () => {
        await this.terminateWorker(port, "rebuild");
        this.closeDatabase();
        this.database = this.recreateIndexFile();
      })
      .catch((rebuildError) => this.markUnavailable("rebuild", rebuildError))
      .finally(() => {
        this.rebuildPending = false;
      });
    this.queue({ kind: "reconcile" });
  }

  /** The one worker port this service posts jobs through, made on first use. */
  private worker(): SearchIndexJobPort {
    if (this.workerPort == null) {
      this.workerPort = this.makeJobPort({
        indexDbPath: this.indexPath,
        agentsRootDir: this.agentsRoot,
      });
    }
    return this.workerPort;
  }

  /** Puts one job on the single queue, reporting a dispatch that throws rather than letting it stop the queue. */
  private queue(job: SearchIndexJob): void {
    if (!this.canServe) return;
    this.jobQueue = this.jobQueue
      .then(() => this.runJob(job))
      .catch((error) => {
        this.publish({ kind: "dispatch_failed", errorClass: errorLogTag(error) });
      });
  }

  private async runJob(job: SearchIndexJob): Promise<void> {
    try {
      await this.dispatchJob(job);
    } finally {
      if (job.kind === "reindex-agents") {
        this.pendingReindexes = Math.max(0, this.pendingReindexes - 1);
      }
    }
  }

  /** Hands one job to the worker and takes what it answered as the next step: done, rebuild, respawn or reconcile. */
  private async dispatchJob(job: SearchIndexJob): Promise<void> {
    if (!this.canServe) return;
    const result = await this.worker().post(job);
    if (result.ok) {
      if (job.kind === "reconcile") this.reconcileDone = true;
      return;
    }
    if (result.isIndexCorrupt) {
      this.scheduleRebuild(`job-${job.kind}`, new Error(result.message));
      return;
    }
    if (result.isWorkerUnavailable) {
      this.handleWorkerUnavailable(result.message);
      return;
    }
    if (job.kind === "reindex-agents") {
      this.retryFailedReindex(job, result.message);
      return;
    }
    this.reconcileAfterFailedJob(job, result.message);
  }

  /** A worker that went away is replaced, up to the respawn limit; a reconcile follows so the turn is covered. */
  private handleWorkerUnavailable(message: string): void {
    this.workerPort = undefined;
    this.workerRespawns += 1;
    if (this.workerRespawns > MAX_WORKER_RESPAWNS) {
      this.markUnavailable("worker-respawn", new Error(message));
      return;
    }
    this.publish({ kind: "worker_respawn", count: this.workerRespawns });
    this.reconcileDone = false;
    this.queue({ kind: "reconcile" });
  }

  /** A reindex that failed is retried with its count, up to the reconcile limit. */
  private retryFailedReindex(job: SearchIndexJob, message: string): void {
    this.failedReconciles += 1;
    if (this.failedReconciles > MAX_FAILED_JOB_RECONCILES) {
      this.markUnavailable(`job-${job.kind}`, new Error(message));
      return;
    }
    this.publish({ kind: "job_retry", stage: job.kind, count: this.failedReconciles });
    this.pendingReindexes += 1;
    this.queue(job);
  }

  /** Any other failed job is followed by a reconcile, up to the reconcile limit. */
  private reconcileAfterFailedJob(job: SearchIndexJob, message: string): void {
    this.failedReconciles += 1;
    if (this.failedReconciles > MAX_FAILED_JOB_RECONCILES) {
      this.markUnavailable(`job-${job.kind}`, new Error(message));
      return;
    }
    this.publish({ kind: "job_reconcile", stage: job.kind, count: this.failedReconciles });
    this.reconcileDone = false;
    this.queue({ kind: "reconcile" });
  }
}

/** Whether opening the index failed because sqlite was built without its full-text search module. */
function isFts5MissingError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("no such module: fts5");
}
