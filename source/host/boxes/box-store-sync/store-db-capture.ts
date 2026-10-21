/**
 * The agent databases: the sweep, the per-turn snapshot, and the pruning that keeps the manifest honest.
 *
 * A store database is the only part of the box that cannot be copied as bytes while it is live, so it has its own capture
 * and its own rules:
 *
 * - **the sweep captures every agent, biggest first** — the largest bundles go two at a time (bandwidth), the small ones at
 *   the upload concurrency, and a bundle that could not be made is a failure for that agent, not for the sweep;
 * - **"complete" is a claim about the whole store** — it means every database the box has is durable, which is only true
 *   when nothing was skipped for a live handle and nothing failed;
 * - **a turn's end captures that one agent** — the debounce lives above this file; here the agent's bundle is captured,
 *   the manifest is written if it changed (or if the capture failed, so the failure is recorded), and the caller is told
 *   whether the result is committed;
 * - **pruning never guesses** — an entry is removed when its agent is gone, when the file at that path is gone, or when the
 *   entry is a sidecar/rebuild leftover that was never a database in the first place.
 */
import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { forEachBounded } from "../box-transfer.ts";
import { errorMessage } from "../../../shared/errors/summary.ts";
import { findSystemErrno } from "../../../shared/system-errno.ts";
import { hasLiveSlateAgentDbHandle, SQLITE_DB_SIDECAR_SUFFIXES } from "../../storage/store-db.ts";
import { boxStoreManifestEntriesEqual } from "./box-store-manifest-format.ts";
import { AGENT_STORE_DB_BASENAMES, type BoxManifestMap, type BoxStoreManifestStore } from "./box-store-manifest.ts";
import type { BoxObjectStoreProvider } from "./box-object-store.ts";
import { SNAPSHOT_OUT_LARGE_CONCURRENCY, type BoxStoreTransfer, type CategoryTransferSummary } from "./box-store-transfer.ts";
import {
  createStoreDbCaptureTrace,
  recordStoreDbCaptureFailure,
  StoreDbBundleCapture,
  type DbBundleTarget,
  type StoreDbCaptureSignature,
  type StoreDbCaptureTrace,
} from "./store-db-bundle-capture.ts";
import { StoreDbSnapshotUpload } from "./store-db-snapshot-upload.ts";

export interface StoreDbCaptureCategory {
  readonly absRoot: string;
  readonly relPrefix: string;
  readonly containsAgentStoreDbs?: boolean;
}

export interface StoreDbCaptureDependencies {
  readonly categories: readonly StoreDbCaptureCategory[];
  readonly objectStoreProvider: BoxObjectStoreProvider;
  resolveStoreId(): Promise<string>;
  hasLiveHandle?(dbPath: string): boolean;
  vacuumInto?(args: { srcPath: string; destPath: string }): Promise<void>;
  getWriteGeneration?(dbPath: string): number;
}

export interface StoreDbCaptureOptions {
  readonly deps: StoreDbCaptureDependencies;
  now(): number;
  log(message: string): void;
  readonly manifestStore: BoxStoreManifestStore;
  readonly transfer: Pick<BoxStoreTransfer, "hasDiskSpaceForLargeObject" | "localStat">;
  readonly maxObjectBytes: number;
  readonly uploadConcurrency: number;
  readonly largeObjectThreshold: number;
  ensureWriterLock(): Promise<boolean>;
  isStopped(): boolean;
}

export interface StoreDbSweepResult {
  readonly summary: CategoryTransferSummary;
  readonly complete: boolean;
  readonly agentCount: number;
  readonly capturedThisSweep: Set<string>;
  readonly captureTrace: StoreDbCaptureTrace;
  readonly manifest: BoxManifestMap | undefined;
}

export type StoreDbCaptureOutcome = "error" | "oversize" | "uploaded" | "skipped" | "unchanged";

export interface StoreDbSnapshotResult {
  readonly outcome: StoreDbCaptureOutcome;
  readonly summary: CategoryTransferSummary;
  readonly captureTrace: StoreDbCaptureTrace;
  readonly isCommitted: boolean;
  readonly storeId: string | null;
}

/** What a capture says, in one word: a failure first, then oversize, then what it actually did. */
export function aggregateStoreDbSweepOutcome(summary: Pick<CategoryTransferSummary, "failures" | "oversize" | "filesUploaded" | "filesScanned">): StoreDbCaptureOutcome {
  if (summary.failures > 0) return "error";
  if (summary.oversize > 0) return "oversize";
  if (summary.filesUploaded > 0) return "uploaded";
  if (summary.filesScanned === 0) return "skipped";
  return "unchanged";
}

export class StoreDbCapture {
  private readonly deps: StoreDbCaptureDependencies;
  private readonly log: (message: string) => void;
  private readonly manifestStore: BoxStoreManifestStore;
  private readonly transfer: Pick<BoxStoreTransfer, "hasDiskSpaceForLargeObject" | "localStat">;
  private readonly uploadConcurrency: number;
  private readonly largeObjectThreshold: number;
  private readonly hasLiveHandle: (dbPath: string) => boolean;
  private readonly ensureWriterLock: () => Promise<boolean>;
  private readonly isStopped: () => boolean;
  readonly snapshotUpload: StoreDbSnapshotUpload;
  readonly bundleCapture: StoreDbBundleCapture;
  readonly storeDbCaptures = new Map<string, StoreDbCaptureSignature>();

  constructor(args: StoreDbCaptureOptions) {
    this.deps = args.deps;
    this.log = args.log;
    this.manifestStore = args.manifestStore;
    this.transfer = args.transfer;
    this.uploadConcurrency = args.uploadConcurrency;
    this.largeObjectThreshold = args.largeObjectThreshold;
    this.hasLiveHandle = args.deps.hasLiveHandle ?? hasLiveSlateAgentDbHandle;
    this.ensureWriterLock = args.ensureWriterLock;
    this.isStopped = args.isStopped;
    this.snapshotUpload = new StoreDbSnapshotUpload({
      objectStoreProvider: args.deps.objectStoreProvider,
      now: args.now,
      log: args.log,
      manifestStore: args.manifestStore,
      maxObjectBytes: args.maxObjectBytes,
      largeObjectThreshold: args.largeObjectThreshold,
    });
    this.bundleCapture = new StoreDbBundleCapture({
      now: args.now,
      log: args.log,
      manifestStore: args.manifestStore,
      transfer: args.transfer,
      largeObjectThreshold: args.largeObjectThreshold,
      snapshotUpload: this.snapshotUpload,
      vacuumInto: args.deps.vacuumInto,
      getWriteGeneration: args.deps.getWriteGeneration,
      storeDbCaptures: this.storeDbCaptures,
    });
  }

  /** Every agent's bundle, for a cycle. A bundle that is skipped for a live handle is not a failure; anything else is. */
  async runAgentStoreDbsSweep(storeId: string, skipLiveHandles: boolean): Promise<StoreDbSweepResult> {
    const captureTrace = createStoreDbCaptureTrace();
    const summary: CategoryTransferSummary = { name: "store.db", filesScanned: 0, filesUploaded: 0, bytesUploaded: 0, skippedUnchanged: 0, removed: 0, oversize: 0, failures: 0, metadataFailures: 0 };
    const category = this.deps.categories.find((candidate) => candidate.containsAgentStoreDbs);
    if (category == null) return { summary, complete: true, agentCount: 0, capturedThisSweep: new Set(), captureTrace, manifest: undefined };

    const agentsRoot = join(category.absRoot, "agents");
    let roster;
    try {
      roster = await readdir(agentsRoot, { withFileTypes: true });
    } catch (error) {
      // No agents directory at all is an empty sweep, not a broken one.
      const complete = findSystemErrno(error) === "ENOENT";
      if (!complete) recordStoreDbCaptureFailure(captureTrace, "capture");
      return { summary, complete, agentCount: 0, capturedThisSweep: new Set(), captureTrace, manifest: undefined };
    }

    const manifest = await this.manifestStore.loadManifest(storeId);
    const bundles: Array<{ agentId: string; targets: DbBundleTarget[]; effectiveSize: number }> = [];
    for (const entry of roster) {
      if (!entry.isDirectory()) continue;
      const agentDir = join(agentsRoot, entry.name);
      if (await this.bundleCapture.agentHasPendingDbRecovery(agentDir)) {
        summary.failures += 1;
        recordStoreDbCaptureFailure(captureTrace, "capture");
        continue;
      }
      const targets: DbBundleTarget[] = [];
      let bundleBlocked = false;
      for (const basename of AGENT_STORE_DB_BASENAMES) {
        const relPath = `${category.relPrefix}/agents/${entry.name}/${basename}`;
        const absPath = join(agentDir, basename);
        let fileStat;
        try {
          fileStat = await stat(absPath);
        } catch (error) {
          if (findSystemErrno(error) !== "ENOENT") {
            this.log(`agent db ${relPath} stat failed: ${errorMessage(error)}`);
            summary.failures += 1;
            recordStoreDbCaptureFailure(captureTrace, "capture");
            bundleBlocked = true;
          }
          continue;
        }
        // The write-ahead log is part of the database's size: it is what makes a snapshot of it necessary at all.
        const walStat = await this.bundleCapture.readWalStat(absPath);
        targets.push({ relPath, absPath, effectiveSize: fileStat.size + (walStat != null && walStat.size > 0 ? walStat.size : 0) });
      }
      if (bundleBlocked || targets.length === 0) continue;
      const storeTarget = targets.find((target) => target.relPath.endsWith("/store.db"));
      // A live handle means the database is being written right now: a snapshot of it would be a guess.
      if (skipLiveHandles && storeTarget != null && this.hasLiveHandle(storeTarget.absPath)) continue;
      bundles.push({ agentId: entry.name, targets, effectiveSize: targets.reduce((total, target) => total + target.effectiveSize, 0) });
    }

    const bySizeDesc = (left: { effectiveSize: number }, right: { effectiveSize: number }) => right.effectiveSize - left.effectiveSize;
    const large = bundles.filter((bundle) => bundle.effectiveSize >= this.largeObjectThreshold).sort(bySizeDesc);
    const small = bundles.filter((bundle) => bundle.effectiveSize < this.largeObjectThreshold).sort(bySizeDesc);
    let agentCount = 0;
    const capturedThisSweep = new Set<string>();
    const capture = async (bundle: (typeof bundles)[number]): Promise<void> => {
      agentCount += 1;
      const failuresBefore = summary.failures;
      const oversizeBefore = summary.oversize;
      let committed = false;
      try {
        committed = await this.bundleCapture.captureAgentDbBundle({
          agentId: bundle.agentId,
          agentDir: join(agentsRoot, bundle.agentId),
          relPrefix: category.relPrefix,
          storeId,
          manifest,
          targets: bundle.targets,
          summary,
          captureTrace,
        });
      } catch (error) {
        this.log(`agent db bundle ${bundle.agentId} capture failed: ${errorMessage(error)}`);
        recordStoreDbCaptureFailure(captureTrace, "capture");
      }
      if (committed) {
        for (const target of bundle.targets) capturedThisSweep.add(target.relPath);
      } else if (summary.failures === failuresBefore && summary.oversize === oversizeBefore) {
        // A bundle that failed without saying so would look like a quiet success; the sweep counts it here.
        summary.failures += 1;
        recordStoreDbCaptureFailure(captureTrace, "capture");
      }
    };
    await forEachBounded(large, SNAPSHOT_OUT_LARGE_CONCURRENCY, capture);
    await forEachBounded(small, this.uploadConcurrency, capture);
    const complete = await this.verifyAgentDbsComplete(agentsRoot, category.relPrefix, manifest, capturedThisSweep);
    return { summary, complete, agentCount, capturedThisSweep, captureTrace, manifest };
  }

  /** Whether every database on the box is now durable: captured in this sweep, or already durable from an earlier one. */
  async verifyAgentDbsComplete(agentsRoot: string, relPrefix: string, manifest: BoxManifestMap, capturedThisSweep: ReadonlySet<string>): Promise<boolean> {
    let entries;
    try {
      entries = await readdir(agentsRoot, { withFileTypes: true });
    } catch (error) {
      return findSystemErrno(error) === "ENOENT";
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const agentDir = join(agentsRoot, entry.name);
      if (await this.bundleCapture.agentHasPendingDbRecovery(agentDir)) return false;
      for (const basename of AGENT_STORE_DB_BASENAMES) {
        const relPath = `${relPrefix}/agents/${entry.name}/${basename}`;
        const absPath = join(agentDir, basename);
        let fileStat;
        try {
          fileStat = await stat(absPath);
        } catch (error) {
          if (findSystemErrno(error) === "ENOENT") continue;
          return false;
        }
        if (!(await this.bundleCapture.isAgentDbSnapshotDurable(relPath, absPath, fileStat, manifest, capturedThisSweep))) return false;
      }
    }
    return true;
  }

  /**
   * Removes manifest entries that cannot be about a database any more: a sidecar, a rebuild leftover, an agent that is
   * gone, or a file that is gone. Nothing is removed merely because it was not seen this time.
   */
  async pruneMissingAgentStoreDbs(storeId: string): Promise<number> {
    const category = this.deps.categories.find((candidate) => candidate.containsAgentStoreDbs);
    if (category == null) return 0;
    const agentsRoot = join(category.absRoot, "agents");
    let existing: Set<string>;
    try {
      const entries = await readdir(agentsRoot, { withFileTypes: true });
      existing = new Set(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name));
    } catch {
      return 0;
    }
    const manifest = await this.manifestStore.loadManifest(storeId);
    const prefix = `${category.relPrefix}/agents/`;
    let removed = 0;
    for (const relPath of [...manifest.keys()]) {
      if (!relPath.startsWith(prefix)) continue;
      const fileName = relPath.slice(relPath.lastIndexOf("/") + 1);
      const isLeftover =
        AGENT_STORE_DB_BASENAMES.some((name) => fileName.startsWith(`${name}.corrupt-`)) ||
        AGENT_STORE_DB_BASENAMES.some((name) => SQLITE_DB_SIDECAR_SUFFIXES.some((suffix) => fileName === `${name}${suffix}`)) ||
        AGENT_STORE_DB_BASENAMES.some((name) => fileName === `${name}.pending` || fileName.startsWith(`${name}.replacement`));
      if (isLeftover) {
        this.manifestStore.deleteManifestEntry(manifest, relPath);
        this.transfer.localStat.delete(relPath);
        this.storeDbCaptures.delete(relPath);
        removed += 1;
        continue;
      }
      const basename = AGENT_STORE_DB_BASENAMES.find((name) => relPath.endsWith(`/${name}`));
      if (basename == null) continue;
      const rest = relPath.slice(prefix.length, relPath.length - `/${basename}`.length);
      const topId = rest.split("/")[0] ?? "";
      if (topId.length === 0) continue;
      // A nested path under an agent's directory is not a database this file ever writes.
      const isGone = !existing.has(topId) || rest.includes("/");
      if (!isGone) continue;
      this.manifestStore.deleteManifestEntry(manifest, relPath);
      this.transfer.localStat.delete(relPath);
      this.storeDbCaptures.delete(relPath);
      removed += 1;
    }
    if (removed > 0) this.log(`pruned ${removed} agent db entries for deleted files/agents`);
    return removed;
  }

  /** One agent's bundle, for a turn that just ended. The answer says whether it is committed, not just whether it ran. */
  async runAgentStoreDbSnapshot(agentId: string): Promise<StoreDbSnapshotResult> {
    const summary: CategoryTransferSummary = { name: "store.db", filesScanned: 0, filesUploaded: 0, bytesUploaded: 0, skippedUnchanged: 0, removed: 0, oversize: 0, failures: 0, metadataFailures: 0 };
    const captureTrace = createStoreDbCaptureTrace();
    let storeId: string | null = null;
    const finish = (outcome: StoreDbCaptureOutcome, isCommitted: boolean): StoreDbSnapshotResult => ({ outcome, summary, captureTrace, isCommitted, storeId });
    if (this.isStopped()) return finish("skipped", false);
    const category = this.deps.categories.find((candidate) => candidate.containsAgentStoreDbs);
    if (category == null) return finish("skipped", false);
    const agentDir = join(category.absRoot, "agents", agentId);
    if (!AGENT_STORE_DB_BASENAMES.some((basename) => existsSync(join(agentDir, basename)))) return finish("skipped", false);

    try {
      if (!(await this.ensureWriterLock())) return finish("skipped", false);
      storeId = await this.deps.resolveStoreId();
      const manifest = await this.manifestStore.loadManifest(storeId);
      let manifestChanged = false;
      const targets: DbBundleTarget[] = [];
      let bundleBlocked = false;
      if (await this.bundleCapture.agentHasPendingDbRecovery(agentDir)) {
        summary.failures += 1;
        recordStoreDbCaptureFailure(captureTrace, "capture");
        bundleBlocked = true;
      }
      for (const basename of AGENT_STORE_DB_BASENAMES) {
        const absPath = join(agentDir, basename);
        const relPath = `${category.relPrefix}/agents/${agentId}/${basename}`;
        let fileStat;
        try {
          fileStat = await stat(absPath);
        } catch (error) {
          if (findSystemErrno(error) !== "ENOENT") {
            this.log(`agent db ${relPath} stat failed: ${errorMessage(error)}`);
            summary.failures += 1;
            recordStoreDbCaptureFailure(captureTrace, "capture");
            bundleBlocked = true;
          }
          continue;
        }
        const walStat = await this.bundleCapture.readWalStat(absPath);
        targets.push({ relPath, absPath, effectiveSize: fileStat.size + (walStat != null && walStat.size > 0 ? walStat.size : 0) });
      }

      let bundleCommitted = false;
      if (!bundleBlocked && targets.length > 0) {
        const failuresBefore = summary.failures;
        const oversizeBefore = summary.oversize;
        const before = new Map(targets.map((target) => [target.relPath, manifest.get(target.relPath)]));
        bundleCommitted = await this.bundleCapture.captureAgentDbBundle({
          agentId,
          agentDir,
          relPrefix: category.relPrefix,
          storeId,
          manifest,
          targets,
          summary,
          captureTrace,
        });
        if (bundleCommitted) {
          manifestChanged = targets.some((target) => !boxStoreManifestEntriesEqual(before.get(target.relPath), manifest.get(target.relPath)));
        } else if (summary.failures === failuresBefore && summary.oversize === oversizeBefore) {
          summary.failures += 1;
          recordStoreDbCaptureFailure(captureTrace, "capture");
        }
      }

      // The agent may have been deleted while its snapshot was being taken: its entries go with it.
      try {
        await stat(agentDir);
      } catch (error) {
        if (findSystemErrno(error) === "ENOENT") {
          for (const basename of AGENT_STORE_DB_BASENAMES) {
            const relPath = `${category.relPrefix}/agents/${agentId}/${basename}`;
            if (this.manifestStore.deleteManifestEntry(manifest, relPath)) {
              this.transfer.localStat.delete(relPath);
              this.storeDbCaptures.delete(relPath);
              summary.removed += 1;
              manifestChanged = true;
            }
          }
        }
      }

      if (manifestChanged || summary.failures > 0) {
        try {
          // A failed capture is written down too: the manifest is the only place that remembers it happened.
          await this.manifestStore.saveManifest(storeId, { isForced: summary.failures > 0, captureTrace });
        } catch (error) {
          recordStoreDbCaptureFailure(captureTrace, "manifest_commit");
          throw error;
        }
      }
      if (targets.some((target) => this.manifestStore.uncommittedStoreDbEntries.has(target.relPath))) await this.manifestStore.writeQueue;

      const outcome = aggregateStoreDbSweepOutcome(summary);
      const isCommitted = bundleCommitted && (outcome === "uploaded" || outcome === "unchanged") && this.bundleCapture.isAgentDbBundleCommitted(manifest, targets);
      if (!isCommitted && (outcome === "uploaded" || outcome === "unchanged")) {
        // The bytes are up but the manifest never landed: as far as the next host is concerned, nothing was captured.
        recordStoreDbCaptureFailure(captureTrace, "manifest_commit");
        return finish("error", false);
      }
      if (outcome === "uploaded") this.log(`agent db bundle ${agentId} uploaded`);
      return finish(outcome, isCommitted);
    } catch (error) {
      this.log(`store.db ${agentId} failed: ${errorMessage(error)}`);
      recordStoreDbCaptureFailure(captureTrace, "capture");
      return finish("error", false);
    }
  }
}

export interface BoxStoreDbCaptureTelemetrySummary {
  readonly outcome: StoreDbCaptureOutcome;
  readonly trigger: string;
  readonly failurePhase?: string | undefined;
  readonly isCommitted: boolean;
  readonly agentCount: number;
  readonly filesScanned: number;
  readonly filesUploaded: number;
  readonly bytes: number;
  readonly durationMs: number;
  readonly queueDurationMs: number;
  readonly captureDurationMs: number;
  readonly blobUploadDurationMs: number;
  readonly manifestCommitDurationMs: number;
  readonly storeId?: string | null;
}

export function boxStoreDbCaptureTelemetry(summary: BoxStoreDbCaptureTelemetrySummary): { level: "warn" | "info"; metadata: Record<string, string | undefined> } {
  return {
    level: summary.outcome === "error" || summary.outcome === "skipped" ? "warn" : "info",
    metadata: {
      outcome: summary.outcome,
      trigger: summary.trigger,
      failure_phase: summary.failurePhase,
      committed: String(summary.isCommitted),
      agent_count: String(summary.agentCount),
      files_scanned: String(summary.filesScanned),
      files_uploaded: String(summary.filesUploaded),
      bytes: String(summary.bytes),
      duration_ms: String(summary.durationMs),
      queue_duration_ms: String(summary.queueDurationMs),
      capture_duration_ms: String(summary.captureDurationMs),
      blob_upload_duration_ms: String(summary.blobUploadDurationMs),
      manifest_commit_duration_ms: String(summary.manifestCommitDurationMs),
      store_id: summary.storeId ?? undefined,
    },
  };
}
