/**
 * Capturing an agent's databases as a bundle.
 *
 * A store database cannot be uploaded as it lies: a live SQLite file plus its write-ahead log is not a consistent picture.
 * So the capture is a *bundle* of steps that must all agree on one moment:
 *
 *   1. **identity** — the files that should be there are the ones the manifest expects (presence, device, inode, mode), and
 *      the agent is not in the middle of recovering a database;
 *   2. **snapshot** — each database is vacuumed into a temporary file and uploaded from there, never read live;
 *   3. **identity again** — if anything moved while the snapshot was taken, nothing is committed: the next cycle tries
 *      again on a file that stood still;
 *   4. **commit** — all targets are written into the manifest together, and remembered as uncommitted until the manifest
 *      write lands.
 *
 * The capture also remembers *why* it may skip: a database whose write generation, mtime, size, hash, mode and write-ahead
 * log are all unchanged since the last successful capture is already durable, and re-vacuuming it would only cost time.
 */
import { randomBytes } from "node:crypto";
import type { Stats } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage } from "../../../shared/errors/summary.ts";
import { findSystemErrno } from "../../../shared/system-errno.ts";
import { getSlateAgentDbWriteGeneration } from "../../storage/store-db.ts";
import { isBoxStoreManifestFileEntry, type BoxStoreManifestEntry } from "./box-store-manifest-format.ts";
import { AGENT_STORE_DB_BASENAMES, type BoxManifestMap, type BoxStoreManifestStore } from "./box-store-manifest.ts";
import { BOX_STORE_SNAPSHOT_TMP_SUFFIX, tallyFileOutcome, type BoxStoreTransfer, type CategoryTransferSummary, type FileOutcome } from "./box-store-transfer.ts";
import { LARGE_OBJECT_FREE_SPACE_FACTOR } from "./box-store-download.ts";
import type { SnapshotUploadResult, StoreDbSnapshotUpload } from "./store-db-snapshot-upload.ts";

export type StoreDbCaptureFailurePhase = "capture" | "blob_upload" | "manifest_commit";

/** Where a capture's time went, and — if it failed — which phase it failed in (the latest phase wins). */
export interface StoreDbCaptureTrace {
  queueDurationMs: number;
  captureDurationMs: number;
  blobUploadDurationMs: number;
  manifestCommitDurationMs: number;
  failurePhase?: StoreDbCaptureFailurePhase;
}

const STORE_DB_CAPTURE_FAILURE_PHASE_RANK: Record<StoreDbCaptureFailurePhase, number> = {
  capture: 0,
  blob_upload: 1,
  manifest_commit: 2,
};

export function createStoreDbCaptureTrace(): StoreDbCaptureTrace {
  return { queueDurationMs: 0, captureDurationMs: 0, blobUploadDurationMs: 0, manifestCommitDurationMs: 0 };
}

export function recordStoreDbCaptureFailure(trace: StoreDbCaptureTrace, phase: StoreDbCaptureFailurePhase): void {
  if (trace.failurePhase == null || STORE_DB_CAPTURE_FAILURE_PHASE_RANK[phase] > STORE_DB_CAPTURE_FAILURE_PHASE_RANK[trace.failurePhase]) {
    trace.failurePhase = phase;
  }
}

export interface DbBundleTarget {
  readonly relPath: string;
  readonly absPath: string;
  readonly effectiveSize: number;
}

/** What a database looked like when it was captured: every field here is a reason the next cycle may skip it. */
export interface StoreDbCaptureSignature {
  readonly writeGeneration: number;
  readonly mtimeMs: number;
  readonly size: number;
  readonly sha: string;
  readonly mode: number;
  readonly walSize: number;
  readonly walMtimeMs: number;
}

export interface StoreDbBundleCaptureOptions {
  now(): number;
  log(message: string): void;
  readonly manifestStore: BoxStoreManifestStore;
  readonly transfer: Pick<BoxStoreTransfer, "hasDiskSpaceForLargeObject">;
  readonly largeObjectThreshold: number;
  readonly snapshotUpload: StoreDbSnapshotUpload;
  vacuumInto?: ((input: { srcPath: string; destPath: string }) => Promise<void>) | undefined;
  getWriteGeneration?: ((dbPath: string) => number) | undefined;
  readonly storeDbCaptures: Map<string, StoreDbCaptureSignature>;
}

export interface CaptureAgentDbBundleOptions {
  readonly agentId: string;
  readonly agentDir: string;
  readonly relPrefix: string;
  readonly storeId: string;
  readonly manifest: BoxManifestMap;
  readonly targets: readonly DbBundleTarget[];
  readonly summary: CategoryTransferSummary;
  readonly captureTrace: StoreDbCaptureTrace;
}

type CaptureAgentSqliteDbResult = SnapshotUploadResult & { captureDurationMs: number };

export class StoreDbBundleCapture {
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private readonly manifestStore: BoxStoreManifestStore;
  private readonly transfer: Pick<BoxStoreTransfer, "hasDiskSpaceForLargeObject">;
  private readonly largeObjectThreshold: number;
  private readonly snapshotUpload: StoreDbSnapshotUpload;
  private readonly vacuumInto: (input: { srcPath: string; destPath: string }) => Promise<void>;
  private readonly getWriteGeneration: (dbPath: string) => number;
  private readonly storeDbCaptures: Map<string, StoreDbCaptureSignature>;
  private readonly agentDbCaptureQueues = new Map<string, Promise<void>>();

  constructor(input: StoreDbBundleCaptureOptions) {
    this.now = input.now;
    this.log = input.log;
    this.manifestStore = input.manifestStore;
    this.transfer = input.transfer;
    this.largeObjectThreshold = input.largeObjectThreshold;
    this.snapshotUpload = input.snapshotUpload;
    this.vacuumInto = input.vacuumInto ?? ((vacuumInput) => input.snapshotUpload.runVacuumOffThread(vacuumInput));
    this.getWriteGeneration = input.getWriteGeneration ?? getSlateAgentDbWriteGeneration;
    this.storeDbCaptures = input.storeDbCaptures;
  }

  elapsedDurationMs(startedAt: number): number {
    return Math.max(0, this.now() - startedAt);
  }

  /** Committed means: the manifest is the live one, every target is in it, and nothing of it is still uncommitted. */
  isAgentDbBundleCommitted(manifest: BoxManifestMap, targets: readonly DbBundleTarget[]): boolean {
    return (
      this.manifestStore.isLiveManifest(manifest) &&
      targets.length > 0 &&
      targets.every((target) => manifest.has(target.relPath) && !this.manifestStore.uncommittedStoreDbEntries.has(target.relPath))
    );
  }

  /**
   * One agent's bundle, queued behind any capture already running for that agent: two captures of the same files would
   * fight over the same temporary directoryNames and the same manifest entries.
   */
  async captureAgentDbBundle(input: CaptureAgentDbBundleOptions): Promise<boolean> {
    const predecessor = this.agentDbCaptureQueues.get(input.agentId);
    const queuedAtMs = predecessor == null ? undefined : this.now();
    const queuedOperation = (predecessor ?? Promise.resolve()).then(() => {
      if (queuedAtMs != null) input.captureTrace.queueDurationMs += this.elapsedDurationMs(queuedAtMs);
      return this.captureAgentDbBundleUnlocked(input);
    });
    const queueTail = queuedOperation.then(
      () => {},
      () => {},
    );
    this.agentDbCaptureQueues.set(input.agentId, queueTail);
    try {
      return await queuedOperation;
    } finally {
      if (this.agentDbCaptureQueues.get(input.agentId) === queueTail) this.agentDbCaptureQueues.delete(input.agentId);
    }
  }

  private async captureAgentDbBundleUnlocked(input: CaptureAgentDbBundleOptions): Promise<boolean> {
    const firstIdentity = await this.agentDbBundleIdentity(input);
    if (firstIdentity == null) {
      recordStoreDbCaptureFailure(input.captureTrace, "capture");
      return false;
    }
    // The capture writes into a copy of the manifest, so a bundle that turns out to be inconsistent leaves nothing behind.
    const stagedEntries = new Map(input.manifest);
    let allCaptured = true;
    for (const target of input.targets) {
      input.summary.filesScanned += 1;
      try {
        const fileStats = await stat(target.absPath);
        const captureResult = await this.captureAgentSqliteDb(input.storeId, stagedEntries, target.relPath, target.absPath, fileStats);
        input.captureTrace.captureDurationMs += captureResult.captureDurationMs;
        input.captureTrace.blobUploadDurationMs += captureResult.blobUploadDurationMs;
        if (captureResult.failurePhase != null) recordStoreDbCaptureFailure(input.captureTrace, captureResult.failurePhase);
        tallyFileOutcome(input.summary, captureResult.outcome, target.effectiveSize);
        if (captureResult.outcome === "error" || captureResult.outcome === "oversize") allCaptured = false;
      } catch (error) {
        this.log(`agent db ${target.relPath} capture failed: ${errorMessage(error)}`);
        input.summary.failures += 1;
        recordStoreDbCaptureFailure(input.captureTrace, "capture");
        allCaptured = false;
      }
    }
    if (!allCaptured) return false;
    // The files moved while the snapshots were taken: what was captured is not the bundle, so it is not committed.
    if ((await this.agentDbBundleIdentity(input)) !== firstIdentity) {
      recordStoreDbCaptureFailure(input.captureTrace, "capture");
      return false;
    }

    // A database that is absent both now and in the manifest must still agree with what the capture staged for it.
    if (firstIdentity.includes(":absent-tracked")) {
      for (const target of input.targets) {
        const staged = stagedEntries.get(target.relPath);
        const currentWal = input.manifest.get(target.relPath);
        const entryMatches =
          staged != null && currentWal != null && isBoxStoreManifestFileEntry(staged) && isBoxStoreManifestFileEntry(currentWal) && staged.sha === currentWal.sha && staged.size === currentWal.size;
        if (!entryMatches) {
          recordStoreDbCaptureFailure(input.captureTrace, "capture");
          return false;
        }
      }
    }

    for (const target of input.targets) {
      const manifestEntry = stagedEntries.get(target.relPath);
      if (manifestEntry == null) continue;
      // An manifestEntry that changed is remembered as uncommitted until the manifest write lands.
      if (this.manifestStore.setManifestEntry(input.manifest, target.relPath, manifestEntry)) this.manifestStore.uncommittedStoreDbEntries.set(target.relPath, manifestEntry);
    }
    return true;
  }

  /**
   * What the agent's databases look like right now, as one string: null when they cannot be trusted (a pending recovery, a
   * stat error that is not "absent", or a file whose presence disagrees with the manifest).
   */
  async agentDbBundleIdentity(input: Pick<CaptureAgentDbBundleOptions, "agentDir" | "relPrefix" | "agentId" | "targets" | "manifest">): Promise<string | null> {
    if (await this.agentHasPendingDbRecovery(input.agentDir)) return null;
    const expectedPaths = new Set(input.targets.map((target) => target.relPath));
    const identityParts: string[] = [];
    for (const basename of AGENT_STORE_DB_BASENAMES) {
      const relPath = `${input.relPrefix}/agents/${input.agentId}/${basename}`;
      let fileStats: Stats | undefined;
      try {
        fileStats = await stat(join(input.agentDir, basename));
      } catch (error) {
        if (findSystemErrno(error) !== "ENOENT") return null;
      }
      const present = fileStats != null;
      if (present !== expectedPaths.has(relPath)) return null;
      identityParts.push(fileStats == null ? `${basename}:${input.manifest.has(relPath) ? "absent-tracked" : "absent"}` : `${basename}:${fileStats.dev}:${fileStats.ino}:${fileStats.mode & 0o777}`);
    }
    return identityParts.join("|");
  }

  /** A database being rebuilt or recovered is not a database to capture: its own marker files say so. */
  async agentHasPendingDbRecovery(agentDir: string): Promise<boolean> {
    let directoryNames: string[];
    try {
      directoryNames = await readdir(agentDir);
    } catch {
      return true;
    }
    for (const directoryName of directoryNames) {
      if (directoryName === "conversation-blobs.db.pending" || (directoryName.startsWith("conversation-blobs.db.corrupt-") && (directoryName.endsWith(".intent") || directoryName.endsWith(".pending")))) return true;
    }
    return false;
  }

  /** One database: skip if it is already manifestDurable, refuse if there is no room, otherwise vacuum and upload. */
  async captureAgentSqliteDb(storeId: string, manifest: BoxManifestMap, relPath: string, absPath: string, fileStats: Stats): Promise<CaptureAgentSqliteDbResult> {
    const captureStartedAt = this.now();
    if (await this.isAgentDbDurablyCaptured(relPath, absPath, fileStats, manifest)) {
      return { outcome: "unchanged", bytesUploaded: 0, blobUploadDurationMs: 0, captureDurationMs: this.elapsedDurationMs(captureStartedAt) };
    }
    if (fileStats.size >= this.largeObjectThreshold && !(await this.transfer.hasDiskSpaceForLargeObject(absPath, fileStats.size))) {
      this.log(`insufficient disk space for ${relPath} VACUUM snapshot (${fileStats.size}B needed x${LARGE_OBJECT_FREE_SPACE_FACTOR}); deferring to a later cycle`);
      return { outcome: "error", bytesUploaded: 0, blobUploadDurationMs: 0, failurePhase: "capture", captureDurationMs: this.elapsedDurationMs(captureStartedAt) };
    }

    // Everything the "already manifestDurable" answer will need later is read *before* the snapshot: after it, the file may have
    // moved on, and a signature taken then would describe something that was not captured.
    const priorSignature = this.storeDbCaptures.get(relPath);
    const generationAtCapture = this.agentDbWriteGeneration({ relPath, absPath });
    const walAtCapture = (await this.readWalStat(absPath)) ?? { size: -1, mtimeMs: -1 };
    const mainStatAtCapture = await stat(absPath).catch((error) => {
      if (findSystemErrno(error) !== "ENOENT") this.log(`store.db ${relPath} pre-snapshot stat failed: ${errorMessage(error)}`);
      return undefined;
    });
    const tempPath = `${absPath}${BOX_STORE_SNAPSHOT_TMP_SUFFIX}${randomBytes(8).toString("hex")}`;
    let captureResult: SnapshotUploadResult;
    try {
      await this.vacuumInto({ srcPath: absPath, destPath: tempPath });
      captureResult = await this.snapshotUpload.uploadAgentDbSnapshot(storeId, manifest, relPath, tempPath, fileStats.mode);
    } catch (error) {
      this.log(`store.db ${relPath} snapshot failed; uncaptured: ${errorMessage(error)}`);
      if (this.storeDbCaptures.get(relPath) === priorSignature) this.storeDbCaptures.delete(relPath);
      captureResult = { outcome: "error", bytesUploaded: 0, blobUploadDurationMs: 0, failurePhase: "capture" };
    } finally {
      await this.snapshotUpload.discardSnapshotTemp({ tmpPath: tempPath, label: relPath });
    }

    const fileOutcome: FileOutcome = captureResult.outcome;
    // Only the capture that still owns the signature may write it: a concurrent capture that already replaced it is newer.
    if (this.storeDbCaptures.get(relPath) === priorSignature) {
      if (fileOutcome === "uploaded" || fileOutcome === "unchanged") {
        const manifestEntry = manifest.get(relPath);
        if (manifestEntry != null && isBoxStoreManifestFileEntry(manifestEntry) && mainStatAtCapture != null && walAtCapture.size >= 0) {
          this.storeDbCaptures.set(relPath, {
            writeGeneration: generationAtCapture,
            mtimeMs: mainStatAtCapture.mtimeMs,
            size: mainStatAtCapture.size,
            sha: manifestEntry.sha,
            mode: fileStats.mode & 0o777,
            walSize: walAtCapture.size,
            walMtimeMs: walAtCapture.mtimeMs,
          });
        } else {
          this.storeDbCaptures.delete(relPath);
        }
      } else {
        this.storeDbCaptures.delete(relPath);
      }
    }
    return { ...captureResult, captureDurationMs: Math.max(0, this.elapsedDurationMs(captureStartedAt) - captureResult.blobUploadDurationMs) };
  }

  /** The write-ahead log as it is now: absent means zero bytes and zero mtime, unreadable means unknown (null). */
  async readWalStat(dbPath: string): Promise<{ size: number; mtimeMs: number } | null> {
    try {
      const walStats = await stat(`${dbPath}-wal`);
      return { size: walStats.size, mtimeMs: walStats.mtimeMs };
    } catch (error) {
      if (findSystemErrno(error) === "ENOENT") return { size: 0, mtimeMs: 0 };
      return null;
    }
  }

  /** Whether the log has taken no new frames since the referenceWal: an empty log always has, an unknown one never has. */
  async walHasNoNewFramesSince(dbPath: string, ref: { size: number; mtimeMs: number }): Promise<boolean> {
    if (ref.size < 0) return false;
    const currentWal = await this.readWalStat(dbPath);
    if (currentWal === null) return false;
    if (currentWal.size === 0) return true;
    return currentWal.size === ref.size && currentWal.mtimeMs === ref.mtimeMs;
  }

  /** Already durable: the signature and the manifest entry agree, and the database has not been written since. */
  async isAgentDbDurablyCaptured(relPath: string, absPath: string, fileStats: Stats, manifest: BoxManifestMap): Promise<boolean> {
    const cachedSignature = this.storeDbCaptures.get(relPath);
    const manifestDurable = manifest.get(relPath);
    if (cachedSignature == null || manifestDurable == null || !isBoxStoreManifestFileEntry(manifestDurable)) return false;
    if (cachedSignature.writeGeneration !== this.agentDbWriteGeneration({ relPath, absPath })) return false;
    if (cachedSignature.mtimeMs !== fileStats.mtimeMs || cachedSignature.size !== fileStats.size) return false;
    if (cachedSignature.sha !== manifestDurable.sha || cachedSignature.mode !== (fileStats.mode & 0o777)) return false;
    if (manifestDurable.mode !== undefined && manifestDurable.mode !== cachedSignature.mode) return false;
    return await this.walHasNoNewFramesSince(absPath, { size: cachedSignature.walSize, mtimeMs: cachedSignature.walMtimeMs });
  }

  /** A write generation only exists for a store database; any other file in the bundle is generation 0. */
  agentDbWriteGeneration(input: { relPath: string; absPath: string }): number {
    return input.relPath.endsWith("/store.db") ? this.getWriteGeneration(input.absPath) : 0;
  }

  /** Whether this sweep can call the snapshot manifestDurable: captured in this sweep, or manifestDurable from an earlier one. */
  async isAgentDbSnapshotDurable(relPath: string, absPath: string, fileStats: Stats, manifest: BoxManifestMap, capturedThisSweep: ReadonlySet<string>): Promise<boolean> {
    const manifestEntry: BoxStoreManifestEntry | undefined = manifest.get(relPath);
    if (capturedThisSweep.has(relPath) && manifestEntry != null && isBoxStoreManifestFileEntry(manifestEntry)) return true;
    return this.isAgentDbDurablyCaptured(relPath, absPath, fileStats, manifest);
  }
}
