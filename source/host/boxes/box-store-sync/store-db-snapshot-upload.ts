/**
 * Putting one database snapshot into the store.
 *
 * The snapshot is a file the vacuum produced, so this is the only place that has to know how a database becomes a blob:
 * hash it (from disk when it is large, in memory when it is not), compare it with what the manifest already says, and only
 * upload when the content is new. The store addresses blobs by hash, so a repeated upload would be harmless — it is skipped
 * anyway, because the upload is the expensive part.
 *
 * The vacuum itself runs in a worker when the packaged worker bundle is there, and in-process when it is not. That is a
 * deployment difference, not a behavioural one: either way the destination is a fresh file that the caller deletes.
 */
import { existsSync } from "node:fs";
import { readFile, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { errorMessage } from "../../../shared/errors/summary.ts";
import { findSystemErrno } from "../../../shared/system-errno.ts";
import { DB_BUSY_TIMEOUT_MS } from "../../storage/store-db.ts";
import { sha256Hex } from "../../sha256.ts";
import { BOX_STORE_BLOBS_PREFIX, isBoxStoreManifestFileEntry, type BoxStoreManifestEntry } from "./box-store-manifest-format.ts";
import type { BoxManifestMap, BoxStoreManifestStore } from "./box-store-manifest.ts";
import type { BoxObjectStore, BoxObjectStoreProvider } from "./box-object-store.ts";
import { sha256File } from "./box-store-download.ts";
import { sqliteVacuumInto } from "./sqlite-snapshot.ts";

export type SnapshotUploadResult = {
  readonly outcome: "uploaded" | "unchanged" | "oversize" | "error";
  readonly bytesUploaded: number;
  readonly blobUploadDurationMs: number;
  readonly failurePhase?: "capture" | "blob_upload";
};

export class StoreDbSnapshotUpload {
  private readonly storeProvider: BoxObjectStoreProvider;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private readonly manifestEntries: BoxStoreManifestStore;
  private readonly objectSizeLimit: number;
  private readonly largeObjectLimit: number;
  private workerBundled: boolean | undefined;

  constructor(args: {
    objectStoreProvider: BoxObjectStoreProvider;
    now: () => number;
    log: (message: string) => void;
    manifestStore: BoxStoreManifestStore;
    maxObjectBytes: number;
    largeObjectThreshold: number;
  }) {
    this.storeProvider = args.objectStoreProvider;
    this.now = args.now;
    this.log = args.log;
    this.manifestEntries = args.manifestStore;
    this.objectSizeLimit = args.maxObjectBytes;
    this.largeObjectLimit = args.largeObjectThreshold;
  }

  objectStore(storeId: string): BoxObjectStore {
    return this.storeProvider.forStore(storeId);
  }

  elapsedDurationMs(startedAt: number): number {
    return Math.max(0, this.now() - startedAt);
  }

  /** One snapshot file, from its size to its blob. The failure phase says whether it was reading or uploading. */
  async uploadAgentDbSnapshot(storeId: string, manifest: BoxManifestMap, relPath: string, snapshotPath: string, mode: number): Promise<SnapshotUploadResult> {
    const statSize = await this.snapshotSize(snapshotPath, relPath);
    if (statSize === null) return this.failure("capture", 0);
    if (statSize > this.objectSizeLimit) {
      this.log("oversize " + relPath + ": " + statSize + "B over " + this.objectSizeLimit + "B");
      return { outcome: "oversize", bytesUploaded: 0, blobUploadDurationMs: 0, failurePhase: "capture" };
    }
    const snapshot = await this.readSnapshot(snapshotPath, relPath, statSize);
    if (snapshot === null) return this.failure("capture", 0);
    const nextEntry = this.entryFor(snapshot.sha, statSize, mode);
    const previousEntry = manifest.get(relPath);
    if (previousEntry != null && isBoxStoreManifestFileEntry(previousEntry) && previousEntry.sha === snapshot.sha && previousEntry.size === statSize) {
      this.manifestEntries.setManifestEntry(manifest, relPath, nextEntry);
      return { outcome: "unchanged", bytesUploaded: 0, blobUploadDurationMs: 0 };
    }
    const uploadStartedAt = this.now();
    const uploaded = await this.putSnapshot(storeId, snapshot.sha, statSize, snapshot.bytes, snapshotPath, relPath);
    if (!uploaded) return this.failure("blob_upload", this.elapsedDurationMs(uploadStartedAt));
    this.manifestEntries.setManifestEntry(manifest, relPath, nextEntry);
    return { outcome: "uploaded", bytesUploaded: statSize, blobUploadDurationMs: this.elapsedDurationMs(uploadStartedAt) };
  }

  private failure(phase: "capture" | "blob_upload", durationMs: number): SnapshotUploadResult {
    return { outcome: "error", bytesUploaded: 0, blobUploadDurationMs: durationMs, failurePhase: phase };
  }

  /** The file's size, or null when it could not be asked (the reason is logged rather than thrown). */
  private async snapshotSize(snapshotPath: string, relPath: string): Promise<number | null> {
    try {
      return (await stat(snapshotPath)).size;
    } catch (error) {
      this.log("store.db " + relPath + " snapshot stat failed: " + errorMessage(error));
      return null;
    }
  }

  /** The digest, from disk when the file is large enough to be streamed and from memory otherwise. */
  private async readSnapshot(snapshotPath: string, relPath: string, size: number): Promise<{ sha: string; bytes: Buffer | undefined } | null> {
    try {
      if (size >= this.largeObjectLimit) {
        return { sha: await sha256File(snapshotPath), bytes: undefined };
      }
      const bytes = await readFile(snapshotPath);
      return { sha: sha256Hex(bytes), bytes };
    } catch (error) {
      this.log("read failed " + relPath + ": " + errorMessage(error));
      return null;
    }
  }

  private entryFor(sha: string, size: number, mode: number): BoxStoreManifestEntry {
    return { kind: "file", sha, size, mode: mode & 0o777 };
  }

  /** Streams from disk when the snapshot was too large to be read, otherwise sends the bytes already in hand. */
  private async putSnapshot(storeId: string, sha: string, size: number, bytes: Buffer | undefined, snapshotPath: string, relPath: string): Promise<boolean> {
    try {
      if (bytes === undefined) {
        // A large snapshot is streamed from disk: it never has to fit in memory.
        await this.objectStore(storeId).putFromFile!(BOX_STORE_BLOBS_PREFIX + "/" + sha, snapshotPath, sha, size);
      } else {
        await this.objectStore(storeId).put(BOX_STORE_BLOBS_PREFIX + "/" + sha, bytes, { contentAddressed: true });
      }
      return true;
    } catch (error) {
      this.log("upload failed " + relPath + ": " + errorMessage(error));
      return false;
    }
  }

  /**
   * VACUUM INTO a fresh file. The worker bundle is what a packaged host has; a source checkout does not, and then the
   * vacuum runs in this process (a blocked database would block the host, which is why the worker exists at all).
   */
  async runVacuumOffThread(args: { srcPath: string; destPath: string }): Promise<void> {
    const entry = defaultVacuumWorkerEntryPath();
    if (this.workerAvailable(entry)) {
      try {
        await runVacuumInWorker({ entryPath: entry, srcPath: args.srcPath, destPath: args.destPath, busyTimeoutMs: DB_BUSY_TIMEOUT_MS });
        return;
      } catch (error) {
        if (!(error instanceof VacuumWorkerUnavailableError)) throw error;
        this.workerBundled = false;
        this.log("vacuum worker unavailable; using in-process VACUUM: " + errorMessage(error));
      }
    }
    // The in-process path starts from an empty destination: a half-written file from a failed worker would be appended to.
    await this.discardSnapshotTemp({ tmpPath: args.destPath, label: "vacuum fallback pre-clean" });
    sqliteVacuumInto(args.srcPath, args.destPath);
  }

  /** Whether the packaged worker bundle exists, asked once and remembered. */
  private workerAvailable(entry: string): boolean {
    if (this.workerBundled === undefined) {
      this.workerBundled = existsSync(entry);
      if (!this.workerBundled) this.log("vacuum worker bundle absent (" + entry + "); using in-process VACUUM");
    }
    return this.workerBundled;
  }

  async discardSnapshotTemp(args: { tmpPath: string; label: string }): Promise<void> {
    try {
      await unlink(args.tmpPath);
    } catch (failure) {
      if (findSystemErrno(failure) === "ENOENT") return;
      this.log(`temp cleanup failed ${args.label}: ${errorMessage(failure)}`);
    }
  }
}

/** Where a packaged host keeps the worker: next to the host bundle, under the extension's own directory. */
function defaultVacuumWorkerEntryPath(): string {
  const hostBundleDirectory = typeof __dirname === "string" ? __dirname : dirname(fileURLToPath(import.meta.url));
  return join(hostBundleDirectory, "extensions/box-store-sync/box-store-vacuum-worker.cjs");
}

class VacuumWorkerUnavailableError extends Error {}

/**
 * One vacuum in a worker. The worker answers once; anything else it does — an failure, an exit before an answer — means the
 * worker was not usable, and the caller falls back rather than retrying a broken worker.
 */
function runVacuumInWorker(args: { entryPath: string; srcPath: string; destPath: string; busyTimeoutMs: number }): Promise<void> {
  const { entryPath, srcPath, destPath, busyTimeoutMs } = args;
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(entryPath);
    } catch (failure) {
      reject(new VacuumWorkerUnavailableError(errorMessage(failure)));
      return;
    }
    let settled = false;
    const finish = (run: () => void): void => {
      if (settled) return;
      settled = true;
      void worker.terminate();
      run();
    };
    worker.on("message", (message: { ok?: boolean; message?: string }) => {
      if (message?.ok === true) finish(resolve);
      else finish(() => reject(new Error(message?.message ?? "the vacuum worker reported a failure")));
    });
    worker.on("error", (failure) => {
      finish(() => reject(new VacuumWorkerUnavailableError(errorMessage(failure))));
    });
    worker.on("exit", (code) => {
      finish(() => reject(new VacuumWorkerUnavailableError(`the vacuum worker exited (${code}) before completing`)));
    });
    worker.postMessage({ srcPath, destPath, busyTimeoutMs });
  });
}
