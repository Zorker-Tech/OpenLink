import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createContext } from "../../source/packages/context/context.ts";
import { DeadlineExceededError } from "../../source/host/extensions/scheduling.ts";
import {
  FOREVER_BOX_IMAGE_CHECK_TIMEOUT_MS,
  FOREVER_BOX_IMAGE_WATCH_INTERVAL_MS,
  FOREVER_BOX_MIGRATION_TTL_MS,
  FOREVER_BOX_RECREATE_FLUSH_WAIT_MS,
  FOREVER_BOX_SCREENSHOT_TIMEOUT_MS,
  RECREATE_UNAVAILABLE_MESSAGE,
  ForeverBoxService,
  SlateForeverBoxError,
  type ForeverBoxOptions,
} from "../../source/host/boxes/forever-box/forever-box-service.ts";

function serviceHarness(options: {
  inBox?: boolean;
  autoUpdate?: boolean;
  hostBundleAutoUpdate?: boolean;
  busy?: boolean;
  available?: boolean | undefined;
  boxRunning?: boolean;
  runningAgentId?: string;
  updateResult?: { started: boolean; reason?: string };
  updateError?: Error;
  fetchError?: Error;
  fetchResult?: boolean | undefined;
  fetchGate?: Promise<boolean | undefined>;
  flushError?: Error;
  deadlineErrors?: Partial<Record<string, Error>>;
  screenshot?: Uint8Array | null;
  screenshotError?: Error;
  delay?: Promise<void>;
  now?: number;
} = {}) {
  const calls = {
    statusReads: [] as string[],
    ensured: [] as string[],
    released: [] as string[],
    imageStates: [] as Array<boolean | undefined>,
    recreate: [] as Array<{ preserveData: boolean; force?: boolean }>,
    fetch: [] as Array<{ signal: AbortSignal; result?: boolean | undefined }>,
    deadlines: [] as string[],
    retries: 0,
    pollingStarts: 0,
    pollingStops: 0,
    delaySchedules: 0,
    delayDisposals: 0,
    expiryArms: 0,
    expiryDisposals: 0,
    trays: [] as Array<{ agentId: string; title: string; detail: string }>,
    recreateDecisions: [] as Array<Record<string, string>>,
    imageReports: [] as Array<Record<string, unknown>>,
    logs: [] as string[],
    flushes: 0,
    unsubscribe: 0,
    imageTick: undefined as (() => Promise<void>) | undefined,
    imageSignal: undefined as AbortSignal | undefined,
    expiry: undefined as (() => void) | undefined,
  };
  let currentTime = options.now ?? 100;
  let currentImageAvailable = options.available;
  let updateError = options.updateError;
  let updateResult = options.updateResult;
  let fetchResult = options.fetchResult;
  let boxStatus: Record<string, unknown> = { agentId: "agent-1", state: "running", vncUrl: "http://127.0.0.1:6080/vnc.html", pull: { percent: 50 }, imageUpdateAvailable: options.available };
  let boxStatusListener: ((status: Record<string, unknown>) => void) | undefined;
  const box = {
    subscribe(listener: (status: Record<string, unknown>) => void) { boxStatusListener = listener; return () => { calls.unsubscribe += 1; }; },
    async getStatus(_ctx: unknown, id: string) { calls.statusReads.push(id); return boxStatus; },
    async ensure(_ctx: unknown, id: string) { calls.ensured.push(id); return boxStatus; },
    async releaseWindow(_ctx: unknown, agentId: string) { calls.released.push(agentId); },
    recordImageUpdateAvailable(value: boolean | undefined) { currentImageAvailable = value; calls.imageStates.push(value); boxStatus = { ...boxStatus, imageUpdateAvailable: value }; },
    async isBoxRunning() { return options.boxRunning ?? true; },
    async listBoxes() { return [{ agentId: options.runningAgentId ?? "agent-1", running: true }]; },
    getImageUpdateAvailable() { return currentImageAvailable; },
    async ensureReady() { return { remoteAccessor: {}, vncUrl: "vnc", terminalsFolder: "terminals" }; },
  };
  const deadline = (name: string) => ({
    name,
    async run<T>(work: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
      calls.deadlines.push(name);
      if (signal?.aborted) throw signal.reason;
      const error = options.deadlineErrors?.[name];
      if (error !== undefined) throw error;
      return work(signal ?? new AbortController().signal);
    },
  });
  const expiration = {
    name: "migration",
    arm(_key: string, callback: () => void) {
      calls.expiryArms += 1;
      calls.expiry = callback;
      return { dispose() { calls.expiryDisposals += 1; } };
    },
  };
  const optionsValue: ForeverBoxOptions = {
    box: box as never,
    lifecycleClient: {
      async recreateInBox(request) {
        calls.recreate.push(request);
        if (updateError !== undefined) throw updateError;
        return updateResult ?? { started: true };
      },
      async fetchImageUpdateAvailable(signal) {
        calls.fetch.push({ signal, result: fetchResult ?? options.available });
        if (options.fetchError !== undefined) throw options.fetchError;
        if (options.fetchGate !== undefined) return options.fetchGate;
        return fetchResult ?? options.available;
      },
    },
    trays: { pushError: value => calls.trays.push(value) },
    telemetry: {
      reportBoxRecreateDecided: value => calls.recreateDecisions.push(value),
      reportBoxImageCheck: value => calls.imageReports.push(value),
    },
    imagePolling: {
      name: "image-poll",
      start(tick: () => Promise<void>, signal?: AbortSignal) {
        calls.pollingStarts += 1;
        calls.imageTick = tick;
        calls.imageSignal = signal;
        return { dispose() { calls.pollingStops += 1; } };
      },
    } as never,
    imagePollingStartDelay: {
      name: "image-poll-start",
      schedule() {
        calls.delaySchedules += 1;
        return { elapsed: options.delay ?? Promise.resolve(), dispose() { calls.delayDisposals += 1; } };
      },
    } as never,
    imageSeedRetry: {
      name: "image-seed",
      async runWithRetry(work: (attempt: number, signal: AbortSignal) => Promise<unknown>, signal?: AbortSignal) {
        calls.retries += 1;
        return work(1, signal ?? new AbortController().signal);
      },
    } as never,
    imageCheckDeadline: deadline("image-check"),
    migrationExpiry: expiration as never,
    screenshotDeadline: deadline("screenshot"),
    recreateFlushWaitDeadline: deadline("flush"),
    async flushPendingUploads() {
      calls.flushes += 1;
      if (options.flushError !== undefined) throw options.flushError;
    },
    autoUpdateEnabled: options.autoUpdate ?? false,
    hostBundleAutoUpdateEnabled: options.hostBundleAutoUpdate ?? false,
    isInBox: () => options.inBox ?? true,
    log: message => calls.logs.push(message),
    ...(options.screenshot === undefined && options.screenshotError === undefined ? {} : {
      async captureScreenshot() {
        if (options.screenshotError !== undefined) throw options.screenshotError;
        return options.screenshot ?? null;
      },
    }),
    ctx: createContext().withName("forever-box-test"),
    now: () => currentTime,
  };
  const service = new ForeverBoxService(optionsValue);
  if (options.busy === true) service.setBusy(true);
  return {
    service,
    calls,
    setNow(value: number) { currentTime = value; },
    setStatus(value: Record<string, unknown>) { boxStatus = value; boxStatusListener?.(value); },
    setUpdateError(value: Error | undefined) { updateError = value; },
    setUpdateResult(value: { started: boolean; reason?: string } | undefined) { updateResult = value; },
    currentImageAvailable: () => currentImageAvailable,
  };
}

function settle(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

function pollImage(service: ForeverBoxService): Promise<void> {
  return (service as unknown as { watchForImageUpdate(): Promise<void> }).watchForImageUpdate();
}

describe("forever box service contract", () => {
  it("publishes stable timeout and image-watch values", () => {
    assert.equal(FOREVER_BOX_MIGRATION_TTL_MS, 5 * 60_000);
    assert.equal(FOREVER_BOX_SCREENSHOT_TIMEOUT_MS, 5_000);
    assert.equal(FOREVER_BOX_RECREATE_FLUSH_WAIT_MS, 10_000);
    assert.equal(FOREVER_BOX_IMAGE_WATCH_INTERVAL_MS, 24 * 60 * 60_000);
    assert.equal(FOREVER_BOX_IMAGE_CHECK_TIMEOUT_MS, 30_000);
    assert.equal(RECREATE_UNAVAILABLE_MESSAGE.includes("unchanged"), true);
  });

  it("delegates status and ensure, decorates migration state, and emits box status updates", async () => {
    const h = serviceHarness();
    const seen: unknown[] = [];
    h.service.subscribe(status => seen.push(status));
    assert.equal((await h.service.getStatus({ id: "agent-a" })).agentId, "agent-1");
    const ensured = await h.service.ensure({ id: "agent-b" });
    assert.equal(ensured.agentId, "agent-1");
    assert.deepEqual(h.calls.statusReads, ["agent-a"]);
    assert.deepEqual(h.calls.ensured, ["agent-b"]);
    h.service.setMigrating({ migrating: true });
    h.setStatus({ agentId: "agent-c", state: "pulling", vncUrl: "vnc", pull: { percent: 70 } });
    assert.deepEqual(seen.at(-1), { agentId: "agent-c", state: "pulling", vncUrl: null, pull: { percent: 0 } });
    h.service.setMigrating({ migrating: false });
    assert.equal(h.calls.expiryArms, 1);
    assert.equal(h.calls.expiryDisposals, 1);
  });

  it("expires a migration veil and restores the underlying box status", async () => {
    const h = serviceHarness();
    h.service.setMigrating({ migrating: true });
    h.calls.expiry?.();
    const status = await h.service.getStatus({ id: "agent-1" });
    assert.equal(status.vncUrl, "http://127.0.0.1:6080/vnc.html");
    assert.deepEqual(status.pull, { percent: 50 });
  });

  it("recreates a computer after flushing uploads and maps service errors to the public failure", async () => {
    const reset = serviceHarness({ updateResult: { started: true } });
    assert.deepEqual(await reset.service.reset({ id: "agent-a" }), { agentId: "agent-a", state: "running", vncUrl: null, pull: { percent: 0 } });
    assert.deepEqual(reset.calls.recreate, [{ preserveData: false }]);
    assert.deepEqual(reset.calls.deadlines, ["flush"]);
    assert.equal(reset.calls.flushes, 1);

    const failed = serviceHarness({ updateError: new Error("wire down") });
    await assert.rejects(failed.service.update({ id: "agent-a" }), error => {
      assert.ok(error instanceof SlateForeverBoxError);
      assert.equal(error.message, RECREATE_UNAVAILABLE_MESSAGE);
      assert.equal((error as Error & { cause?: Error }).cause?.message, "wire down");
      return true;
    });
  });

  it("reports a declined recreate with its reason and distinguishes reset from update", async () => {
    const h = serviceHarness({ updateResult: { started: false, reason: "busy" } });
    await assert.rejects(h.service.update({ id: "agent-a" }), error => error instanceof SlateForeverBoxError && /Couldn't update the computer \(busy\)/.test(error.message));
    await assert.rejects(h.service.reset({ id: "agent-a" }), error => error instanceof SlateForeverBoxError && /Couldn't reset the computer \(busy\)/.test(error.message));
    assert.deepEqual(h.calls.recreate, [{ preserveData: true }, { preserveData: false }]);
  });

  it("continues a recreate when upload flushing fails, but propagates cancellation", async () => {
    const h = serviceHarness({ flushError: new Error("upload failed") });
    assert.equal((await h.service.update({ id: "agent-a" })).state, "running");
    assert.match(h.calls.logs[0] ?? "", /snapshot upload flush failed/);
    assert.equal(h.calls.recreate.length, 1);
  });

  it("returns each refusal reason before attempting an image refresh", async () => {
    assert.deepEqual(await serviceHarness({ inBox: false, autoUpdate: true }).service.autoUpdateNow(), { started: false, reason: "not-in-box" });
    assert.deepEqual(await serviceHarness({ autoUpdate: false }).service.autoUpdateNow(), { started: false, reason: "auto-update-disabled" });
    assert.deepEqual(await serviceHarness({ autoUpdate: true, busy: true }).service.autoUpdateNow(), { started: false, reason: "busy" });
    let releaseFetch!: (value: boolean) => void;
    const pendingFetch = new Promise<boolean>(resolve => { releaseFetch = resolve; });
    const inFlight = serviceHarness({ autoUpdate: true, fetchGate: pendingFetch });
    const firstUpdate = inFlight.service.autoUpdateNow();
    await settle();
    assert.deepEqual(await inFlight.service.autoUpdateNow(), { started: false, reason: "update-in-flight" });
    assert.equal(inFlight.calls.fetch.length, 1);
    releaseFetch(false);
    assert.deepEqual(await firstUpdate, { started: false, reason: "no-update-required" });
  });

  it("requires a successful freshness check and a real update before recreating", async () => {
    const failed = serviceHarness({ inBox: true, autoUpdate: true, fetchError: new Error("offline") });
    assert.deepEqual(await failed.service.autoUpdateNow(), { started: false, reason: "staleness-check-failed" });
    assert.equal(failed.calls.recreate.length, 0);

    const none = serviceHarness({ autoUpdate: true, fetchResult: false });
    assert.deepEqual(await none.service.autoUpdateNow(), { started: false, reason: "no-update-required" });
    assert.equal(none.calls.recreateDecisions.length, 0);

    const update = serviceHarness({ autoUpdate: true, fetchResult: true });
    assert.deepEqual(await update.service.autoUpdateNow(), { started: true });
    assert.deepEqual(update.calls.recreate, [{ preserveData: true }]);
    assert.deepEqual(update.calls.recreateDecisions, [{ trigger: "hibernation_auto_update", mode: "pod_recreate", preserved: "true" }]);
  });

  it("refreshes image availability with coalescing, deadlines and non-negative durations", async () => {
    const h = serviceHarness({ fetchResult: true, now: 10 });
    h.setNow(7);
    assert.deepEqual(await h.service.refreshImageUpdateAvailable("manual"), { outcome: "answered", available: true });
    assert.deepEqual(h.calls.imageStates, [true]);
    assert.deepEqual(h.calls.imageReports[0], { trigger: "manual", outcome: "answered", durationMs: 0 });
    assert.deepEqual(await serviceHarness({ inBox: false }).service.refreshImageUpdateAvailable("manual"), { outcome: "skipped" });
    const timedOut = serviceHarness({ autoUpdate: true, deadlineErrors: { "image-check": new Error("deadline exceeded") } });
    assert.equal((await timedOut.service.refreshImageUpdateAvailable("poll")).outcome, "failed");
  });

  it("coalesces overlapping freshness checks while allowing an explicit non-coalesced check", async () => {
    let releaseFetch!: (value: boolean) => void;
    const gate = new Promise<boolean>(resolve => { releaseFetch = resolve; });
    const h = serviceHarness({ fetchGate: gate });
    const first = h.service.refreshImageUpdateAvailable("poll");
    await settle();
    assert.deepEqual(await h.service.refreshImageUpdateAvailable("poll-again"), { outcome: "skipped" });
    assert.equal(h.calls.fetch.length, 1);
    releaseFetch(true);
    assert.deepEqual(await first, { outcome: "answered", available: true });
  });

  it("classifies deadline timeout and cancellation when checking image availability", async () => {
    const timedOut = serviceHarness({ deadlineErrors: { "image-check": new DeadlineExceededError("image-check") } });
    assert.equal((await timedOut.service.refreshImageUpdateAvailable("poll")).outcome, "timeout");
    const h = serviceHarness();
    h.service.dispose();
    assert.equal((await h.service.refreshImageUpdateAvailable("poll")).outcome, "skipped");
  });

  it("starts the seed check and schedules polling only after the delayed start", async () => {
    let release!: () => void;
    const delay = new Promise<void>(resolve => { release = resolve; });
    const h = serviceHarness({ inBox: true, fetchResult: false, delay });
    h.service.start();
    await Promise.resolve();
    assert.equal(h.calls.retries, 1);
    assert.equal(h.calls.fetch.length, 1);
    assert.equal(h.calls.delaySchedules, 1);
    assert.equal(h.calls.pollingStarts, 0);
    release();
    await settle();
    assert.equal(h.calls.pollingStarts, 1);
    await h.service.dispose();
  });

  it("does not start polling after disposal while the start delay is still pending", async () => {
    let release!: () => void;
    const delay = new Promise<void>(resolve => { release = resolve; });
    const h = serviceHarness({ inBox: false, delay });
    h.service.start();
    h.service.dispose();
    release();
    await settle();
    assert.equal(h.calls.pollingStarts, 0);
    assert.equal(h.calls.delayDisposals, 1);
  });

  it("hands screenshots through the deadline and returns null for missing or failed capture", async () => {
    assert.equal(await serviceHarness().service.captureScreenshot("agent-a"), null);
    const capture = serviceHarness({ screenshot: new Uint8Array([1, 2]) });
    assert.deepEqual(await capture.service.captureScreenshot("agent-a"), new Uint8Array([1, 2]));
    assert.deepEqual(capture.calls.deadlines, ["screenshot"]);
    assert.equal(await serviceHarness({ screenshotError: new Error("unavailable") }).service.captureScreenshot("agent-a"), null);
  });

  it("releases an agent's desktop window through the box port", async () => {
    const h = serviceHarness();
    await h.service.releaseAgent("agent-9");
    assert.deepEqual(h.calls.released, ["agent-9"]);
  });

  it("watches for an image change and auto-updates only when the box is eligible", async () => {
    const h = serviceHarness({ autoUpdate: true, fetchResult: true, runningAgentId: "agent-live" });
    await pollImage(h.service);
    assert.equal(h.calls.fetch.length, 1);
    assert.deepEqual(h.calls.recreate, [{ preserveData: true }]);
    const busy = serviceHarness({ autoUpdate: true, fetchResult: true, busy: true });
    await pollImage(busy.service);
    assert.equal(busy.calls.recreate.length, 0);
    const noBox = serviceHarness({ autoUpdate: true, fetchResult: true, boxRunning: false });
    await pollImage(noBox.service);
    assert.equal(noBox.calls.recreate.length, 0);
  });

  it("reports only one tray error across repeated failed automatic updates and resets after success", async () => {
    const h = serviceHarness({ autoUpdate: true, fetchResult: true, updateError: new Error("recreate failed") });
    await pollImage(h.service);
    await pollImage(h.service);
    assert.equal(h.calls.trays.length, 1);
    assert.equal(h.calls.trays[0]?.agentId, "agent-1");
    assert.match(h.calls.logs[0] ?? "", /computer stays on its current image/);

    h.setUpdateError(undefined);
    h.setUpdateResult({ started: true });
    await pollImage(h.service);
    assert.equal(h.calls.trays.length, 1);
    h.setUpdateError(new Error("recreate failed again"));
    await pollImage(h.service);
    assert.equal(h.calls.trays.length, 2);
  });

  it("disposes polling, pending startup delay, migration expiry, and box subscription once", async () => {
    const h = serviceHarness({ inBox: false });
    h.service.start();
    await settle();
    h.service.setMigrating({ migrating: true });
    h.service.dispose();
    h.service.dispose();
    assert.equal(h.calls.pollingStops, 1);
    assert.equal(h.calls.delayDisposals, 1);
    assert.equal(h.calls.expiryDisposals, 1);
    assert.equal(h.calls.unsubscribe, 1);
  });
});
