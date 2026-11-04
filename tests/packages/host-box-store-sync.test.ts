import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { RetryPolicy, DebouncePolicy } from "../../source/host/extensions/scheduling.ts";
import type { BoxObjectStore } from "../../source/host/boxes/box-store-sync/box-object-store.ts";
import { BoxStoreSync, type BoxStoreCategory, type CategorySummary, type BoxStoreSyncDependencies } from "../../source/host/boxes/box-store-sync/box-store-sync.ts";
import type { BoxStoreManifestStore, ManifestSaveOptions } from "../../source/host/boxes/box-store-sync/box-store-manifest.ts";
import type { BoxStoreTransfer } from "../../source/host/boxes/box-store-sync/box-store-transfer.ts";
import { createStoreDbCaptureTrace } from "../../source/host/boxes/box-store-sync/store-db-bundle-capture.ts";
import type { StoreDbCapture, StoreDbCaptureOutcome, StoreDbSnapshotResult, StoreDbSweepResult } from "../../source/host/boxes/box-store-sync/store-db-capture.ts";

function manualDebounce() {
  const pending: Array<() => void> = [];
  let disposedCount = 0;
  const policy: DebouncePolicy = {
    name: "test-debounce",
    wrap<Args extends unknown[]>(fn: (...args: Args) => void) {
      let latestArgs: Args | undefined;
      let disposed = false;
      let enqueued = false;
      const dispatch = (...args: Args) => {
        latestArgs = args;
        if (enqueued) return;
        enqueued = true;
        pending.push(() => {
          enqueued = false;
          if (disposed || latestArgs === undefined) return;
          const argsToRun = latestArgs;
          latestArgs = undefined;
          fn(...argsToRun);
        });
      };
      const wrapped = dispatch as typeof dispatch & { dispose(): void };
      wrapped.dispose = () => {
        if (disposed) return;
        disposed = true;
        latestArgs = undefined;
        disposedCount += 1;
      };
      return wrapped;
    },
  };
  return {
    policy,
    flush() { for (const run of pending.splice(0)) run(); },
    get pendingCount() { return pending.length; },
    get disposedCount() { return disposedCount; },
  };
}

function syncWorld(options: {
  readonly categories?: readonly BoxStoreCategory[];
  readonly lockPath?: string;
  readonly acquireWriterLock?: BoxStoreSyncDependencies["acquireWriterLock"];
  readonly onCycle?: BoxStoreSyncDependencies["onCycle"];
  readonly onStoreDbCapture?: BoxStoreSyncDependencies["onStoreDbCapture"];
  readonly hydrationHandoffMarkerPath?: string;
  readonly now?: () => number;
} = {}) {
  const records = new Map<string, Uint8Array>();
  const objectStore: BoxObjectStore = {
    async get(key) { return records.get(key) ?? null; },
    async put(key, bytes) { records.set(key, Uint8Array.from(bytes)); },
    async list(prefix) { return [...records.keys()].filter((key) => key.startsWith(prefix)); },
    async delete(key) { records.delete(key); },
  };
  const debounce = manualDebounce();
  let storeIdLookups = 0;
  const retry: RetryPolicy = {
    name: "test-manifest-retry",
    schedule() { return { elapsed: Promise.resolve(), dispose() {} }; },
    async runWithRetry(work, signal) { return work(1, signal ?? new AbortController().signal); },
  };
  const dependencies: BoxStoreSyncDependencies = {
    categories: options.categories ?? [],
    objectStoreProvider: { forStore: () => objectStore },
    async resolveStoreId() { storeIdLookups += 1; return "store-1"; },
    manifestRetry: retry,
    manifestV2: true,
    storeDbDebounce: debounce.policy,
    now: options.now ?? (() => 100),
    log: () => {},
    ...(options.lockPath === undefined ? {} : { lockPath: options.lockPath }),
    ...(options.acquireWriterLock === undefined ? {} : { acquireWriterLock: options.acquireWriterLock }),
    ...(options.onCycle === undefined ? {} : { onCycle: options.onCycle }),
    ...(options.onStoreDbCapture === undefined ? {} : { onStoreDbCapture: options.onStoreDbCapture }),
    ...(options.hydrationHandoffMarkerPath === undefined ? {} : { hydrationHandoffMarkerPath: options.hydrationHandoffMarkerPath }),
  };
  const sync = new BoxStoreSync(dependencies);
  const internals = sync as unknown as {
    manifestRepository: BoxStoreManifestStore;
    transferEngine: BoxStoreTransfer;
    storeDbSnapshots: StoreDbCapture;
  };
  return { sync, internals, records, debounce, get storeIdLookups() { return storeIdLookups; } };
}

const category = (name: string, flags: Partial<BoxStoreCategory> = {}): BoxStoreCategory => ({
  name,
  absRoot: `/unread/${name}`,
  relPrefix: name,
  ...flags,
});

function categorySummary(name: string, filesUploaded = 1): CategorySummary {
  return {
    name,
    filesScanned: filesUploaded,
    filesUploaded,
    bytesUploaded: filesUploaded * 5,
    skippedUnchanged: 0,
    removed: 0,
    oversize: 0,
    failures: 0,
    metadataFailures: 0,
  };
}

function snapshotResult(outcome: StoreDbCaptureOutcome = "uploaded"): StoreDbSnapshotResult {
  return {
    outcome,
    summary: { ...categorySummary("store.db"), name: "store.db" },
    captureTrace: createStoreDbCaptureTrace(),
    isCommitted: true,
    storeId: "store-1",
  };
}

test("a missing writer lock reports locked before resolving or scanning the store", async () => {
  const cycleReports: string[] = [];
  const world = syncWorld({
    lockPath: "/locks/store.lock",
    acquireWriterLock: async () => null,
    categories: [category("workspace")],
    onCycle: (summary) => cycleReports.push(String(summary.reason)),
  });
  let categoryRuns = 0;
  world.internals.transferEngine.syncCategory = async () => { categoryRuns += 1; return categorySummary("workspace"); };

  const result = await world.sync.snapshotNow();
  assert.equal(result.ok, false);
  assert.equal(result.reason, "locked");
  assert.equal(world.storeIdLookups, 0);
  assert.equal(categoryRuns, 0);
  assert.deepEqual(cycleReports, ["locked"]);
})

test("a cycle filters categories, isolates one category failure and forces the manifest write", async () => {
  const categories = [
    category("workspace"),
    category("idle", { idleOnly: true }),
    category("session", { stageOnly: true }),
    category("session-idle", { stageOnly: true, idleOnly: true }),
    category("broken"),
  ];
  const world = syncWorld({ categories });
  const executed: string[] = [];
  world.internals.transferEngine.syncCategory = async (_storeId, entry) => {
    executed.push(entry.name);
    if (entry.name === "broken") throw new Error("category read failed");
    return categorySummary(entry.name);
  };
  const writes: Array<ManifestSaveOptions | undefined> = [];
  const saveManifest = world.internals.manifestRepository.saveManifest.bind(world.internals.manifestRepository);
  world.internals.manifestRepository.saveManifest = async (storeId, saveOptions) => {
    writes.push(saveOptions);
    return saveManifest(storeId, saveOptions);
  };

  const sessionOnly = await world.sync.snapshotNow({ chromeSessionOnly: true });
  assert.deepEqual(executed, ["session"]);
  assert.equal(sessionOnly.ok, true);

  executed.length = 0;
  const complete = await world.sync.snapshotNow({ includeIdleOnly: true });
  assert.deepEqual(executed, ["workspace", "idle", "session", "session-idle", "broken"]);
  assert.equal(complete.ok, true, "one category error is reported in the summary rather than aborting the cycle");
  assert.deepEqual(complete.categories.map((entry) => [entry.name, entry.failures]), [
    ["workspace", 0],
    ["idle", 0],
    ["session", 0],
    ["session-idle", 0],
    ["broken", 1],
  ]);
  assert.equal(complete.totalFilesUploaded, 4);
  assert.equal(complete.totalFailures, 1);
  assert.equal(writes.at(-1)?.isForced, true);
})

test("an in-flight cycle is skipped unless a caller asks to wait for it", async () => {
  const world = syncWorld({ categories: [category("workspace")] });
  let releaseFirst!: () => void;
  let announceStart!: () => void;
  const firstStarted = new Promise<void>((resolve) => { announceStart = resolve; });
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let runCount = 0;
  world.internals.transferEngine.syncCategory = async (_storeId, entry) => {
    runCount += 1;
    if (runCount === 1) {
      announceStart();
      await firstGate;
    }
    return categorySummary(entry.name);
  };

  const active = world.sync.snapshotNow();
  await firstStarted;
  const skipped = await world.sync.snapshotNow();
  let waiterFinished = false;
  const waiting = world.sync.snapshotNow({ waitForInFlight: true }).then((summary) => {
    waiterFinished = true;
    return summary;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(skipped.reason, "in-flight");
  assert.equal(waiterFinished, false);
  releaseFirst();
  assert.equal((await active).ok, true);
  assert.equal((await waiting).ok, true);
  assert.equal(runCount, 2);
})

test("turn-end store snapshots coalesce per agent and disposal cancels pending callbacks", async () => {
  const captures: string[] = [];
  const reports: string[] = [];
  const world = syncWorld({ onStoreDbCapture: (summary) => reports.push(summary.trigger) });
  world.internals.storeDbSnapshots.runAgentStoreDbSnapshot = async (agentId) => {
    captures.push(agentId);
    return snapshotResult();
  };

  world.sync.scheduleStoreDbSnapshot("agent-a");
  world.sync.scheduleStoreDbSnapshot("agent-a");
  world.sync.scheduleStoreDbSnapshot("agent-b");
  assert.equal(world.debounce.pendingCount, 2);
  world.debounce.flush();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(captures, ["agent-a", "agent-b"]);
  assert.deepEqual(reports, ["turn_end", "turn_end"]);

  world.sync.scheduleStoreDbSnapshot("agent-c");
  await world.sync.dispose();
  world.debounce.flush();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(captures, ["agent-a", "agent-b"]);
  assert.equal(world.debounce.disposedCount, 3);
})

test("store status describes the persisted manifest without counting symlink bytes", async () => {
  const world = syncWorld();
  const manifest = await world.internals.manifestRepository.loadManifest("store-1");
  world.internals.manifestRepository.setManifestEntry(manifest, "home/box/slate-data/agents/a/store.db", { kind: "file", sha: "db-a", size: 7, mode: 0o600 });
  world.internals.manifestRepository.setManifestEntry(manifest, "home/box/slate-data/agents/a/note.txt", { kind: "file", sha: "note-a", size: 3, mode: 0o644 });
  world.internals.manifestRepository.setManifestEntry(manifest, "home/box/slate-data/agents/b/link", { kind: "symlink", target: "../shared" });
  await world.internals.manifestRepository.saveManifest("store-1");

  assert.deepEqual(await world.sync.readStoreStatus(), {
    durable: true,
    fullyHydrated: undefined,
    entryCount: 3,
    storeDbEntries: 1,
    agentDirEntries: 2,
    totalBytes: 10,
    lastSnapshotAtMs: 100,
  });
})

test("forgetting an agent removes its exact path segment and its cached database capture", async () => {
  const world = syncWorld();
  const manifest = await world.internals.manifestRepository.loadManifest("store-1");
  const removedDb = "home/box/slate-data/agents/a/store.db";
  world.internals.manifestRepository.setManifestEntry(manifest, removedDb, { kind: "file", sha: "db-a", size: 7, mode: 0o600 });
  world.internals.manifestRepository.setManifestEntry(manifest, "home/box/slate-data/agents/a/note.txt", { kind: "file", sha: "note-a", size: 3, mode: 0o644 });
  world.internals.manifestRepository.setManifestEntry(manifest, "home/box/slate-data/agents/ab/store.db", { kind: "file", sha: "db-ab", size: 9, mode: 0o600 });
  world.internals.manifestRepository.setManifestEntry(manifest, "project/agents/a/log.txt", { kind: "file", sha: "log-a", size: 2, mode: 0o600 });
  world.internals.storeDbSnapshots.storeDbCaptures.set(removedDb, {} as never);

  assert.deepEqual(await world.sync.forgetAgent("a"), { ok: true });
  assert.deepEqual([...manifest.keys()], ["home/box/slate-data/agents/ab/store.db"]);
  assert.equal(world.internals.storeDbSnapshots.storeDbCaptures.has(removedDb), false);
})

test("the writer lock is acquired once and released when the synchroniser is disposed", async () => {
  let acquisitions = 0;
  let releases = 0;
  const world = syncWorld({
    lockPath: "/locks/box-store",
    acquireWriterLock: async () => {
      acquisitions += 1;
      return { async release() { releases += 1; } };
    },
  });

  assert.equal(await world.sync.ensureWriterLock(), true);
  assert.equal(await world.sync.ensureWriterLock(), true);
  assert.equal(acquisitions, 1);
  await world.sync.dispose();
  assert.equal(releases, 1);
})

test("a complete idle cycle promotes the handoff marker only after its manifest commit", async () => {
  const root = mkdtempSync(join(tmpdir(), "slate-store-sync-handoff-"));
  try {
    const markerPath = join(root, "handoff.marker");
    writeFileSync(markerPath, "pending");
    const captures: Array<Record<string, unknown>> = [];
    const world = syncWorld({
      categories: [category("workspace", { idleOnly: true, containsAgentStoreDbs: true })],
      hydrationHandoffMarkerPath: markerPath,
      onStoreDbCapture: (summary) => captures.push(summary),
    });
    world.records.set("manifest.json", new TextEncoder().encode(JSON.stringify({
      version: 2,
      updatedAtMs: 10,
      writerWindowId: "old-window",
      fullyHydrated: false,
      entries: {},
    })));
    world.internals.transferEngine.syncCategory = async (_storeId, item) => categorySummary(item.name, 0);
    const manifest = await world.internals.manifestRepository.loadManifest("store-1");
    let pruneCalls = 0;
    world.internals.storeDbSnapshots.pruneMissingAgentStoreDbs = async () => { pruneCalls += 1; return 0; };
    world.internals.storeDbSnapshots.runAgentStoreDbsSweep = async () => ({
      summary: categorySummary("store.db"),
      complete: true,
      agentCount: 1,
      capturedThisSweep: new Set<string>(),
      captureTrace: createStoreDbCaptureTrace(),
      manifest,
    } satisfies StoreDbSweepResult);
    let hydrationUpdate: ManifestSaveOptions["hydrationUpdate"];
    const saveManifest = world.internals.manifestRepository.saveManifest.bind(world.internals.manifestRepository);
    world.internals.manifestRepository.saveManifest = async (storeId, options) => {
      hydrationUpdate = options?.hydrationUpdate;
      return saveManifest(storeId, options);
    };

    const result = await world.sync.snapshotNow({ includeIdleOnly: true, includeStoreDbs: true });
    assert.equal(result.ok, true);
    assert.equal(result.storeDbComplete, true);
    assert.deepEqual(result.categories.map((entry) => entry.name), ["workspace", "store.db"]);
    assert.equal(pruneCalls, 2);
    assert.equal(hydrationUpdate, "promote-complete");
    assert.equal(captures.length, 1);
    assert.equal(captures[0]?.trigger, "flush");
    assert.equal(captures[0]?.outcome, "uploaded");
    assert.equal(captures[0]?.isCommitted, true);
    assert.equal(existsSync(markerPath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
})

test("clearing removes the handoff marker and leaves the store stopped", async () => {
  const root = mkdtempSync(join(tmpdir(), "slate-store-sync-"));
  try {
    const markerPath = join(root, "handoff.marker");
    writeFileSync(markerPath, "pending");
    const world = syncWorld({ hydrationHandoffMarkerPath: markerPath });
    const cleared = await world.sync.clearStore();
    assert.deepEqual(cleared, { ok: true });
    assert.equal(world.records.size > 0, true);
    assert.equal(existsSync(markerPath), false);
    const callsBeforeStoppedCheck = world.storeIdLookups;
    const stopped = await world.sync.snapshotNow();
    assert.equal(stopped.reason, "stopped");
    assert.equal(world.storeIdLookups, callsBeforeStoppedCheck);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
})
