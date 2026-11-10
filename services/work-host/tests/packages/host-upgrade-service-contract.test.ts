import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  HostUpgradeService,
  type HostUpgradeServiceDependencies,
} from "../../source/host/extensions/host-upgrade/host-upgrade-service.ts";
import type { HostBundleSource } from "../../source/host/extensions/host-upgrade/host-bundle-source.ts";
import type { HostUpgradeMetadata } from "../../source/host/extensions/host-upgrade/host-upgrade-marker.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function serviceFixture(options: {
  localVersion?: string | null;
  source?: HostBundleSource | undefined;
  noSource?: boolean;
  markerRaw?: string | null;
  autoUpdate?: boolean;
  isInBox?: boolean;
  veto?: boolean;
} = {}) {
  const calls: unknown[] = [];
  const delays: Array<{ ms: number; callback: () => Promise<void>; disposed: boolean }> = [];
  const markerWakes: Array<{ callback: () => Promise<void>; disposed: boolean }> = [];
  const confirmedReports: HostUpgradeMetadata[] = [];
  const upgradeReports: Array<Record<string, string | undefined>> = [];
  const logs: Array<{ level: "info" | "warn"; message: string }> = [];
  const staged: Array<{ version: string; bytes: Uint8Array; forceNow: boolean; reason: string }> = [];
  const defaultSource: HostBundleSource = {
    version: "2.0.0",
    loadBundleBytes: async () => { calls.push("load-bundle"); return new Uint8Array([1, 2, 3]); },
  };
  let localVersion = options.localVersion === undefined ? "1.0.0" : options.localVersion;
  let source = options.noSource === true ? undefined : options.source ?? defaultSource;
  let markerRaw = options.markerRaw ?? null;
  let veto = options.veto ?? false;
  let nowMs = 5_000;
  let confirmed = true;
  let stageError: unknown;
  let sourceLoadError: unknown;
  let delayStarts = 0;
  let markerWakeStarts = 0;
  let clockReads = 0;
  const dependencies: HostUpgradeServiceDependencies = {
    automations: { suspendWakes: async () => { calls.push("suspend-wakes"); } },
    sharing: { prepareForUpgrade: () => { calls.push("prepare-sharing"); } },
    transcript: {
      quiesceForUpgrade: async () => { calls.push("quiesce-transcript"); return "quiesced"; },
      resumeInterruptedUpgradeTurns: async () => { calls.push("resume-turns"); },
    },
    telemetry: {
      reportHostUpgrade: (metadata) => { upgradeReports.push(metadata); },
      reportHostUpgradeConfirmed: async (metadata) => { confirmedReports.push(metadata); return confirmed; },
    },
    markerStore: {
      readRaw: async () => markerRaw,
      deleteMarker: async () => { calls.push("delete-marker"); markerRaw = null; },
    },
    markerForwardPolicy: {
      start: (callback) => {
        markerWakeStarts += 1;
        const handle = { callback, disposed: false };
        markerWakes.push(handle);
        return { dispose: () => { handle.disposed = true; } };
      },
    },
    createUpdateWatchDelayPolicy: (ms) => ({
      name: `delay-${ms}`,
      start: (callback) => {
        delayStarts += 1;
        const handle = { ms, callback, disposed: false };
        delays.push(handle);
        return { dispose: () => { handle.disposed = true; } };
      },
    }),
    clock: { now: () => { clockReads += 1; return nowMs; } },
    random: () => 0.5,
    isInBox: options.isInBox ?? false,
    isAutoUpdateEnabled: options.autoUpdate ?? true,
    updateWatchIntervalMs: 100,
    updateWatchJitterRatio: 0.5,
    resolveBundleSource: async () => { calls.push("resolve-source"); return source; },
    readLocalVersion: async () => { calls.push("read-version"); return localVersion; },
    isVersionSwapVetoed: async (input) => { calls.push(["check-veto", input]); return veto; },
    stageUpgrade: async (input) => {
      calls.push("stage-upgrade");
      staged.push(input);
      if (stageError !== undefined) throw stageError;
    },
    log: (level, message) => { logs.push({ level, message }); },
  };
  const service = new HostUpgradeService(dependencies);
  return {
    service,
    calls,
    delays,
    markerWakes,
    confirmedReports,
    upgradeReports,
    logs,
    staged,
    setLocalVersion(value: string | null) { localVersion = value; },
    setSource(value: HostBundleSource | undefined) { source = value; },
    setMarkerRaw(value: string | null) { markerRaw = value; },
    setVeto(value: boolean) { veto = value; },
    setConfirmed(value: boolean) { confirmed = value; },
    setStageError(value: unknown) { stageError = value; },
    setSourceLoadError(value: unknown) {
      sourceLoadError = value;
      if (source !== undefined) source = { ...source, loadBundleBytes: async () => { throw sourceLoadError; } };
    },
    setNow(value: number) { nowMs = value; },
    markerWakeStarts: () => markerWakeStarts,
    delayStarts: () => delayStarts,
    clockReads: () => clockReads,
  };
}

const marker = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  outcome: "applied", fromVersion: "1.0.0", toVersion: "2.0.0", mode: "bundle", reason: "idle",
  issuedAtMs: 1_000, appliedAtMs: 1_200, swapMs: 100, ...overrides,
});

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("the host upgrade service", () => {
  it("resolves the on-disk identity and remembers the last known version", async () => {
    const fixture = serviceFixture({ localVersion: null });
    assert.equal(await fixture.service.resolveHostBundleIdentityVersion("fallback"), "fallback");
    fixture.setLocalVersion("1.2.3");
    assert.equal(await fixture.service.resolveHostBundleIdentityVersion(), "1.2.3");
    fixture.setLocalVersion(null);
    assert.equal(await fixture.service.resolveHostBundleIdentityVersion("later-fallback"), "1.2.3");
    assert.equal(fixture.calls.filter((call) => call === "read-version").length, 3);
  });

  it("returns a stable empty version state until update data is known", () => {
    const fixture = serviceFixture({ localVersion: null, source: undefined });
    assert.deepEqual(fixture.service.getVersionState(), {
      hostVersion: null, latestHostVersion: null, hostUpdateAvailable: null,
    });
  });

  it("returns distinct reasons when no bundle exists or the host already has it", async () => {
    const noSource = serviceFixture({ noSource: true });
    assert.deepEqual(await noSource.service.updateHostNow(), { started: false, reason: "no-bundle-source" });
    assert.equal(noSource.calls.includes("read-version"), false);

    const current = serviceFixture({ localVersion: "2.0.0" });
    assert.deepEqual(await current.service.updateHostNow(), {
      started: false, reason: "already-latest", version: "2.0.0",
    });
    assert.equal(current.staged.length, 0);
  });

  it("honors a version-swap veto before fetching or staging", async () => {
    const fixture = serviceFixture({ veto: true });
    assert.deepEqual(await fixture.service.updateHostNow(), {
      started: false, reason: "host-version-rolled-back", version: "2.0.0",
    });
    assert.equal(fixture.calls.includes("load-bundle"), false);
    assert.equal(fixture.staged.length, 0);
  });

  it("stages a manual update with its default force flag and trigger", async () => {
    const fixture = serviceFixture();
    assert.deepEqual(await fixture.service.updateHostNow(), { started: true, version: "2.0.0" });
    assert.deepEqual(fixture.staged, [{
      version: "2.0.0", bytes: new Uint8Array([1, 2, 3]), forceNow: true, reason: "manual-update-host",
    }]);
    assert.deepEqual(fixture.service.getVersionState(), {
      hostVersion: "1.0.0", latestHostVersion: "2.0.0", hostUpdateAvailable: true,
    });
  });

  it("allows an idle manual update without forcing the supervisor swap", async () => {
    const fixture = serviceFixture();
    assert.deepEqual(await fixture.service.updateHostNow({ force: false }), { started: true, version: "2.0.0" });
    assert.deepEqual(fixture.staged[0], {
      version: "2.0.0", bytes: new Uint8Array([1, 2, 3]), forceNow: false, reason: "manual-update-host-idle",
    });
  });

  it("allows only one bundle stage while an update is already in flight", async () => {
    const fixture = serviceFixture();
    const loadStarted = deferred<void>();
    const bundle = deferred<Uint8Array>();
    fixture.setSource({
      version: "2.0.0",
      loadBundleBytes: async () => { loadStarted.resolve(); return bundle.promise; },
    });

    const firstUpdate = fixture.service.updateHostNow();
    await loadStarted.promise;
    const duplicateUpdate = fixture.service.updateHostNow();
    bundle.resolve(new Uint8Array([4, 5]));
    const [first, duplicate] = await Promise.all([firstUpdate, duplicateUpdate]);
    assert.deepEqual(duplicate, { started: false, reason: "Error: host bundle update already in flight" });
    assert.deepEqual(first, { started: true, version: "2.0.0" });
    assert.equal(fixture.staged.length, 1);
  });

  it("keeps fetch errors terse unless development detail is explicitly enabled", async () => {
    const previous = process.env.SLATE_HOST_DEV_ERROR_DETAIL;
    const fixture = serviceFixture();
    fixture.setSourceLoadError(new Error("download failed", { cause: new Error("network offline") }));
    try {
      delete process.env.SLATE_HOST_DEV_ERROR_DETAIL;
      assert.deepEqual(await fixture.service.updateHostNow({ includeErrorDetail: true }), {
        started: false, reason: "Error: download failed",
      });
      process.env.SLATE_HOST_DEV_ERROR_DETAIL = "1";
      assert.deepEqual(await fixture.service.updateHostNow({ includeErrorDetail: true }), {
        started: false, reason: "@phase:fetch Error: download failed → Error: network offline",
      });
      assert.equal(fixture.upgradeReports.length, 1, "only the first failure of a version is reported");
      assert.equal(fixture.upgradeReports[0]?.phase, "fetch");
    } finally {
      if (previous === undefined) delete process.env.SLATE_HOST_DEV_ERROR_DETAIL;
      else process.env.SLATE_HOST_DEV_ERROR_DETAIL = previous;
    }
  });

  it("sequences wake suspension, sharing preparation, and transcript quiescence", async () => {
    const fixture = serviceFixture();
    assert.equal(await fixture.service.prepareForUpgrade(), "quiesced");
    assert.deepEqual(fixture.calls.slice(0, 3), ["suspend-wakes", "prepare-sharing", "quiesce-transcript"]);
    await fixture.service.resumeInterruptedUpgradeTurns();
    assert.equal(fixture.calls.at(-1), "resume-turns");
  });

  it("starts marker forwarding once and waits until host identity is ready", async () => {
    const fixture = serviceFixture({ markerRaw: marker() });
    fixture.service.startMarkerForwardWake();
    fixture.service.startMarkerForwardWake();
    assert.equal(fixture.markerWakeStarts(), 1);
    await fixture.markerWakes[0]!.callback();
    assert.equal(fixture.confirmedReports.length, 0);
    assert.equal(fixture.calls.includes("delete-marker"), false);

    fixture.service.activateAfterHostIdentityReady();
    fixture.service.activateAfterHostIdentityReady();
    await nextTurn();
    assert.equal(fixture.confirmedReports.length, 1);
    assert.equal(fixture.calls.includes("delete-marker"), true);
    await fixture.markerWakes[0]!.callback();
    assert.equal(fixture.confirmedReports.length, 1, "the same marker is forwarded once");
  });

  it("does not delete a marker when telemetry defers it, then forwards it on retry", async () => {
    const fixture = serviceFixture({ markerRaw: marker() });
    fixture.setConfirmed(false);
    assert.equal(await fixture.service.forwardHostUpgradeMarker(), "deferred");
    assert.equal(fixture.calls.includes("delete-marker"), false);
    fixture.setConfirmed(true);
    assert.equal(await fixture.service.forwardHostUpgradeMarker(), "emitted");
    assert.equal(fixture.calls.filter((call) => call === "delete-marker").length, 1);
  });

  it("allows only one in-flight marker delivery and reuses its timestamp", async () => {
    const fixture = serviceFixture({ markerRaw: marker() });
    const pending = deferred<boolean>();
    const original = fixture.service.deps.telemetry.reportHostUpgradeConfirmed;
    fixture.service.deps.telemetry.reportHostUpgradeConfirmed = async (metadata) => {
      fixture.confirmedReports.push(metadata);
      return pending.promise;
    };
    const first = fixture.service.forwardHostUpgradeMarker();
    await nextTurn();
    const second = fixture.service.forwardHostUpgradeMarker();
    await nextTurn();
    assert.equal(fixture.confirmedReports.length, 1);
    fixture.setNow(9_000);
    pending.resolve(true);
    assert.equal(await first, "emitted");
    assert.equal(await second, undefined);
    assert.equal(fixture.clockReads(), 1);
    fixture.service.deps.telemetry.reportHostUpgradeConfirmed = original;
  });

  it("starts a shared update watch only once and honors its enable gates", async () => {
    const disabled = serviceFixture({ autoUpdate: false, isInBox: false });
    disabled.service.startSharedUpdateWatch({ isBoxAutoUpdateEnabled: false, runRootUpdateTick: async () => {} });
    disabled.service.startSharedUpdateWatch({ isBoxAutoUpdateEnabled: true, runRootUpdateTick: async () => {} });
    await nextTurn();
    assert.equal(disabled.delayStarts(), 0);

    const inBox = serviceFixture({ autoUpdate: false, isInBox: true });
    inBox.service.startSharedUpdateWatch({ isBoxAutoUpdateEnabled: false, runRootUpdateTick: async () => {} });
    assert.equal(inBox.delayStarts(), 1);
  });

  it("primes the initial watch delay, runs root checks before auto staging, and rearms", async () => {
    const fixture = serviceFixture();
    fixture.service.startSharedUpdateWatch({
      isBoxAutoUpdateEnabled: false,
      runRootUpdateTick: async () => { fixture.calls.push("root-update-tick"); },
    });
    await nextTurn();
    assert.equal(fixture.delays[0]?.ms, 50);
    await fixture.delays[0]!.callback();
    assert.equal(fixture.calls.includes("root-update-tick"), false, "the first polling callback only primes the delay");
    await fixture.delays[0]!.callback();
    assert.equal(fixture.calls.indexOf("root-update-tick") < fixture.calls.indexOf("load-bundle"), true);
    assert.equal(fixture.staged[0]?.forceNow, false);
    assert.equal(fixture.delays[0]?.disposed, true);
    assert.equal(fixture.delays[1]?.ms, 100);
  });

  it("logs a failed watch pass and still schedules its next check", async () => {
    const fixture = serviceFixture();
    fixture.service.startSharedUpdateWatch({
      isBoxAutoUpdateEnabled: true,
      runRootUpdateTick: async () => { throw new Error("root scan failed"); },
    });
    await nextTurn();
    await fixture.delays[0]!.callback();
    await fixture.delays[0]!.callback();
    assert.equal(fixture.logs.some(({ level, message }) => level === "warn" && message.includes("root scan failed")), true);
    assert.equal(fixture.delays.length, 2);
  });

  it("does not stage an already staged or vetoed automatic version", async () => {
    const staged = serviceFixture();
    staged.service.updateState.stagedVersion = "2.0.0";
    staged.service.startSharedUpdateWatch({ isBoxAutoUpdateEnabled: true, runRootUpdateTick: async () => {} });
    await nextTurn();
    await staged.delays[0]!.callback();
    await staged.delays[0]!.callback();
    assert.equal(staged.staged.length, 0);

    const vetoed = serviceFixture({ veto: true });
    vetoed.service.startSharedUpdateWatch({ isBoxAutoUpdateEnabled: true, runRootUpdateTick: async () => {} });
    await nextTurn();
    await vetoed.delays[0]!.callback();
    await vetoed.delays[0]!.callback();
    assert.equal(vetoed.staged.length, 0);
  });

  it("does not auto stage when only the box watch is enabled", async () => {
    const fixture = serviceFixture({ autoUpdate: false });
    fixture.service.startSharedUpdateWatch({ isBoxAutoUpdateEnabled: true, runRootUpdateTick: async () => {} });
    await nextTurn();
    await fixture.delays[0]!.callback();
    await fixture.delays[0]!.callback();
    assert.equal(fixture.staged.length, 0);
    fixture.service.dispose();
  });

  it("disposes the marker wake and pending update delay without rearming", async () => {
    const fixture = serviceFixture();
    fixture.service.startMarkerForwardWake();
    fixture.service.startSharedUpdateWatch({ isBoxAutoUpdateEnabled: true, runRootUpdateTick: async () => {} });
    await nextTurn();
    fixture.service.dispose();
    fixture.service.dispose();
    assert.equal(fixture.markerWakes[0]?.disposed, true);
    assert.equal(fixture.delays[0]?.disposed, true);
  });
});
