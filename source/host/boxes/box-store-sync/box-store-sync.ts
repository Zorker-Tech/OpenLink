/**
 * One store, kept in step: the cycle, the turn-end capture, and the lock that says who may write.
 *
 * The synchroniser is deliberately the only place that decides *when* the store is written:
 *
 * - a cycle writes everything it may (each category, then the agent stores, then the manifest), and a cycle that finds
 *   another writer is not an error — it reports `locked` and the next tick tries again;
 * - two triggers never interleave: a cycle that is already running either answers `in-flight` immediately or waits for
 *   the one in flight, which is what a flush (a user asking "now") needs;
 * - a turn's end schedules a capture for that one agent, debounced, so a burst of turns does not become a burst of uploads;
 * - the writer lock is held for the life of the store, and forgetting an agent or clearing the store takes it too, because
 *   those are writes that a second host must not race.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DebouncePolicy } from "../../extensions/scheduling.ts";
import { tryAcquireStoreLock } from "../../../packages/agent-store-sync/store-lock.ts";
import { errorMessage } from "../../../shared/errors/summary.ts";
import { isBoxStoreManifestFileEntry } from "./box-store-manifest-format.ts";
import { BoxStoreManifestStore, countAgentDirManifestEntries, countStoreDbManifestEntries, type ManifestStoreDependencies } from "./box-store-manifest.ts";
import type { BoxStoreDownloadOptions, BoxStoreDownloadSummary } from "./box-store-download.ts";
import { removeHydrationHandoffMarker } from "./box-store-hydration.ts";
import { isBoxStorePackBuildEnabled } from "./box-store-pack.ts";
import { aggregateStoreDbSweepOutcome, StoreDbCapture, type StoreDbCaptureOutcome, type StoreDbSweepResult } from "./store-db-capture.ts";
import { createStoreDbCaptureTrace, recordStoreDbCaptureFailure } from "./store-db-bundle-capture.ts";
import { BoxStoreTransfer, type BoxStoreTransferCategory, type CategoryTransferSummary } from "./box-store-transfer.ts";

export const DEFAULT_MAX_OBJECT_BYTES = 32 * 1024 * 1024 * 1024;
export const DEFAULT_COPY_IN_CONCURRENCY = 128;
export const DEFAULT_SNAPSHOT_OUT_CONCURRENCY = 8;
/** Past this size an object is streamed rather than held: the difference between a copy and a memory spike. */
export const LARGE_OBJECT_THRESHOLD_BYTES = 64 * 1024 * 1024;
export const DOWNLOAD_IN_FLIGHT_BYTE_BUDGET = 256 * 1024 * 1024;

export type BoxStoreCategory = BoxStoreTransferCategory;
export type CategorySummary = CategoryTransferSummary;

export interface BoxStoreCycleSummary {
  ok: boolean;
  reason?: string;
  storeId: string | null;
  durationMs: number;
  categories: CategorySummary[];
  manifestEntries: number;
  storeDbEntries: number;
  storeDbComplete: boolean;
  agentDirEntries: number;
  totalFilesUploaded: number;
  totalBytesUploaded: number;
  totalFailures: number;
  metadataFailures: number;
}

export interface BoxStoreCaptureSummary extends Record<string, unknown> {
  trigger: "flush" | "turn_end";
  outcome: StoreDbCaptureOutcome;
  agentCount: number;
  filesScanned: number;
  filesUploaded: number;
  bytes: number;
  durationMs: number;
  queueDurationMs: number;
  captureDurationMs: number;
  blobUploadDurationMs: number;
  manifestCommitDurationMs: number;
  isCommitted: boolean;
  failurePhase?: string | undefined;
  storeId?: string | null;
}

export interface BoxStoreSyncDependencies extends ManifestStoreDependencies {
  categories: readonly BoxStoreCategory[];
  maxObjectBytes?: number;
  downloadConcurrency?: number;
  uploadConcurrency?: number;
  largeObjectThresholdBytes?: number;
  downloadInFlightByteBudgetBytes?: number;
  now?: () => number;
  log?: (message: string) => void;
  readFreeDiskBytes?(path: string): Promise<number | undefined>;
  hasLiveHandle?(dbPath: string): boolean;
  vacuumInto?(args: { srcPath: string; destPath: string }): Promise<void>;
  getWriteGeneration?(dbPath: string): number;
  lockPath?: string;
  acquireWriterLock?(args: { lockPath: string; windowId: string }): Promise<{ release(): Promise<void> } | null>;
  storeDbDebounce: DebouncePolicy;
  onCycle?(summary: BoxStoreCycleSummary): void;
  onStoreDbCapture?(summary: BoxStoreCaptureSummary): void;
}

export interface SnapshotOptions {
  includeIdleOnly?: boolean;
  includeStoreDbs?: boolean;
  skipLiveHandleStoreDbs?: boolean;
  chromeSessionOnly?: boolean;
  waitForInFlight?: boolean;
  acceptMatchingCanonicalOnConflict?: boolean;
  includePacks?: boolean;
}

/** The store's orchestrator: a manifest, a transfer, and the per-agent database capture over both. */
export class BoxStoreSync {
  readonly manifestStore: BoxStoreManifestStore;
  readonly transfer: BoxStoreTransfer;
  readonly storeDbCapture: StoreDbCapture;
  readonly now: () => number;
  readonly log: (message: string) => void;
  private writerLock: { release(): Promise<void> } | undefined;
  private readonly pendingStoreDb = new Map<string, ReturnType<DebouncePolicy["wrap"]>>();
  private cycleInFlight = false;
  private flushWaiters = 0;
  private inFlight: Promise<BoxStoreCycleSummary> | undefined;
  private disposed = false;
  private stopped = false;

  constructor(readonly deps: BoxStoreSyncDependencies) {
    const maxObjectBytes = deps.maxObjectBytes ?? DEFAULT_MAX_OBJECT_BYTES;
    const downloadConcurrency = Math.max(1, deps.downloadConcurrency ?? DEFAULT_COPY_IN_CONCURRENCY);
    const uploadConcurrency = Math.max(1, deps.uploadConcurrency ?? DEFAULT_SNAPSHOT_OUT_CONCURRENCY);
    const largeObjectThreshold = Math.max(1, deps.largeObjectThresholdBytes ?? LARGE_OBJECT_THRESHOLD_BYTES);
    const downloadByteBudget = Math.max(1, deps.downloadInFlightByteBudgetBytes ?? DOWNLOAD_IN_FLIGHT_BYTE_BUDGET);
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? ((message) => console.log(`[box-store-sync] ${message}`));
    this.manifestStore = new BoxStoreManifestStore({ deps, now: this.now, log: this.log, isDisposed: () => this.disposed });
    this.transfer = new BoxStoreTransfer({
      deps,
      now: this.now,
      log: this.log,
      manifestStore: this.manifestStore,
      maxObjectBytes,
      downloadConcurrency,
      uploadConcurrency,
      largeObjectThreshold,
      downloadByteBudget,
      getFlushWaiters: () => this.flushWaiters,
    });
    this.storeDbCapture = new StoreDbCapture({
      deps,
      now: this.now,
      log: this.log,
      manifestStore: this.manifestStore,
      transfer: this.transfer,
      maxObjectBytes,
      uploadConcurrency,
      largeObjectThreshold,
      ensureWriterLock: () => this.ensureWriterLock(),
      isStopped: () => this.stopped,
    });
  }

  get manifestV2Enabled(): boolean {
    return this.manifestStore.isManifestV2Enabled;
  }

  enrollManifestV2(): void {
    this.manifestStore.enrollManifestV2();
  }

  objectStore(storeId: string) {
    return this.deps.objectStoreProvider.forStore(storeId);
  }

  private elapsedDurationMs(startedAt: number): number {
    return Math.max(0, this.now() - startedAt);
  }

  /** The writer lock, taken once and held: a second host's store must not write while this one is alive. */
  async ensureWriterLock(): Promise<boolean> {
    if (this.writerLock != null) return true;
    const lockPath = this.deps.lockPath;
    if (lockPath == null) return true;
    const acquire = this.deps.acquireWriterLock ?? defaultAcquireWriterLock;
    try {
      const lock = await acquire({ lockPath, windowId: this.deps.windowId ?? `box-store-${process.pid}` });
      if (lock == null) return false;
      this.writerLock = lock;
      return true;
    } catch (error) {
      this.log(`writer lock error: ${errorMessage(error)}`);
      return false;
    }
  }

  /**
   * A snapshot, from whichever trigger asked for it. A cycle that is already running answers `in-flight` — unless the
   * caller is willing to wait, which a user-triggered flush is.
   */
  async snapshotNow(options: SnapshotOptions = {}): Promise<BoxStoreCycleSummary> {
    if (this.stopped) return this.emptyCycle("stopped", this.now());
    if (this.cycleInFlight) {
      if (!options.waitForInFlight) return this.emptyCycle("in-flight", this.now());
      this.flushWaiters += 1;
      try {
        while (this.cycleInFlight) await Promise.allSettled([this.inFlight]);
      } finally {
        this.flushWaiters -= 1;
      }
    }
    this.cycleInFlight = true;
    const run = this.runCycle(options);
    this.inFlight = run;
    try {
      return await run;
    } finally {
      this.cycleInFlight = false;
      this.inFlight = undefined;
    }
  }

  async runCycle(options: SnapshotOptions): Promise<BoxStoreCycleSummary> {
    const start = this.now();
    let storeDbCapture: { startedAt: number; storeId: string; sweep: StoreDbSweepResult } | undefined;
    let isStoreDbCaptureReported = false;
    try {
      if (!(await this.ensureWriterLock())) return this.report(this.emptyCycle("locked", start));
      const storeId = await this.deps.resolveStoreId();
      const categories: CategorySummary[] = [];

      for (const category of this.deps.categories) {
        // A chrome-session-only cycle carries the staged session and nothing else; an idle-only category waits for idle.
        if ((options.chromeSessionOnly && !category.stageOnly) || (category.idleOnly && !options.includeIdleOnly)) continue;
        try {
          categories.push(await this.transfer.syncCategory(storeId, category));
        } catch (error) {
          this.log(`category ${category.name} failed: ${errorMessage(error)}`);
          categories.push({ name: category.name, filesScanned: 0, filesUploaded: 0, bytesUploaded: 0, skippedUnchanged: 0, removed: 0, oversize: 0, failures: 1, metadataFailures: 0 });
        }
      }

      await this.storeDbCapture.pruneMissingAgentStoreDbs(storeId);
      let storeDbComplete = false;
      let capturedThisSweep = new Set<string>();
      if (options.includeStoreDbs) {
        const captureStartedAt = this.now();
        let sweep: StoreDbSweepResult;
        try {
          sweep = await this.storeDbCapture.runAgentStoreDbsSweep(storeId, options.skipLiveHandleStoreDbs === true);
        } catch (error) {
          this.log(`store.db flush failed: ${errorMessage(error)}`);
          const captureTrace = createStoreDbCaptureTrace();
          recordStoreDbCaptureFailure(captureTrace, "capture");
          sweep = {
            summary: { name: "store.db", filesScanned: 0, filesUploaded: 0, bytesUploaded: 0, skippedUnchanged: 0, removed: 0, oversize: 0, failures: 1, metadataFailures: 0 },
            complete: false,
            agentCount: 0,
            capturedThisSweep: new Set(),
            captureTrace,
            manifest: undefined,
          };
        }
        storeDbCapture = { startedAt: captureStartedAt, storeId, sweep };
        categories.push(sweep.summary);
        storeDbComplete = sweep.complete;
        capturedThisSweep = sweep.capturedThisSweep;
      }

      // Pruning after the sweep can have removed an agent whose store was captured before it disappeared: completeness is
      // only claimed once the manifest agrees with what was actually captured.
      const prunedAfterSweep = await this.storeDbCapture.pruneMissingAgentStoreDbs(storeId);
      if (options.includeStoreDbs && storeDbComplete && prunedAfterSweep > 0) {
        const category = this.deps.categories.find((candidate) => candidate.containsAgentStoreDbs);
        if (category != null) {
          storeDbComplete = await this.storeDbCapture.verifyAgentDbsComplete(join(category.absRoot, "agents"), category.relPrefix, await this.manifestStore.loadManifest(storeId), capturedThisSweep);
        }
      }

      const markerPath = this.deps.hydrationHandoffMarkerPath;
      const promoteFullyHydrated =
        markerPath != null && existsSync(markerPath) && options.includeIdleOnly === true && options.includeStoreDbs === true && storeDbComplete && categories.every((category) => category.failures === 0 && category.oversize === 0);
      const hasCycleFailures = categories.some((category) => category.failures > 0 || category.oversize > 0);
      try {
        await this.manifestStore.saveManifest(storeId, {
          acceptMatchingCanonicalOnConflict: options.acceptMatchingCanonicalOnConflict === true,
          isForced: hasCycleFailures,
          hydrationUpdate: promoteFullyHydrated ? "promote-complete" : undefined,
          captureTrace: storeDbCapture?.sweep.captureTrace,
        });
      } catch (error) {
        if (storeDbCapture != null) recordStoreDbCaptureFailure(storeDbCapture.sweep.captureTrace, "manifest_commit");
        throw error;
      }

      if (storeDbCapture != null) {
        const outcome = aggregateStoreDbSweepOutcome(storeDbCapture.sweep.summary);
        this.reportStoreDbSweepCapture(storeDbCapture, outcome, {
          isCommitted:
            storeDbCapture.sweep.complete &&
            (outcome === "uploaded" || outcome === "unchanged") &&
            this.manifestStore.isStoreDbSweepCommitted(storeDbCapture.sweep.manifest, storeDbCapture.sweep.capturedThisSweep),
        });
        isStoreDbCaptureReported = true;
      }
      // The handoff marker is the only signal that the old store has been fully hydrated: it is removed after the cycle
      // that proved it, not before.
      if (promoteFullyHydrated) await removeHydrationHandoffMarker(markerPath).catch((error) => this.log(`hydration handoff marker cleanup failed: ${errorMessage(error)}`));
      if (options.includePacks === true && isBoxStorePackBuildEnabled()) categories.push(await this.transfer.syncPacks(storeId));
      return this.report(this.buildSummary(storeId, start, categories, storeDbComplete));
    } catch (error) {
      if (storeDbCapture != null && !isStoreDbCaptureReported) {
        recordStoreDbCaptureFailure(storeDbCapture.sweep.captureTrace, "capture");
        this.reportStoreDbSweepCapture(storeDbCapture, "error", { isCommitted: false });
      }
      this.log(`cycle failed: ${errorMessage(error)}`);
      return this.report(this.emptyCycle(errorMessage(error), start));
    }
  }

  /** A turn ended: capture that agent's store once the burst of turns has settled. */
  scheduleStoreDbSnapshot(agentId: string): void {
    if (this.disposed || this.stopped) return;
    let trigger = this.pendingStoreDb.get(agentId);
    if (trigger === undefined) {
      trigger = this.deps.storeDbDebounce.wrap(() => {
        void this.snapshotStoreDb(agentId).catch((error) => this.log(`turn-end store.db snapshot rejected: ${errorMessage(error)}`));
      });
      this.pendingStoreDb.set(agentId, trigger);
    }
    trigger();
  }

  async snapshotStoreDb(agentId: string): Promise<BoxStoreCaptureSummary["outcome"]> {
    const start = this.now();
    const result = await this.storeDbCapture.runAgentStoreDbSnapshot(agentId);
    this.reportStoreDbCapture({
      trigger: "turn_end",
      outcome: result.outcome,
      agentCount: result.outcome === "skipped" ? 0 : 1,
      filesScanned: result.summary.filesScanned,
      filesUploaded: result.summary.filesUploaded,
      bytes: result.summary.bytesUploaded,
      durationMs: this.elapsedDurationMs(start),
      queueDurationMs: result.captureTrace.queueDurationMs,
      captureDurationMs: result.captureTrace.captureDurationMs,
      blobUploadDurationMs: result.captureTrace.blobUploadDurationMs,
      manifestCommitDurationMs: result.captureTrace.manifestCommitDurationMs,
      isCommitted: result.isCommitted,
      failurePhase: result.captureTrace.failurePhase,
      storeId: result.storeId,
    });
    return result.outcome;
  }

  async download(targetDir: string, options: BoxStoreDownloadOptions = {}): Promise<BoxStoreDownloadSummary> {
    return this.transfer.download(targetDir, options);
  }

  async readManifestStrict() {
    return this.manifestStore.readManifestStrict();
  }

  async readManifestStrictDetailed() {
    return this.manifestStore.readManifestStrictDetailed();
  }

  async markLegacyHydrationIncomplete(): Promise<void> {
    return this.manifestStore.markLegacyHydrationIncomplete();
  }

  async markLegacyHydrationCompleteForHandoff(): Promise<void> {
    return this.manifestStore.markLegacyHydrationCompleteForHandoff();
  }

  async sweepLeakedTemps(): Promise<number> {
    return this.transfer.sweepLeakedTemps();
  }

  async readStoreStatus() {
    const empty = { durable: false, fullyHydrated: undefined, entryCount: 0, storeDbEntries: 0, agentDirEntries: 0, totalBytes: 0, lastSnapshotAtMs: 0 };
    try {
      const snapshot = await this.manifestStore.readCanonicalManifestSnapshot();
      if (snapshot == null) return empty;
      const manifest = new Map(Object.entries(snapshot.entries));
      const entries = [...manifest.values()];
      const totalBytes = entries.reduce((sum, entry) => sum + (isBoxStoreManifestFileEntry(entry) ? entry.size : 0), 0);
      return {
        durable: entries.length > 0,
        fullyHydrated: snapshot.fullyHydrated,
        entryCount: entries.length,
        storeDbEntries: countStoreDbManifestEntries(manifest),
        agentDirEntries: countAgentDirManifestEntries(manifest),
        totalBytes,
        lastSnapshotAtMs: snapshot.updatedAtMs,
      };
    } catch (error) {
      this.log(`readStoreStatus failed: ${errorMessage(error)}`);
      return empty;
    }
  }

  /** Clearing is a stop, not a pause: the store refuses to run again until it is rebuilt. */
  async clearStore(): Promise<{ ok: boolean; reason?: string }> {
    this.stopped = true;
    for (const trigger of this.pendingStoreDb.values()) trigger.dispose();
    this.pendingStoreDb.clear();
    try {
      if (!(await this.ensureWriterLock())) return { ok: false, reason: "locked" };
      const storeId = await this.deps.resolveStoreId();
      await this.manifestStore.prepareCanonicalManifestReset(storeId);
      if (this.deps.hydrationHandoffMarkerPath != null) await removeHydrationHandoffMarker(this.deps.hydrationHandoffMarkerPath);
      this.manifestStore.hydrationManifestReadBlocked = false;
      this.manifestStore.manifest = new Map();
      this.manifestStore.initializeManifestRevision(this.manifestStore.manifest, undefined);
      this.manifestStore.uncommittedStoreDbEntries.clear();
      await this.manifestStore.saveManifest(storeId, { hydrationUpdate: "reset-complete" });
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: errorMessage(error) };
    }
  }

  /** Forgetting an agent removes its entries from the manifest — the box's local copy is the caller's to remove. */
  async forgetAgent(agentId: string): Promise<{ ok: boolean; reason?: string }> {
    const pending = this.pendingStoreDb.get(agentId);
    if (pending != null) {
      pending.dispose();
      this.pendingStoreDb.delete(agentId);
    }
    try {
      if (!(await this.ensureWriterLock())) return { ok: false, reason: "locked" };
      const storeId = await this.deps.resolveStoreId();
      const manifest = await this.manifestStore.loadManifest(storeId);
      const needle = `/agents/${agentId}/`;
      const ownPrefix = `agents/${agentId}/`;
      let removed = 0;
      for (const relPath of [...manifest.keys()]) {
        if (!relPath.includes(needle) && !relPath.startsWith(ownPrefix)) continue;
        this.manifestStore.deleteManifestEntry(manifest, relPath);
        this.transfer.localStat.delete(relPath);
        this.storeDbCapture.storeDbCaptures.delete(relPath);
        removed += 1;
      }
      if (removed > 0) {
        await this.manifestStore.saveManifest(storeId);
        this.log(`forgot ${agentId} (${removed} entries)`);
      }
      return { ok: true };
    } catch (error) {
      this.log(`forget ${agentId} failed: ${errorMessage(error)}`);
      return { ok: false, reason: errorMessage(error) };
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const trigger of this.pendingStoreDb.values()) trigger.dispose();
    this.pendingStoreDb.clear();
    await this.manifestStore.writeQueue;
    await this.writerLock?.release().catch((error) => this.log(`writer lock release failed: ${errorMessage(error)}`));
    this.writerLock = undefined;
  }

  private buildSummary(storeId: string, start: number, categories: CategorySummary[], storeDbComplete: boolean): BoxStoreCycleSummary {
    return {
      ok: true,
      storeId,
      durationMs: this.now() - start,
      categories,
      manifestEntries: this.manifestStore.manifest?.size ?? 0,
      storeDbEntries: countStoreDbManifestEntries(this.manifestStore.manifest),
      storeDbComplete,
      agentDirEntries: countAgentDirManifestEntries(this.manifestStore.manifest),
      totalFilesUploaded: categories.reduce((sum, category) => sum + category.filesUploaded, 0),
      totalBytesUploaded: categories.reduce((sum, category) => sum + category.bytesUploaded, 0),
      totalFailures: categories.reduce((sum, category) => sum + category.failures + category.oversize, 0),
      metadataFailures: categories.reduce((sum, category) => sum + category.metadataFailures, 0),
    };
  }

  private emptyCycle(reason: string, start: number): BoxStoreCycleSummary {
    return {
      ok: false,
      reason,
      storeId: null,
      durationMs: this.now() - start,
      categories: [],
      manifestEntries: this.manifestStore.manifest?.size ?? 0,
      storeDbEntries: countStoreDbManifestEntries(this.manifestStore.manifest),
      storeDbComplete: false,
      agentDirEntries: countAgentDirManifestEntries(this.manifestStore.manifest),
      totalFilesUploaded: 0,
      totalBytesUploaded: 0,
      totalFailures: 0,
      metadataFailures: 0,
    };
  }

  private reportStoreDbSweepCapture(capture: { startedAt: number; storeId: string; sweep: StoreDbSweepResult }, outcome: StoreDbCaptureOutcome, publication: { isCommitted: boolean }): void {
    const { sweep } = capture;
    this.reportStoreDbCapture({
      trigger: "flush",
      outcome,
      agentCount: sweep.agentCount,
      filesScanned: sweep.summary.filesScanned,
      filesUploaded: sweep.summary.filesUploaded,
      bytes: sweep.summary.bytesUploaded,
      durationMs: this.elapsedDurationMs(capture.startedAt),
      queueDurationMs: sweep.captureTrace.queueDurationMs,
      captureDurationMs: sweep.captureTrace.captureDurationMs,
      blobUploadDurationMs: sweep.captureTrace.blobUploadDurationMs,
      manifestCommitDurationMs: sweep.captureTrace.manifestCommitDurationMs,
      isCommitted: publication.isCommitted,
      failurePhase: sweep.captureTrace.failurePhase,
      storeId: capture.storeId,
    });
  }

  private reportStoreDbCapture(summary: BoxStoreCaptureSummary): void {
    try {
      this.deps.onStoreDbCapture?.(summary);
    } catch {
      // A telemetry sink that throws is not a capture that failed.
    }
  }

  private report(summary: BoxStoreCycleSummary): BoxStoreCycleSummary {
    if (summary.ok) {
      this.log(`cycle ok in ${summary.durationMs}ms: ${summary.totalFilesUploaded} files / ${summary.totalBytesUploaded}B up, ${summary.manifestEntries} entries, ${summary.totalFailures} failures`);
    } else {
      this.log(`cycle skipped (${summary.reason})`);
    }
    try {
      this.deps.onCycle?.(summary);
    } catch {
      // As above: reporting is not part of the cycle's success.
    }
    return summary;
  }
}

async function defaultAcquireWriterLock(args: { lockPath: string; windowId: string }): Promise<{ release(): Promise<void> } | null> {
  const result = await tryAcquireStoreLock({ lockPath: args.lockPath, windowId: args.windowId });
  if (result.kind === "acquired") return { release: () => result.lock.dispose() };
  return null;
}

/** The telemetry shape of a cycle: what a reader needs to tell a quiet cycle from a broken one. */
export function boxStoreSyncCycleTelemetry(summary: BoxStoreCycleSummary): { level: "info" | "warn"; metadata: Record<string, string> } | null {
  if (!summary.ok) {
    // A cycle that found another writer is not worth a warning: it is the normal cost of two hosts on one box.
    if (summary.reason === "in-flight") return null;
    return {
      level: "warn",
      metadata: {
        ok: "false",
        reason: summary.reason === "locked" ? "locked" : "error",
        duration_ms: String(summary.durationMs),
        manifest_entries: String(summary.manifestEntries),
        store_db_entries: String(summary.storeDbEntries),
      },
    };
  }
  const excludedFiles = summary.categories.reduce((sum, category) => sum + (category.excludedFiles ?? 0), 0);
  const excludedBytes = summary.categories.reduce((sum, category) => sum + (category.excludedBytes ?? 0), 0);
  const prunedDirs = summary.categories.reduce((sum, category) => sum + (category.prunedDirs ?? 0), 0);
  const metadata: Record<string, string> = {
    ok: "true",
    duration_ms: String(summary.durationMs),
    files_uploaded: String(summary.totalFilesUploaded),
    bytes_uploaded: String(summary.totalBytesUploaded),
    manifest_entries: String(summary.manifestEntries),
    excluded_files: String(excludedFiles),
    excluded_bytes: String(excludedBytes),
    pruned_dirs: String(prunedDirs),
    store_db_entries: String(summary.storeDbEntries),
    store_id: summary.storeId ?? "",
    failures: String(summary.totalFailures),
  };
  for (const category of summary.categories) {
    metadata[`${category.name}_uploaded`] = String(category.filesUploaded);
    metadata[`${category.name}_bytes`] = String(category.bytesUploaded);
  }
  return { level: "info", metadata };
}

/**
 * What a flush (a user asking for "now") can honestly promise: a complete cycle, unless the store databases were not
 * complete, the filesystem could not describe a file, or the chrome session could not be staged.
 */
export function evaluateBoxStoreFlush(summary: BoxStoreCycleSummary | null | undefined, options: { sessionCategoryName: string }) {
  if (summary?.ok !== true) return { ok: false, manifestEntries: 0, storeDbEntries: 0, agentDirEntries: 0, storeDbComplete: false, filesUploaded: 0, reason: summary?.reason ?? "error" };
  if (summary.categories.some((category) => category.name === "store.db") && !summary.storeDbComplete) {
    return { ok: false, manifestEntries: summary.manifestEntries, storeDbEntries: summary.storeDbEntries, agentDirEntries: summary.agentDirEntries, storeDbComplete: false, filesUploaded: summary.totalFilesUploaded, reason: "store-db-incomplete" };
  }
  if (summary.metadataFailures > 0) {
    return {
      ok: false,
      manifestEntries: summary.manifestEntries,
      storeDbEntries: summary.storeDbEntries,
      agentDirEntries: summary.agentDirEntries,
      storeDbComplete: summary.storeDbComplete,
      filesUploaded: summary.totalFilesUploaded,
      reason: "filesystem-metadata-incomplete",
    };
  }
  if ((summary.categories.find((category) => category.name === options.sessionCategoryName)?.failures ?? 0) > 0) {
    return {
      ok: false,
      manifestEntries: summary.manifestEntries,
      storeDbEntries: summary.storeDbEntries,
      agentDirEntries: summary.agentDirEntries,
      storeDbComplete: summary.storeDbComplete,
      filesUploaded: summary.totalFilesUploaded,
      reason: "chrome-session-stage-failed",
    };
  }
  return { ok: true, manifestEntries: summary.manifestEntries, storeDbEntries: summary.storeDbEntries, agentDirEntries: summary.agentDirEntries, storeDbComplete: summary.storeDbComplete, filesUploaded: summary.totalFilesUploaded, reason: "" };
}
