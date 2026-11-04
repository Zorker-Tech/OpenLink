import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Clock, DebouncePolicy, PollingPolicy, RetryPolicy } from "../../source/host/extensions/scheduling.ts";
import {
  BOX_HOME_CATEGORY_NAME,
  BOX_HOME_PRUNE_GUARDED_FOREIGN_TREES,
  BOX_HOME_REGENERABLE_JUNK_IGNORE_PATTERNS,
  BOX_HOME_REL_PREFIX,
  BOX_HOME_DIR,
  BOX_STORE_CHROME_INTERVAL_MS,
  BOX_STORE_SYNC_INTERVAL_MS,
  SLATE_STORE_BETTER_CLI_ENV,
  buildBoxHomeCategory,
  buildBoxStoreCategories,
  createBoxStoreSyncService,
  type BoxStoreTelemetry,
} from "../../source/host/boxes/box-store-sync/box-store-sync-service.ts";
import type { BoxStoreSyncDependencies, BoxStoreCycleSummary } from "../../source/host/boxes/box-store-sync/box-store-sync.ts";
import { SLATE_BOX_STORE_BACKEND_ENV } from "../../source/host/boxes/box-store-backend-policy.ts";
import { CHROME_SESSION_CATEGORY_NAME } from "../../source/host/boxes/box-store-sync/chrome-session-stage.ts";
import { BOX_STORE_HYDRATION_HANDOFF_FILE_NAME } from "../../source/host/boxes/box-store-sync/box-store-hydration.ts";

interface ServiceHarness {
  service: ReturnType<typeof createBoxStoreSyncService>;
  stores: Array<{
    options: BoxStoreSyncDependencies;
    sweeps: number;
    disposed: number;
    snapshots: Array<Record<string, unknown>>;
    clears: number;
    forgotten: string[];
    scheduled: string[];
  }>;
  calls: {
    sourceMap: number;
    pollingTicks: Array<() => Promise<void>>;
    pollingDisposed: number;
    watcherConfigs: Array<{ onSessionChange(): void }>;
    watcherStarts: number;
    watcherStops: number;
    telemetry: Array<[string, string, Record<string, string | undefined>]>;
    logs: string[];
    events: string[];
  };
  clock: { now: number; monotonic: number };
  setClearResults(results: Array<{ ok: boolean; reason?: string }>): void;
}

function cycleSummary(overrides: Partial<BoxStoreCycleSummary> = {}): BoxStoreCycleSummary {
  return {
    ok: true,
    storeId: "store-1",
    durationMs: 12,
    categories: [],
    manifestEntries: 2,
    storeDbEntries: 1,
    storeDbComplete: true,
    agentDirEntries: 3,
    totalFilesUploaded: 4,
    totalBytesUploaded: 5,
    totalFailures: 0,
    metadataFailures: 0,
    ...overrides,
  };
}

function serviceHarness(options: {
  env?: NodeJS.ProcessEnv;
  idle?: boolean;
  sourceId?: string;
  handoffPending?: boolean;
  summary?: BoxStoreCycleSummary;
  snapshotFailure?: Error;
  sweep?: () => Promise<number>;
  objectStoreProvider?: unknown;
} = {}): ServiceHarness {
  const env = options.env ?? {} as NodeJS.ProcessEnv;
  const calls: ServiceHarness["calls"] = {
    sourceMap: 0,
    pollingTicks: [],
    pollingDisposed: 0,
    watcherConfigs: [],
    watcherStarts: 0,
    watcherStops: 0,
    telemetry: [],
    logs: [],
    events: [],
  };
  const stores: ServiceHarness["stores"] = [];
  const clock = { now: 100, monotonic: 1_000 };
  const clockPort: Clock = {
    now: () => clock.now,
    monotonicNow: () => clock.monotonic,
    schedule: () => ({ dispose() {} }),
  };
  const polling: PollingPolicy = {
    name: "test-poll",
    start(tick) {
      calls.pollingTicks.push(tick);
      return { dispose() { calls.pollingDisposed += 1; } };
    },
  };
  const debounce = { name: "test-debounce", wrap: (fn: (...args: never[]) => void) => Object.assign(fn, { dispose() {} }) } as unknown as DebouncePolicy;
  const retry = {} as RetryPolicy;
  const telemetry: BoxStoreTelemetry = {
    reportBoxStoreSyncCycle(level, metadata) { calls.telemetry.push(["cycle", level, metadata]); },
    reportChromeSessionStage(level, metadata) { calls.telemetry.push(["chrome", level, metadata]); },
    reportBoxStoreManifestConflict(level, metadata) { calls.telemetry.push(["conflict", level, metadata]); },
    reportBoxStoreDbCapture(level, metadata) { calls.telemetry.push(["capture", level, metadata]); },
  };
  let clearResults: Array<{ ok: boolean; reason?: string }> = [];

  const dependencies = {
    env,
    auth: { getAccessToken: () => "token", getMachineId: () => "machine" },
    sourceMap: {
      async getOrCreateBoxStore() {
        calls.sourceMap += 1;
        return { sourceId: options.sourceId ?? "123e4567-e89b-12d3-a456-426614174000" };
      },
    },
    clock: clockPort,
    polling,
    storeDbDebounce: debounce,
    chromeSessionDebounce: debounce,
    chromeStageRetry: retry,
    manifestRetry: retry,
    isIdle: () => options.idle ?? false,
    log: (message: string) => calls.logs.push(message),
    telemetry,
    slateRootDir: "/box-root",
    pathExists: () => options.handoffPending ?? false,
    ...(options.objectStoreProvider === undefined ? {} : { objectStoreProvider: options.objectStoreProvider }),
    createStoreSync(configuration: BoxStoreSyncDependencies) {
      const index = stores.length;
      const store = {
        options: configuration,
        sweeps: 0,
        disposed: 0,
        snapshots: [] as Array<Record<string, unknown>>,
        clears: 0,
        forgotten: [] as string[],
        scheduled: [] as string[],
        async sweepLeakedTemps() {
          calls.events.push(`sweep-${index}`);
          store.sweeps += 1;
          return options.sweep?.() ?? 0;
        },
        async dispose() {
          calls.events.push(`dispose-${index}`);
          store.disposed += 1;
        },
        async snapshotNow(snapshotOptions: Record<string, unknown>) {
          store.snapshots.push(snapshotOptions);
          if (options.snapshotFailure !== undefined) throw options.snapshotFailure;
          return options.summary ?? cycleSummary();
        },
        async readStoreStatus() { return { storeId: `store-${index}`, enabled: true }; },
        async clearStore() {
          calls.events.push(`clear-${index}`);
          store.clears += 1;
          return clearResults.shift() ?? { ok: true };
        },
        async forgetAgent(agentId: string) { store.forgotten.push(agentId); return { ok: true }; },
        scheduleStoreDbSnapshot(agentId: string) { store.scheduled.push(agentId); },
      };
      stores.push(store);
      return store as never;
    },
    createChromeSessionWatcher(watcherDeps: { onSessionChange(): void }) {
      calls.watcherConfigs.push(watcherDeps);
      return {
        start() { calls.watcherStarts += 1; },
        stop() { calls.watcherStops += 1; },
      } as never;
    },
  };

  return {
    service: createBoxStoreSyncService(dependencies as never),
    stores,
    calls,
    clock,
    setClearResults: results => { clearResults = [...results]; },
  };
}

describe("box store sync service contract", () => {
  it("keeps a disabled service callable without starting periodic work", async () => {
    const h = serviceHarness({ env: { SLATE_BOX_STORE_SYNC: "0" } as NodeJS.ProcessEnv });
    assert.equal(h.service.api.isEnabled, false);
    assert.equal(h.service.sync, undefined);
    h.service.start();
    h.service.start();
    assert.equal(h.calls.pollingTicks.length, 0);
    assert.equal(h.calls.watcherStarts, 0);
    assert.deepEqual(h.calls.telemetry, [["cycle", "warn", { ok: "false", reason: "disabled", phase: "startup" }]]);
    assert.equal(await h.service.api.getStoreId(), "123e4567-e89b-12d3-a456-426614174000");
    assert.deepEqual(await h.service.api.snapshotBoxStoreNow({}), {
      ok: false, manifestEntries: 0, storeDbEntries: 0, agentDirEntries: 0, storeDbComplete: false,
      filesUploaded: 0, reason: "store-sync-disabled",
    });
    h.service.api.scheduleStoreDbSnapshot("agent-1");
    await h.service.dispose();
    assert.equal(h.stores.length, 0);
  });

  it("accepts only valid trimmed store-id overrides and otherwise asks the source map", async () => {
    const valid = serviceHarness({ env: { SLATE_BOX_STORE_ID: "  123e4567-e89b-12d3-a456-426614174001  " } as NodeJS.ProcessEnv });
    assert.equal(await valid.service.api.getStoreId(), "123e4567-e89b-12d3-a456-426614174001");
    assert.equal(valid.calls.sourceMap, 0);

    const invalid = serviceHarness({ env: { SLATE_BOX_STORE_ID: "not-a-store" } as NodeJS.ProcessEnv, sourceId: "123e4567-e89b-12d3-a456-426614174002" });
    assert.equal(await invalid.service.api.getStoreId(), "123e4567-e89b-12d3-a456-426614174002");
    assert.equal(invalid.calls.sourceMap, 1);
  });

  it("builds the normal category set and adds home only after both opt-ins", () => {
    assert.equal(BOX_STORE_SYNC_INTERVAL_MS, 2 * 60_000);
    const args = { slateRoot: "/slate", chromeStageRetry: {} as never, reportChromeSessionStage() {}, env: {} as NodeJS.ProcessEnv };
    const base = buildBoxStoreCategories(args);
    assert.equal(base.some(category => category.name === "home"), false);
    assert.equal(base.some(category => category.name === "workspace" && category.absRoot === "/workspace"), true);
    assert.equal(base.some(category => category.name === CHROME_SESSION_CATEGORY_NAME && category.stageOnly === true), true);
    const slateData = base.find(category => category.name === "slate-data");
    assert.equal(slateData?.relPrefix, "home/box/slate-data");
    assert.equal(slateData?.excludes?.includes(`home/box/slate-data/${BOX_STORE_HYDRATION_HANDOFF_FILE_NAME}`), true);

    const enabled = buildBoxStoreCategories({
      ...args,
      env: { [SLATE_STORE_BETTER_CLI_ENV]: "1", SLATE_USER_NON_ROOT: "1" } as NodeJS.ProcessEnv,
    });
    const home = enabled.find(category => category.name === BOX_HOME_CATEGORY_NAME);
    assert.equal(home?.absRoot, BOX_HOME_DIR);
    assert.equal(home?.relPrefix, BOX_HOME_REL_PREFIX);
    assert.deepEqual(home?.excludes, BOX_HOME_PRUNE_GUARDED_FOREIGN_TREES);
    assert.equal(home?.idleOnly, undefined);
    assert.deepEqual(BOX_HOME_REGENERABLE_JUNK_IGNORE_PATTERNS.includes(".cache/"), true);
  });

  it("builds an enabled sync with the platform root, locks and categories", () => {
    const h = serviceHarness({ env: { SLATE_BOX_STORE_SYNC: "yes", SLATE_MANIFEST_V2: "1" } as NodeJS.ProcessEnv });
    assert.equal(h.service.api.isEnabled, true);
    assert.equal(h.stores.length, 1);
    const options = h.stores[0]?.options;
    assert.equal(options?.manifestV2, true);
    assert.equal(options?.hydrationHandoffMarkerPath, `/box-root/${BOX_STORE_HYDRATION_HANDOFF_FILE_NAME}`);
    assert.equal(options?.lockPath, "/box-root/box-store-sync.lock");
    assert.equal(options?.windowId?.startsWith("slate-host-"), true);
    assert.equal(options?.categories.some(category => category.name === "workspace"), true);
  });

  it("starts the sweep and workers once, and waits for the sweep before a polling cycle", async () => {
    let releaseSweep!: () => void;
    const sweepGate = new Promise<number>(resolve => { releaseSweep = () => resolve(2); });
    const h = serviceHarness({ env: { SLATE_BOX_STORE_SYNC: "1" } as NodeJS.ProcessEnv, sweep: () => sweepGate });
    h.service.start();
    h.service.start();
    await Promise.resolve();
    assert.equal(h.stores[0]?.sweeps, 1);
    assert.equal(h.calls.pollingTicks.length, 1);
    assert.equal(h.calls.watcherStarts, 1);
    const cycle = h.calls.pollingTicks[0]?.();
    await Promise.resolve();
    assert.equal(h.stores[0]?.snapshots.length, 0);
    releaseSweep();
    await cycle;
    assert.equal(h.stores[0]?.snapshots.length, 1);
    assert.equal(h.calls.logs.some(message => /swept 2 leaked/.test(message)), true);
  });

  it("logs a failed startup sweep and still allows the scheduled cycle to run", async () => {
    const h = serviceHarness({ env: { SLATE_BOX_STORE_SYNC: "1" } as NodeJS.ProcessEnv, sweep: async () => { throw new Error("disk unavailable"); } });
    h.service.start();
    await h.calls.pollingTicks[0]?.();
    assert.equal(h.calls.logs.some(message => /temp sweep failed: disk unavailable/.test(message)), true);
    assert.equal(h.stores[0]?.snapshots.length, 1);
  });

  it("skips idle-only categories for an active host and a recent idle host", async () => {
    const active = serviceHarness({ env: { SLATE_BOX_STORE_SYNC: "1" } as NodeJS.ProcessEnv, idle: false });
    await active.service.runCycle();
    assert.deepEqual(active.stores[0]?.snapshots[0], {
      includeIdleOnly: false, includeStoreDbs: false, skipLiveHandleStoreDbs: true, includePacks: false,
    });

    const recentIdle = serviceHarness({ env: { SLATE_BOX_STORE_SYNC: "1" } as NodeJS.ProcessEnv, idle: true });
    await recentIdle.service.runCycle();
    assert.deepEqual(recentIdle.stores[0]?.snapshots[0], {
      includeIdleOnly: false, includeStoreDbs: true, skipLiveHandleStoreDbs: true, includePacks: false,
    });
  });

  it("includes idle categories on schedule and seals a pending hydration handoff while idle", async () => {
    const scheduled = serviceHarness({ env: { SLATE_BOX_STORE_SYNC: "1" } as NodeJS.ProcessEnv, idle: true });
    scheduled.clock.monotonic += BOX_STORE_CHROME_INTERVAL_MS;
    await scheduled.service.runCycle();
    assert.deepEqual(scheduled.stores[0]?.snapshots[0], {
      includeIdleOnly: true, includeStoreDbs: true, skipLiveHandleStoreDbs: true, includePacks: true,
    });

    const handoff = serviceHarness({ env: { SLATE_BOX_STORE_SYNC: "1" } as NodeJS.ProcessEnv, idle: true, handoffPending: true });
    await handoff.service.runCycle();
    assert.deepEqual(handoff.stores[0]?.snapshots[0], {
      includeIdleOnly: true, includeStoreDbs: true, skipLiveHandleStoreDbs: false, includePacks: true,
    });
  });

  it("keeps a pending hydration handoff unsealed while the host is active", async () => {
    const h = serviceHarness({ env: { SLATE_BOX_STORE_SYNC: "1" } as NodeJS.ProcessEnv, idle: false, handoffPending: true });
    await h.service.runCycle();
    assert.deepEqual(h.stores[0]?.snapshots[0], {
      includeIdleOnly: false, includeStoreDbs: false, skipLiveHandleStoreDbs: true, includePacks: false,
    });
  });

  it("refreshes the chrome-session snapshot from the watcher and disposes the watcher", async () => {
    const h = serviceHarness({ env: { SLATE_BOX_STORE_SYNC: "1" } as NodeJS.ProcessEnv });
    h.service.start();
    h.calls.watcherConfigs[0]?.onSessionChange();
    await Promise.resolve();
    assert.deepEqual(h.stores[0]?.snapshots[0], { chromeSessionOnly: true, waitForInFlight: true });
    await h.service.dispose();
    assert.equal(h.calls.watcherStops, 1);
    assert.equal(h.calls.pollingDisposed, 1);
    assert.equal(h.stores[0]?.disposed, 1);
  });

  it("evaluates a flush against store-db, metadata, and chrome-session completeness", async () => {
    const complete = cycleSummary({ categories: [{ name: CHROME_SESSION_CATEGORY_NAME, filesScanned: 1, filesUploaded: 1, bytesUploaded: 4, skippedUnchanged: 0, oversize: 0, failures: 0, metadataFailures: 0, removed: 0 }] });
    const h = serviceHarness({ env: { SLATE_BOX_STORE_SYNC: "1" } as NodeJS.ProcessEnv, summary: complete });
    assert.deepEqual(await h.service.api.snapshotBoxStoreNow({ includeIdleOnly: true }), {
      ok: true, manifestEntries: 2, storeDbEntries: 1, agentDirEntries: 3, storeDbComplete: true, filesUploaded: 4, reason: "",
    });
    assert.deepEqual(h.stores[0]?.snapshots[0], {
      includeIdleOnly: true, includeStoreDbs: true, waitForInFlight: true, acceptMatchingCanonicalOnConflict: true,
    });

    const incomplete = serviceHarness({ env: { SLATE_BOX_STORE_SYNC: "1" } as NodeJS.ProcessEnv, summary: cycleSummary({ metadataFailures: 1 }) });
    assert.equal((await incomplete.service.api.snapshotBoxStoreNow({})).reason, "filesystem-metadata-incomplete");
  });

  it("turns a failed flush into a stable error result and logs the rejected snapshot", async () => {
    const h = serviceHarness({ env: { SLATE_BOX_STORE_SYNC: "1" } as NodeJS.ProcessEnv, snapshotFailure: new Error("conflict") });
    assert.deepEqual(await h.service.api.snapshotBoxStoreNow({}), {
      ok: false, manifestEntries: 0, storeDbEntries: 0, agentDirEntries: 0, storeDbComplete: false, filesUploaded: 0, reason: "error",
    });
    assert.match(h.calls.logs[0] ?? "", /flush snapshot rejected: conflict/);
  });

  it("clears the v2 legacy side first and leaves the new store untouched when that fails", async () => {
    const h = serviceHarness({ env: { SLATE_BOX_STORE_SYNC: "1", [SLATE_BOX_STORE_BACKEND_ENV]: "v2" } as NodeJS.ProcessEnv, objectStoreProvider: { forStore: () => ({}) } });
    h.setClearResults([{ ok: false, reason: "offline" }]);
    assert.deepEqual(await h.service.api.clearBoxStoreNow(), { ok: false, reason: "legacy store clear failed: offline" });
    assert.equal(h.stores.length, 2);
    assert.deepEqual(h.calls.events, ["clear-1", "dispose-1"]);
    assert.equal(h.stores[0]?.clears, 0);
  });

  it("clears the v2 legacy side before the active store when both are reachable", async () => {
    const h = serviceHarness({ env: { SLATE_BOX_STORE_SYNC: "1", [SLATE_BOX_STORE_BACKEND_ENV]: "v2" } as NodeJS.ProcessEnv, objectStoreProvider: { forStore: () => ({}) } });
    h.setClearResults([{ ok: true }, { ok: true }]);
    assert.deepEqual(await h.service.api.clearBoxStoreNow(), { ok: true });
    assert.deepEqual(h.calls.events, ["clear-1", "dispose-1", "clear-0"]);
  });

  it("keeps status, clear, and forget operations available with a disabled store accessor", async () => {
    const h = serviceHarness({ env: { SLATE_BOX_STORE_SYNC: "0" } as NodeJS.ProcessEnv });
    assert.deepEqual(await h.service.api.getBoxStoreStatus(), { storeId: "store-0", enabled: true });
    assert.deepEqual(await h.service.api.clearBoxStoreNow(), { ok: true });
    assert.equal(await h.service.api.forgetAgent("agent-4"), undefined);
    assert.equal(h.stores.length, 1);
    assert.deepEqual(h.stores[0]?.options.categories, []);
    assert.deepEqual(h.stores[0]?.forgotten, ["agent-4"]);
    await h.service.dispose();
    assert.equal(h.stores[0]?.disposed, 1);
  });

  it("forgets agents in the active store and only schedules database snapshots when enabled", async () => {
    const enabled = serviceHarness({ env: { SLATE_BOX_STORE_SYNC: "1" } as NodeJS.ProcessEnv });
    enabled.service.api.scheduleStoreDbSnapshot("agent-1");
    await enabled.service.api.forgetAgent("agent-1");
    assert.deepEqual(enabled.stores[0]?.scheduled, ["agent-1"]);
    assert.deepEqual(enabled.stores[0]?.forgotten, ["agent-1"]);

    const disabled = serviceHarness({ env: { SLATE_BOX_STORE_SYNC: "0" } as NodeJS.ProcessEnv });
    disabled.service.api.scheduleStoreDbSnapshot("agent-2");
    assert.equal(disabled.stores.length, 0);
  });

  it("translates cycle, conflict, and database-capture summaries into telemetry", () => {
    const h = serviceHarness({ env: { SLATE_BOX_STORE_SYNC: "1" } as NodeJS.ProcessEnv });
    const options = h.stores[0]?.options;
    assert.ok(options?.onCycle && options.onManifestWriteConflict && options.onStoreDbCapture);
    options.onCycle(cycleSummary({ categories: [{ name: "workspace", filesScanned: 2, filesUploaded: 2, bytesUploaded: 8, skippedUnchanged: 0, oversize: 0, failures: 0, metadataFailures: 0, removed: 0, excludedFiles: 1, excludedBytes: 9, prunedDirs: 3 }] }));
    options.onCycle(cycleSummary({ ok: false, reason: "in-flight" }));
    options.onManifestWriteConflict({ storeId: "store-2", attempts: 3, accepted: 1, covered: 2, canonicalMatchesAttempt: true, liveViewChanged: false, attemptedEntries: 4, canonicalReadable: true, canonicalEntryCount: 5, canonicalUpdatedAtMs: 6 });
    options.onStoreDbCapture({ trigger: "turn_end", outcome: "uploaded", agentCount: 1, filesScanned: 2, filesUploaded: 3, bytes: 4, durationMs: 5, queueDurationMs: 6, captureDurationMs: 7, blobUploadDurationMs: 8, manifestCommitDurationMs: 9, isCommitted: true });
    assert.equal(h.calls.telemetry.length, 3);
    assert.deepEqual(h.calls.telemetry[0], ["cycle", "info", {
      ok: "true", duration_ms: "12", files_uploaded: "4", bytes_uploaded: "5", manifest_entries: "2", excluded_files: "1", excluded_bytes: "9", pruned_dirs: "3", store_db_entries: "1", store_id: "store-1", failures: "0", workspace_uploaded: "2", workspace_bytes: "8",
    }]);
    assert.equal(h.calls.telemetry[1]?.[0], "conflict");
    assert.deepEqual(h.calls.telemetry[2]?.slice(0, 2), ["capture", "info"]);
  });
});
