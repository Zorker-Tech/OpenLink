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
import { BoxStoreManifestStore, countAgentDirManifestEntries, countStoreDbManifestEntries } from "./box-store-manifest.ts";
import type { BoxStoreDownloadOptions, BoxStoreDownloadSummary } from "./box-store-download.ts";
import { removeHydrationHandoffMarker } from "./box-store-hydration.ts";
import { isBoxStorePackBuildEnabled } from "./box-store-pack.ts";
import { aggregateStoreDbSweepOutcome, StoreDbCapture, type StoreDbCaptureOutcome, type StoreDbSweepResult } from "./store-db-capture.ts";
import { createStoreDbCaptureTrace, recordStoreDbCaptureFailure } from "./store-db-bundle-capture.ts";
import { BoxStoreTransfer } from "./box-store-transfer.ts";
import type { BoxStoreCaptureSummary, BoxStoreCycleSummary, BoxStoreSyncDependencies, CategorySummary, SnapshotOptions } from "./box-store-sync-contracts.ts";

export const DEFAULT_MAX_OBJECT_BYTES = 32 * 1024 * 1024 * 1024;
export const DEFAULT_COPY_IN_CONCURRENCY = 128;
export const DEFAULT_SNAPSHOT_OUT_CONCURRENCY = 8;
/** Past this size an object is streamed rather than held: the difference between a copy and a memory spike. */
export const LARGE_OBJECT_THRESHOLD_BYTES = 64 * 1024 * 1024;
export const DOWNLOAD_IN_FLIGHT_BYTE_BUDGET = 256 * 1024 * 1024;

/** The store's orchestrator: a manifest, a transfer, and the per-agent database capture over both. */
export class BoxStoreSync {
  private readonly manifestRepository: BoxStoreManifestStore;
  private readonly transferEngine: BoxStoreTransfer;
  private readonly storeDbSnapshots: StoreDbCapture;
  private readonly clock: () => number;
  private readonly reportLog: (message: string) => void;
  private readonly configuration: BoxStoreSyncDependencies;
  private writerLock: { release(): Promise<void> } | undefined;
  private readonly turnCaptureTimers = new Map<string, ReturnType<DebouncePolicy["wrap"]>>();
  private cycleActive = false;
  private flushWaiterCount = 0;
  private activeCycle: Promise<BoxStoreCycleSummary> | undefined;
  private closing = false;
  private halted = false;

  constructor(dependencies: BoxStoreSyncDependencies) {
    this.configuration = dependencies;
    const maxObjectBytes = dependencies.maxObjectBytes ?? DEFAULT_MAX_OBJECT_BYTES;
    const downloadConcurrency = Math.max(1, dependencies.downloadConcurrency ?? DEFAULT_COPY_IN_CONCURRENCY);
    const uploadConcurrency = Math.max(1, dependencies.uploadConcurrency ?? DEFAULT_SNAPSHOT_OUT_CONCURRENCY);
    const largeObjectThreshold = Math.max(1, dependencies.largeObjectThresholdBytes ?? LARGE_OBJECT_THRESHOLD_BYTES);
    const downloadByteBudget = Math.max(1, dependencies.downloadInFlightByteBudgetBytes ?? DOWNLOAD_IN_FLIGHT_BYTE_BUDGET);
    this.clock = dependencies.now ?? Date.now;
    this.reportLog = dependencies.log ?? ((message) => console.log(`[box-store-sync] ${message}`));
    this.manifestRepository = new BoxStoreManifestStore({ deps: dependencies, now: this.clock, log: this.reportLog, isDisposed: () => this.closing });
    this.transferEngine = new BoxStoreTransfer({
      deps: dependencies,
      now: this.clock,
      log: this.reportLog,
      manifestStore: this.manifestRepository,
      maxObjectBytes,
      downloadConcurrency,
      uploadConcurrency,
      largeObjectThreshold,
      downloadByteBudget,
      getFlushWaiters: () => this.flushWaiterCount,
    });
    this.storeDbSnapshots = new StoreDbCapture({
      deps: dependencies,
      now: this.clock,
      log: this.reportLog,
      manifestStore: this.manifestRepository,
      transfer: this.transferEngine,
      maxObjectBytes,
      uploadConcurrency,
      largeObjectThreshold,
      ensureWriterLock: () => this.ensureWriterLock(),
      isStopped: () => this.halted,
    });
  }

  get manifestV2Enabled(): boolean {
    return this.manifestRepository.isManifestV2Enabled;
  }

  enrollManifestV2(): void {
    this.manifestRepository.enrollManifestV2();
  }

  objectStore(storeId: string) {
    return this.configuration.objectStoreProvider.forStore(storeId);
  }

  private elapsedMs(startedAt: number): number {
    return Math.max(0, this.clock() - startedAt);
  }

  /** The writer lock, taken once and held: a second host's store must not write while this one is alive. */
  async ensureWriterLock(): Promise<boolean> {
    if (this.writerLock != null) return true;
    const lockPath = this.configuration.lockPath;
    if (lockPath == null) return true;
    try {
      return await this.rememberWriterLease(lockPath);
    } catch (error) {
      this.reportLog(`writer lock error: ${errorMessage(error)}`);
      return false;
    }
  }

  private async rememberWriterLease(lockPath: string): Promise<boolean> {
    const acquire = this.configuration.acquireWriterLock ?? defaultAcquireWriterLock;
    const lease = await acquire({ lockPath, windowId: this.configuration.windowId ?? `box-store-${process.pid}` });
    if (lease === null) return false;
    this.writerLock = lease;
    return true;
  }

  /**
   * A snapshot, from whichever trigger asked for it. A cycle that is already running answers `in-flight` — unless the
   * caller is willing to wait, which a user-triggered flush is.
   */
  async snapshotNow(options: SnapshotOptions = {}): Promise<BoxStoreCycleSummary> {
    if (this.halted) return this.skippedCycle("stopped", this.clock());
    if (await this.deferToActiveCycle(Boolean(options.waitForInFlight))) return this.skippedCycle("in-flight", this.clock());
    this.cycleActive = true;
    const run = this.runCycle(options);
    this.activeCycle = run;
    try {
      return await run;
    } finally {
      this.cycleActive = false;
      this.activeCycle = undefined;
    }
  }

  private async deferToActiveCycle(waitForCompletion: boolean): Promise<boolean> {
    if (!this.cycleActive) return false;
    if (!waitForCompletion) return true;
    this.flushWaiterCount += 1;
    try {
      while (this.cycleActive) await Promise.allSettled([this.activeCycle]);
      return false;
    } finally {
      this.flushWaiterCount -= 1;
    }
  }

  async runCycle(options: SnapshotOptions): Promise<BoxStoreCycleSummary> {
    const startedAt = this.clock();
    let databaseSweep: { startedAt: number; storeId: string; sweep: StoreDbSweepResult } | undefined;
    let databaseSweepReported = false;
    try {
      if (!(await this.ensureWriterLock())) return this.publishCycle(this.skippedCycle("locked", startedAt));
      const storeId = await this.configuration.resolveStoreId();
      const categories = await this.syncEligibleCategories(storeId, options);
      await this.storeDbSnapshots.pruneMissingAgentStoreDbs(storeId);
      databaseSweep = await this.captureStoreDbsIfRequested(storeId, options);
      let storeDbComplete = databaseSweep?.sweep.complete ?? false;
      if (databaseSweep !== undefined) {
        categories.push(databaseSweep.sweep.summary);
      }

      // Pruning after the sweep can have removed an agent whose store was captured before it disappeared: completeness is
      // only claimed once the manifest agrees with what was actually captured.
      const prunedAfterSweep = await this.storeDbSnapshots.pruneMissingAgentStoreDbs(storeId);
      storeDbComplete = await this.confirmStoreDbCompletion(storeId, databaseSweep, storeDbComplete, prunedAfterSweep);

      const promoteFullyHydrated = this.shouldPromoteHandoff(options, categories, storeDbComplete);
      await this.commitCycleManifest(storeId, options, categories, promoteFullyHydrated, databaseSweep);

      if (databaseSweep !== undefined) {
        const outcome = aggregateStoreDbSweepOutcome(databaseSweep.sweep.summary);
        this.publishSweepResult(databaseSweep, outcome, {
          isCommitted:
            databaseSweep.sweep.complete &&
            (outcome === "uploaded" || outcome === "unchanged") &&
            this.manifestRepository.isStoreDbSweepCommitted(databaseSweep.sweep.manifest, databaseSweep.sweep.capturedThisSweep),
        });
        databaseSweepReported = true;
      }
      // The handoff marker is the only signal that the old store has been fully hydrated: it is removed after the cycle
      // that proved it, not before.
      if (promoteFullyHydrated) {
        const markerPath = this.configuration.hydrationHandoffMarkerPath!;
        await removeHydrationHandoffMarker(markerPath).catch((error) => this.reportLog(`hydration handoff marker cleanup failed: ${errorMessage(error)}`));
      }
      if (options.includePacks === true && isBoxStorePackBuildEnabled()) categories.push(await this.transferEngine.syncPacks(storeId));
      return this.publishCycle(this.assembleCycleSummary(storeId, startedAt, categories, storeDbComplete));
    } catch (error) {
      if (databaseSweep !== undefined && !databaseSweepReported) {
        recordStoreDbCaptureFailure(databaseSweep.sweep.captureTrace, "capture");
        this.publishSweepResult(databaseSweep, "error", { isCommitted: false });
      }
      this.reportLog(`cycle failed: ${errorMessage(error)}`);
      return this.publishCycle(this.skippedCycle(errorMessage(error), startedAt));
    }
  }

  private async syncEligibleCategories(storeId: string, options: SnapshotOptions): Promise<CategorySummary[]> {
    const summaries: CategorySummary[] = [];
    for (const category of this.configuration.categories) {
      const excludedByView = Boolean(options.chromeSessionOnly && !category.stageOnly);
      const waitingForIdle = Boolean(category.idleOnly && !options.includeIdleOnly);
      if (excludedByView || waitingForIdle) continue;
      try {
        summaries.push(await this.transferEngine.syncCategory(storeId, category));
      } catch (error) {
        this.reportLog(`category ${category.name} failed: ${errorMessage(error)}`);
        summaries.push({
          name: category.name,
          filesScanned: 0,
          filesUploaded: 0,
          bytesUploaded: 0,
          skippedUnchanged: 0,
          removed: 0,
          oversize: 0,
          failures: 1,
          metadataFailures: 0,
        });
      }
    }
    return summaries;
  }

  private async captureStoreDbsIfRequested(
    storeId: string,
    options: SnapshotOptions,
  ): Promise<{ startedAt: number; storeId: string; sweep: StoreDbSweepResult } | undefined> {
    if (!options.includeStoreDbs) return undefined;
    const startedAt = this.clock();
    try {
      const sweep = await this.storeDbSnapshots.runAgentStoreDbsSweep(storeId, options.skipLiveHandleStoreDbs === true);
      return { startedAt, storeId, sweep };
    } catch (error) {
      this.reportLog(`store.db flush failed: ${errorMessage(error)}`);
      const captureTrace = createStoreDbCaptureTrace();
      recordStoreDbCaptureFailure(captureTrace, "capture");
      return {
        startedAt,
        storeId,
        sweep: {
          summary: { name: "store.db", filesScanned: 0, filesUploaded: 0, bytesUploaded: 0, skippedUnchanged: 0, removed: 0, oversize: 0, failures: 1, metadataFailures: 0 },
          complete: false,
          agentCount: 0,
          capturedThisSweep: new Set(),
          captureTrace,
          manifest: undefined,
        },
      };
    }
  }

  private async confirmStoreDbCompletion(
    storeId: string,
    capture: { startedAt: number; storeId: string; sweep: StoreDbSweepResult } | undefined,
    currentlyComplete: boolean,
    removedAfterSweep: number,
  ): Promise<boolean> {
    if (capture === undefined || !currentlyComplete || removedAfterSweep === 0) return currentlyComplete;
    const category = this.configuration.categories.find((candidate) => candidate.containsAgentStoreDbs);
    if (category === undefined) return currentlyComplete;
    const agentRoot = join(category.absRoot, "agents");
    const currentManifest = await this.manifestRepository.loadManifest(storeId);
    return this.storeDbSnapshots.verifyAgentDbsComplete(
      agentRoot,
      category.relPrefix,
      currentManifest,
      capture.sweep.capturedThisSweep,
    );
  }

  private shouldPromoteHandoff(
    options: SnapshotOptions,
    summaries: readonly CategorySummary[],
    storeDbComplete: boolean,
  ): boolean {
    const marker = this.configuration.hydrationHandoffMarkerPath;
    return marker != null
      && existsSync(marker)
      && options.includeIdleOnly === true
      && options.includeStoreDbs === true
      && storeDbComplete
      && summaries.every((summary) => summary.failures === 0 && summary.oversize === 0);
  }

  private async commitCycleManifest(
    storeId: string,
    options: SnapshotOptions,
    summaries: readonly CategorySummary[],
    promoteFullyHydrated: boolean,
    capture: { startedAt: number; storeId: string; sweep: StoreDbSweepResult } | undefined,
  ): Promise<void> {
    const hasIncompleteCategory = summaries.some((summary) => summary.failures > 0 || summary.oversize > 0);
    try {
      await this.manifestRepository.saveManifest(storeId, {
        acceptMatchingCanonicalOnConflict: options.acceptMatchingCanonicalOnConflict === true,
        isForced: hasIncompleteCategory,
        hydrationUpdate: promoteFullyHydrated ? "promote-complete" : undefined,
        captureTrace: capture?.sweep.captureTrace,
      });
    } catch (error) {
      if (capture !== undefined) recordStoreDbCaptureFailure(capture.sweep.captureTrace, "manifest_commit");
      throw error;
    }
  }

  /** A turn ended: capture that agent's store once the burst of turns has settled. */
  scheduleStoreDbSnapshot(agentId: string): void {
    if (this.closing || this.halted) return;
    let trigger = this.turnCaptureTimers.get(agentId);
    if (trigger === undefined) {
      trigger = this.configuration.storeDbDebounce.wrap(() => {
        void this.snapshotStoreDb(agentId).catch((error) => this.reportLog(`turn-end store.db snapshot rejected: ${errorMessage(error)}`));
      });
      this.turnCaptureTimers.set(agentId, trigger);
    }
    trigger();
  }

  async snapshotStoreDb(agentId: string): Promise<BoxStoreCaptureSummary["outcome"]> {
    const start = this.clock();
    const result = await this.storeDbSnapshots.runAgentStoreDbSnapshot(agentId);
    this.publishStoreDbResult({
      trigger: "turn_end",
      outcome: result.outcome,
      agentCount: result.outcome === "skipped" ? 0 : 1,
      filesScanned: result.summary.filesScanned,
      filesUploaded: result.summary.filesUploaded,
      bytes: result.summary.bytesUploaded,
      durationMs: this.elapsedMs(start),
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
    return this.transferEngine.download(targetDir, options);
  }

  async readManifestStrict() {
    return this.manifestRepository.readManifestStrict();
  }

  async readManifestStrictDetailed() {
    return this.manifestRepository.readManifestStrictDetailed();
  }

  async markLegacyHydrationIncomplete(): Promise<void> {
    return this.manifestRepository.markLegacyHydrationIncomplete();
  }

  async markLegacyHydrationCompleteForHandoff(): Promise<void> {
    return this.manifestRepository.markLegacyHydrationCompleteForHandoff();
  }

  async sweepLeakedTemps(): Promise<number> {
    return this.transferEngine.sweepLeakedTemps();
  }

  async readStoreStatus() {
    try {
      const snapshot = await this.manifestRepository.readCanonicalManifestSnapshot();
      return snapshot == null ? emptyStoreStatus() : statusFromCanonicalManifest(snapshot);
    } catch (error) {
      this.reportLog(`readStoreStatus failed: ${errorMessage(error)}`);
      return emptyStoreStatus();
    }
  }

  /** Clearing is a stop, not a pause: the store refuses to run again until it is rebuilt. */
  async clearStore(): Promise<{ ok: boolean; reason?: string }> {
    this.halted = true;
    this.disposeTurnCaptureTimers();
    try {
      if (!(await this.ensureWriterLock())) return { ok: false, reason: "locked" };
      const storeId = await this.configuration.resolveStoreId();
      await this.manifestRepository.prepareCanonicalManifestReset(storeId);
      if (this.configuration.hydrationHandoffMarkerPath != null) await removeHydrationHandoffMarker(this.configuration.hydrationHandoffMarkerPath);
      this.manifestRepository.hydrationManifestReadBlocked = false;
      this.manifestRepository.manifest = new Map();
      this.manifestRepository.initializeManifestRevision(this.manifestRepository.manifest, undefined);
      this.manifestRepository.uncommittedStoreDbEntries.clear();
      await this.manifestRepository.saveManifest(storeId, { hydrationUpdate: "reset-complete" });
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: errorMessage(error) };
    }
  }

  /** Forgetting an agent removes its entries from the manifest — the box's local copy is the caller's to remove. */
  async forgetAgent(agentId: string): Promise<{ ok: boolean; reason?: string }> {
    const pending = this.turnCaptureTimers.get(agentId);
    if (pending != null) {
      pending.dispose();
      this.turnCaptureTimers.delete(agentId);
    }
    try {
      if (!(await this.ensureWriterLock())) return { ok: false, reason: "locked" };
      const storeId = await this.configuration.resolveStoreId();
      const manifest = await this.manifestRepository.loadManifest(storeId);
      let removed = 0;
      for (const relPath of [...manifest.keys()]) {
        if (!pathBelongsToAgent(relPath, agentId)) continue;
        this.manifestRepository.deleteManifestEntry(manifest, relPath);
        this.transferEngine.localStat.delete(relPath);
        this.storeDbSnapshots.storeDbCaptures.delete(relPath);
        removed += 1;
      }
      if (removed > 0) {
        await this.manifestRepository.saveManifest(storeId);
        this.reportLog(`forgot ${agentId} (${removed} entries)`);
      }
      return { ok: true };
    } catch (error) {
      this.reportLog(`forget ${agentId} failed: ${errorMessage(error)}`);
      return { ok: false, reason: errorMessage(error) };
    }
  }

  async dispose(): Promise<void> {
    this.closing = true;
    this.disposeTurnCaptureTimers();
    await this.manifestRepository.writeQueue;
    await this.writerLock?.release().catch((error) => this.reportLog(`writer lock release failed: ${errorMessage(error)}`));
    this.writerLock = undefined;
  }

  private disposeTurnCaptureTimers(): void {
    const timers = [...this.turnCaptureTimers.values()];
    this.turnCaptureTimers.clear();
    for (const timer of timers) timer.dispose();
  }

  private assembleCycleSummary(storeId: string, start: number, categories: CategorySummary[], storeDbComplete: boolean): BoxStoreCycleSummary {
    return {
      ok: true,
      storeId,
      durationMs: this.clock() - start,
      categories,
      manifestEntries: this.manifestRepository.manifest?.size ?? 0,
      storeDbEntries: countStoreDbManifestEntries(this.manifestRepository.manifest),
      storeDbComplete,
      agentDirEntries: countAgentDirManifestEntries(this.manifestRepository.manifest),
      totalFilesUploaded: categories.reduce((sum, category) => sum + category.filesUploaded, 0),
      totalBytesUploaded: categories.reduce((sum, category) => sum + category.bytesUploaded, 0),
      totalFailures: categories.reduce((sum, category) => sum + category.failures + category.oversize, 0),
      metadataFailures: categories.reduce((sum, category) => sum + category.metadataFailures, 0),
    };
  }

  private skippedCycle(reason: string, start: number): BoxStoreCycleSummary {
    return {
      ok: false,
      reason,
      storeId: null,
      durationMs: this.clock() - start,
      categories: [],
      manifestEntries: this.manifestRepository.manifest?.size ?? 0,
      storeDbEntries: countStoreDbManifestEntries(this.manifestRepository.manifest),
      storeDbComplete: false,
      agentDirEntries: countAgentDirManifestEntries(this.manifestRepository.manifest),
      totalFilesUploaded: 0,
      totalBytesUploaded: 0,
      totalFailures: 0,
      metadataFailures: 0,
    };
  }

  private publishSweepResult(capture: { startedAt: number; storeId: string; sweep: StoreDbSweepResult }, outcome: StoreDbCaptureOutcome, publication: { isCommitted: boolean }): void {
    const { sweep } = capture;
    this.publishStoreDbResult({
      trigger: "flush",
      outcome,
      agentCount: sweep.agentCount,
      filesScanned: sweep.summary.filesScanned,
      filesUploaded: sweep.summary.filesUploaded,
      bytes: sweep.summary.bytesUploaded,
      durationMs: this.elapsedMs(capture.startedAt),
      queueDurationMs: sweep.captureTrace.queueDurationMs,
      captureDurationMs: sweep.captureTrace.captureDurationMs,
      blobUploadDurationMs: sweep.captureTrace.blobUploadDurationMs,
      manifestCommitDurationMs: sweep.captureTrace.manifestCommitDurationMs,
      isCommitted: publication.isCommitted,
      failurePhase: sweep.captureTrace.failurePhase,
      storeId: capture.storeId,
    });
  }

  private publishStoreDbResult(summary: BoxStoreCaptureSummary): void {
    try {
      this.configuration.onStoreDbCapture?.(summary);
    } catch {
      // A telemetry sink that throws is not a capture that failed.
    }
  }

  private publishCycle(summary: BoxStoreCycleSummary): BoxStoreCycleSummary {
    if (summary.ok) {
      this.reportLog(`cycle ok in ${summary.durationMs}ms: ${summary.totalFilesUploaded} files / ${summary.totalBytesUploaded}B up, ${summary.manifestEntries} entries, ${summary.totalFailures} failures`);
    } else {
      this.reportLog(`cycle skipped (${summary.reason})`);
    }
    try {
      this.configuration.onCycle?.(summary);
    } catch {
      // As above: reporting is not part of the cycle's success.
    }
    return summary;
  }
}

async function defaultAcquireWriterLock(args: { lockPath: string; windowId: string }): Promise<{ release(): Promise<void> } | null> {
  const attempt = await tryAcquireStoreLock({ lockPath: args.lockPath, windowId: args.windowId });
  switch (attempt.kind) {
    case "acquired":
      return { release: () => attempt.lock.dispose() };
    case "held":
      return null;
    default:
      return null;
  }
}

type CanonicalStoreManifest = NonNullable<Awaited<ReturnType<BoxStoreManifestStore["readCanonicalManifestSnapshot"]>>>;

function emptyStoreStatus() {
  return {
    durable: false,
    fullyHydrated: undefined,
    entryCount: 0,
    storeDbEntries: 0,
    agentDirEntries: 0,
    totalBytes: 0,
    lastSnapshotAtMs: 0,
  };
}

function statusFromCanonicalManifest(snapshot: CanonicalStoreManifest) {
  const manifest = new Map(Object.entries(snapshot.entries));
  const records = [...manifest.values()];
  const totalBytes = records.reduce((total, entry) => total + (isBoxStoreManifestFileEntry(entry) ? entry.size : 0), 0);
  return {
    durable: records.length > 0,
    fullyHydrated: snapshot.fullyHydrated,
    entryCount: records.length,
    storeDbEntries: countStoreDbManifestEntries(manifest),
    agentDirEntries: countAgentDirManifestEntries(manifest),
    totalBytes,
    lastSnapshotAtMs: snapshot.updatedAtMs,
  };
}

function pathBelongsToAgent(relPath: string, agentId: string): boolean {
  const homeRelativePrefix = `agents/${agentId}/`;
  const nestedStorePrefix = `/agents/${agentId}/`;
  return relPath.startsWith(homeRelativePrefix) || relPath.includes(nestedStorePrefix);
}
