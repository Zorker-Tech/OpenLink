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
  vacuumInto?: ((args: { srcPath: string; destPath: string }) => Promise<void>) | undefined;
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
  private readonly vacuumInto: (args: { srcPath: string; destPath: string }) => Promise<void>;
  private readonly getWriteGeneration: (dbPath: string) => number;
  private readonly storeDbCaptures: Map<string, StoreDbCaptureSignature>;
  private readonly agentDbCaptureQueues = new Map<string, Promise<void>>();

  constructor(args: StoreDbBundleCaptureOptions) {
    this.now = args.now;
    this.log = args.log;
    this.manifestStore = args.manifestStore;
    this.transfer = args.transfer;
    this.largeObjectThreshold = args.largeObjectThreshold;
    this.snapshotUpload = args.snapshotUpload;
    this.vacuumInto = args.vacuumInto ?? ((vacuumArgs) => args.snapshotUpload.runVacuumOffThread(vacuumArgs));
    this.getWriteGeneration = args.getWriteGeneration ?? getSlateAgentDbWriteGeneration;
    this.storeDbCaptures = args.storeDbCaptures;
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
   * fight over the same temporary names and the same manifest entries.
   */
  async captureAgentDbBundle(args: CaptureAgentDbBundleOptions): Promise<boolean> {
    const previous = this.agentDbCaptureQueues.get(args.agentId);
    const queuedAt = previous == null ? undefined : this.now();
    const operation = (previous ?? Promise.resolve()).then(() => {
      if (queuedAt != null) args.captureTrace.queueDurationMs += this.elapsedDurationMs(queuedAt);
      return this.captureAgentDbBundleUnlocked(args);
    });
    const tail = operation.then(
      () => {},
      () => {},
    );
    this.agentDbCaptureQueues.set(args.agentId, tail);
    try {
      return await operation;
    } finally {
      if (this.agentDbCaptureQueues.get(args.agentId) === tail) this.agentDbCaptureQueues.delete(args.agentId);
    }
  }

  private async captureAgentDbBundleUnlocked(args: CaptureAgentDbBundleOptions): Promise<boolean> {
    const initialIdentity = await this.agentDbBundleIdentity(args);
    if (initialIdentity == null) {
      recordStoreDbCaptureFailure(args.captureTrace, "capture");
      return false;
    }
    // The capture writes into a copy of the manifest, so a bundle that turns out to be inconsistent leaves nothing behind.
    const stagedManifest = new Map(args.manifest);
    let complete = true;
    for (const target of args.targets) {
      args.summary.filesScanned += 1;
      try {
        const fileStat = await stat(target.absPath);
        const result = await this.captureAgentSqliteDb(args.storeId, stagedManifest, target.relPath, target.absPath, fileStat);
        args.captureTrace.captureDurationMs += result.captureDurationMs;
        args.captureTrace.blobUploadDurationMs += result.blobUploadDurationMs;
        if (result.failurePhase != null) recordStoreDbCaptureFailure(args.captureTrace, result.failurePhase);
        tallyFileOutcome(args.summary, result.outcome, target.effectiveSize);
        if (result.outcome === "error" || result.outcome === "oversize") complete = false;
      } catch (error) {
        this.log(`agent db ${target.relPath} capture failed: ${errorMessage(error)}`);
        args.summary.failures += 1;
        recordStoreDbCaptureFailure(args.captureTrace, "capture");
        complete = false;
      }
    }
    if (!complete) return false;
    // The files moved while the snapshots were taken: what was captured is not the bundle, so it is not committed.
    if ((await this.agentDbBundleIdentity(args)) !== initialIdentity) {
      recordStoreDbCaptureFailure(args.captureTrace, "capture");
      return false;
    }

    // A database that is absent both now and in the manifest must still agree with what the capture staged for it.
    if (initialIdentity.includes(":absent-tracked")) {
      for (const target of args.targets) {
        const staged = stagedManifest.get(target.relPath);
        const current = args.manifest.get(target.relPath);
        const contentEqual =
          staged != null && current != null && isBoxStoreManifestFileEntry(staged) && isBoxStoreManifestFileEntry(current) && staged.sha === current.sha && staged.size === current.size;
        if (!contentEqual) {
          recordStoreDbCaptureFailure(args.captureTrace, "capture");
          return false;
        }
      }
    }

    for (const target of args.targets) {
      const entry = stagedManifest.get(target.relPath);
      if (entry == null) continue;
      // An entry that changed is remembered as uncommitted until the manifest write lands.
      if (this.manifestStore.setManifestEntry(args.manifest, target.relPath, entry)) this.manifestStore.uncommittedStoreDbEntries.set(target.relPath, entry);
    }
    return true;
  }

  /**
   * What the agent's databases look like right now, as one string: null when they cannot be trusted (a pending recovery, a
   * stat error that is not "absent", or a file whose presence disagrees with the manifest).
   */
  async agentDbBundleIdentity(args: Pick<CaptureAgentDbBundleOptions, "agentDir" | "relPrefix" | "agentId" | "targets" | "manifest">): Promise<string | null> {
    if (await this.agentHasPendingDbRecovery(args.agentDir)) return null;
    const targetPaths = new Set(args.targets.map((target) => target.relPath));
    const identities: string[] = [];
    for (const basename of AGENT_STORE_DB_BASENAMES) {
      const relPath = `${args.relPrefix}/agents/${args.agentId}/${basename}`;
      let fileStat: Stats | undefined;
      try {
        fileStat = await stat(join(args.agentDir, basename));
      } catch (error) {
        if (findSystemErrno(error) !== "ENOENT") return null;
      }
      const present = fileStat != null;
      if (present !== targetPaths.has(relPath)) return null;
      identities.push(fileStat == null ? `${basename}:${args.manifest.has(relPath) ? "absent-tracked" : "absent"}` : `${basename}:${fileStat.dev}:${fileStat.ino}:${fileStat.mode & 0o777}`);
    }
    return identities.join("|");
  }

  /** A database being rebuilt or recovered is not a database to capture: its own marker files say so. */
  async agentHasPendingDbRecovery(agentDir: string): Promise<boolean> {
    let names: string[];
    try {
      names = await readdir(agentDir);
    } catch {
      return true;
    }
    for (const name of names) {
      if (name === "conversation-blobs.db.pending" || (name.startsWith("conversation-blobs.db.corrupt-") && (name.endsWith(".intent") || name.endsWith(".pending")))) return true;
    }
    return false;
  }

  /** One database: skip if it is already durable, refuse if there is no room, otherwise vacuum and upload. */
  async captureAgentSqliteDb(storeId: string, manifest: BoxManifestMap, relPath: string, absPath: string, fileStat: Stats): Promise<CaptureAgentSqliteDbResult> {
    const captureStartedAt = this.now();
    if (await this.isAgentDbDurablyCaptured(relPath, absPath, fileStat, manifest)) {
      return { outcome: "unchanged", bytesUploaded: 0, blobUploadDurationMs: 0, captureDurationMs: this.elapsedDurationMs(captureStartedAt) };
    }
    if (fileStat.size >= this.largeObjectThreshold && !(await this.transfer.hasDiskSpaceForLargeObject(absPath, fileStat.size))) {
      this.log(`insufficient disk space for ${relPath} VACUUM snapshot (${fileStat.size}B needed x${LARGE_OBJECT_FREE_SPACE_FACTOR}); deferring to a later cycle`);
      return { outcome: "error", bytesUploaded: 0, blobUploadDurationMs: 0, failurePhase: "capture", captureDurationMs: this.elapsedDurationMs(captureStartedAt) };
    }

    // Everything the "already durable" answer will need later is read *before* the snapshot: after it, the file may have
    // moved on, and a signature taken then would describe something that was not captured.
    const previousCapture = this.storeDbCaptures.get(relPath);
    const capturedGeneration = this.agentDbWriteGeneration({ relPath, absPath });
    const capturedWalRef = (await this.readWalStat(absPath)) ?? { size: -1, mtimeMs: -1 };
    const capturedMainStat = await stat(absPath).catch((error) => {
      if (findSystemErrno(error) !== "ENOENT") this.log(`store.db ${relPath} pre-snapshot stat failed: ${errorMessage(error)}`);
      return undefined;
    });
    const tmpPath = `${absPath}${BOX_STORE_SNAPSHOT_TMP_SUFFIX}${randomBytes(8).toString("hex")}`;
    let result: SnapshotUploadResult;
    try {
      await this.vacuumInto({ srcPath: absPath, destPath: tmpPath });
      result = await this.snapshotUpload.uploadAgentDbSnapshot(storeId, manifest, relPath, tmpPath, fileStat.mode);
    } catch (error) {
      this.log(`store.db ${relPath} snapshot failed; uncaptured: ${errorMessage(error)}`);
      if (this.storeDbCaptures.get(relPath) === previousCapture) this.storeDbCaptures.delete(relPath);
      result = { outcome: "error", bytesUploaded: 0, blobUploadDurationMs: 0, failurePhase: "capture" };
    } finally {
      await this.snapshotUpload.discardSnapshotTemp({ tmpPath, label: relPath });
    }

    const outcome: FileOutcome = result.outcome;
    // Only the capture that still owns the signature may write it: a concurrent capture that already replaced it is newer.
    if (this.storeDbCaptures.get(relPath) === previousCapture) {
      if (outcome === "uploaded" || outcome === "unchanged") {
        const entry = manifest.get(relPath);
        if (entry != null && isBoxStoreManifestFileEntry(entry) && capturedMainStat != null && capturedWalRef.size >= 0) {
          this.storeDbCaptures.set(relPath, {
            writeGeneration: capturedGeneration,
            mtimeMs: capturedMainStat.mtimeMs,
            size: capturedMainStat.size,
            sha: entry.sha,
            mode: fileStat.mode & 0o777,
            walSize: capturedWalRef.size,
            walMtimeMs: capturedWalRef.mtimeMs,
          });
        } else {
          this.storeDbCaptures.delete(relPath);
        }
      } else {
        this.storeDbCaptures.delete(relPath);
      }
    }
    return { ...result, captureDurationMs: Math.max(0, this.elapsedDurationMs(captureStartedAt) - result.blobUploadDurationMs) };
  }

  /** The write-ahead log as it is now: absent means zero bytes and zero mtime, unreadable means unknown (null). */
  async readWalStat(dbPath: string): Promise<{ size: number; mtimeMs: number } | null> {
    try {
      const wal = await stat(`${dbPath}-wal`);
      return { size: wal.size, mtimeMs: wal.mtimeMs };
    } catch (error) {
      if (findSystemErrno(error) === "ENOENT") return { size: 0, mtimeMs: 0 };
      return null;
    }
  }

  /** Whether the log has taken no new frames since the reference: an empty log always has, an unknown one never has. */
  async walHasNoNewFramesSince(dbPath: string, ref: { size: number; mtimeMs: number }): Promise<boolean> {
    if (ref.size < 0) return false;
    const current = await this.readWalStat(dbPath);
    if (current === null) return false;
    if (current.size === 0) return true;
    return current.size === ref.size && current.mtimeMs === ref.mtimeMs;
  }

  /** Already durable: the signature and the manifest entry agree, and the database has not been written since. */
  async isAgentDbDurablyCaptured(relPath: string, absPath: string, fileStat: Stats, manifest: BoxManifestMap): Promise<boolean> {
    const cached = this.storeDbCaptures.get(relPath);
    const durable = manifest.get(relPath);
    if (cached == null || durable == null || !isBoxStoreManifestFileEntry(durable)) return false;
    if (cached.writeGeneration !== this.agentDbWriteGeneration({ relPath, absPath })) return false;
    if (cached.mtimeMs !== fileStat.mtimeMs || cached.size !== fileStat.size) return false;
    if (cached.sha !== durable.sha || cached.mode !== (fileStat.mode & 0o777)) return false;
    if (durable.mode !== undefined && durable.mode !== cached.mode) return false;
    return await this.walHasNoNewFramesSince(absPath, { size: cached.walSize, mtimeMs: cached.walMtimeMs });
  }

  /** A write generation only exists for a store database; any other file in the bundle is generation 0. */
  agentDbWriteGeneration(args: { relPath: string; absPath: string }): number {
    return args.relPath.endsWith("/store.db") ? this.getWriteGeneration(args.absPath) : 0;
  }

  /** Whether this sweep can call the snapshot durable: captured in this sweep, or durable from an earlier one. */
  async isAgentDbSnapshotDurable(relPath: string, absPath: string, fileStat: Stats, manifest: BoxManifestMap, capturedThisSweep: ReadonlySet<string>): Promise<boolean> {
    const entry: BoxStoreManifestEntry | undefined = manifest.get(relPath);
    if (capturedThisSweep.has(relPath) && entry != null && isBoxStoreManifestFileEntry(entry)) return true;
    return this.isAgentDbDurablyCaptured(relPath, absPath, fileStat, manifest);
  }
}
