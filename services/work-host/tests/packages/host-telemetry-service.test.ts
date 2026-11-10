/**
 * The telemetry a host keeps for itself: the renewal reports, the console forwarding, what starting and stopping it
 * turns on and off, the box's log shipping, the message-sent event, the crash marker, the fatal flush and the
 * desktop-health heartbeat.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

import { BoxLogShipper } from "../../source/host/telemetry/box-log-shipper.ts";
import type { HostCrashMarkerRead, HostCrashMarkerStore } from "../../source/host/telemetry/host-crash-marker.ts";
import { HostTelemetryService, NoopProductAnalytics, PRESSURE_PROFILER_CONFIG_NAME, PRESSURE_PROFILER_FEATURE_GATE, SLATE_SUPERVISOR_DESKTOP_HEALTH_PATH, subscribeToCredentialRenewalTelemetry, SUPERVISOR_LOG_PATH, type ProductAnalytics, type Renewal } from "../../source/host/telemetry/host-telemetry-service.ts";
import type { LogLevel, SlateStructuredLogTelemetry } from "../../source/host/telemetry/structured-log-telemetry.ts";
import { slateMessageLengthBucket } from "../../source/host/ports/slate-analytics-types.ts";

type ShipperDeps = ConstructorParameters<typeof BoxLogShipper>[0];
const tick = () => new Promise((resolve) => setImmediate(resolve));
const RENEWAL_FAILED = { outcome: "failed", consecutiveFailures: 3, durationMs: 120, errorSummary: "the backend refused" };
const HEALTH_ONE_DOWN = JSON.stringify({ revision: 7, updatedAtMs: 1_000, supervisionEnabled: true, components: [{ name: "shared/xvfb", up: false, crashloop: false, restartsInWindow: 2, downReason: "oom" }] });
const HEALTH_ALL_UP = JSON.stringify({ revision: 8, updatedAtMs: 2_000, supervisionEnabled: true, components: [{ name: "shared/xvfb", up: true, crashloop: false, restartsInWindow: 0 }] });

/** A host log that writes down what it was asked to report, and nothing else. */
function fakeLogs() {
  const renewals: { level: LogLevel; metadata: Record<string, unknown> }[] = [];
  const hostLogs: { level: LogLevel; line: string }[] = [];
  const desktopHealth: { level: LogLevel; metadata: Record<string, unknown> }[] = [];
  const eventLoop: unknown[] = [];
  const identity: unknown[] = [];
  const exitConfirmed: unknown[] = [];
  const lifecycle: unknown[] = [];
  const boxBatches: unknown[] = [];
  const boxShips: unknown[] = [];
  let echoHostLog = false;
  let tickListener: (() => void) | undefined;
  let disposed = 0;
  return {
    logs: {
      reportInferenceCredentialRenewal: (level: LogLevel, metadata: Record<string, unknown>) => void renewals.push({ level, metadata }),
      reportHostLog: (level: LogLevel, line: string) => {
        hostLogs.push({ level, line });
        // A transport that writes back to the console would come back here forever without the guard.
        if (echoHostLog) console.log(`[rather-a-transport] ${line}`);
      },
      reportDesktopHealth: (level: LogLevel, metadata: Record<string, unknown>) => void desktopHealth.push({ level, metadata }),
      reportHostEventLoop: (report: unknown) => void eventLoop.push(report),
      reportHostLifecycle: (report: unknown) => void lifecycle.push(report),
      setHostBundleIdentity: (given: unknown) => void identity.push(given),
      reportHostProcessExitConfirmed: async (marker: unknown) => (exitConfirmed.push(marker), true),
      reportBoxLogBatch: (records: unknown, settle: (settlement: "delivered" | "dropped") => void) => (boxBatches.push(records), settle("delivered")),
      reportBoxLogShip: (report: unknown, settle?: (settlement: "delivered" | "dropped") => void) => (boxShips.push(report), settle?.("delivered")),
      setFlushTickListener: (listener?: () => void) => void (tickListener = listener),
      dispose: async () => void (disposed += 1),
    } as unknown as SlateStructuredLogTelemetry,
    renewals,
    hostLogs,
    desktopHealth,
    eventLoop,
    identity,
    exitConfirmed,
    lifecycle,
    boxBatches,
    boxShips,
    startEchoingToConsole: () => void (echoHostLog = true),
    tick: () => tickListener?.(),
    get tickListener() {
      return tickListener;
    },
    get disposed() {
      return disposed;
    },
  };
}

function fakeAnalytics() {
  const events: { name: string; props: Record<string, string | number | boolean> }[] = [];
  const marked: string[] = [];
  const gates: unknown[] = [];
  let activateFails = false;
  let disposed = 0;
  const analytics: ProductAnalytics = {
    activate: async (gate) => {
      gates.push(gate);
      if (activateFails) throw new Error("the analytics backend faulted");
    },
    markActive: (reason: string) => void marked.push(reason),
    canRecordEvents: () => true,
    trackEvent: (name: string, properties: Record<string, string | number | boolean>) => void events.push({ name, props: properties }),
    dispose: async () => void (disposed += 1),
  };
  return {
    analytics,
    events,
    marked,
    gates,
    failActivation: () => void (activateFails = true),
    get disposed() {
      return disposed;
    },
  };
}

/** The tracing the host hands the service: the test sees both what it flushed and when it was let go of. */
function fakeTracing() {
  const flushes: string[] = [];
  let disposed = 0;
  return {
    tracing: { flush: async () => void flushes.push("flush"), dispose: async () => void (disposed += 1) },
    flushes,
    get disposed() {
      return disposed;
    },
  };
}

/** The pollings the host hands the service, each one runnable by the test instead of by a timer. */function fakePolling() {
  const polls: Record<string, { starts: number; disposes: number; listener?: () => Promise<void> }> = {};
  return {
    polling: (name: string) => ({
      start: (listener: () => Promise<void>) => {
        const entry = (polls[name] = { starts: (polls[name]?.starts ?? 0) + 1, disposes: 0, listener });
        return { dispose: () => void (entry.disposes += 1) };
      },
    }),
    polls,
    run: async (name: string): Promise<void> => {
      const listener = polls[name]?.listener;
      if (listener === undefined) throw new Error(`nothing is polling ${name}`);
      await listener();
    },
    inState: (name: string) => polls[name] ?? { starts: 0, disposes: 0 },
  };
}

function telemetryWorld(options: { disabled?: boolean; inBox?: boolean; hostLogFile?: string; healthPath?: string; markerRead?: HostCrashMarkerRead; markerDelete?: "deleted" | "unavailable" } = {}) {
  const logs = fakeLogs();
  const analytics = fakeAnalytics();
  const polling = fakePolling();
  const renewals: ((result: Renewal) => void)[] = [];
  const modelApplied: (() => void)[] = [];
  const shipperDeps: ShipperDeps[] = [];
  const shipperCalls: string[] = [];
  const watchdogArms: { disposes: number }[] = [];
  const deadlineCalls: string[] = [];
  let deadlineFails = false;
  const experiments = {
    checkGate: async () => false,
    subscribe: () => () => {},
    hasHydratedExperimentUser: () => true,
    waitForHydratedExperimentUser: async () => true,
    getSlateModelExperimentState: () => ({ active: true, arm: "flash" }),
    logSlateModelExperimentExposure: () => true,
    getDynamicConfig: (name: string) => (name === PRESSURE_PROFILER_CONFIG_NAME ? { sustainedPressureWindowMs: 1 } : undefined),
    checkFeatureGate: (name: string) => name === PRESSURE_PROFILER_FEATURE_GATE,
  };
  const tracing = fakeTracing();
  const previous = { telemetry: process.env["SLATE_DISABLE_TELEMETRY"], inBox: process.env["SLATE_HOST_IN_BOX"], logFile: process.env["SLATE_HOST_LOG_FILE"] };
  if (options.disabled === true) process.env["SLATE_DISABLE_TELEMETRY"] = "1";
  else delete process.env["SLATE_DISABLE_TELEMETRY"];
  if (options.inBox === true) process.env["SLATE_HOST_IN_BOX"] = "1";
  else delete process.env["SLATE_HOST_IN_BOX"];
  if (options.hostLogFile === undefined) delete process.env["SLATE_HOST_LOG_FILE"];
  else process.env["SLATE_HOST_LOG_FILE"] = options.hostLogFile;
  const markerRead = options.markerRead ?? { kind: "absent" };
  const markerStore: HostCrashMarkerStore = {
    read: async () => markerRead,
    delete: async () => options.markerDelete ?? "deleted",
  };
  const service = new HostTelemetryService({
    auth: {
      peekAccessToken: () => "token",
      getAccessToken: async () => "token",
      getMachineId: async () => "machine-1",
      subscribeToRenewal: (listener) => (renewals.push(listener), () => void renewals.splice(renewals.indexOf(listener), 1)),
      getLastRenewalEvent: () => null,
    },
    experiments,
    inference: { onModelExperimentApplied: (listener) => (modelApplied.push(listener), () => void modelApplied.splice(modelApplied.indexOf(listener), 1)) },
    boxLogPolling: polling.polling("box-log"),
    desktopHealthPolling: polling.polling("desktop-health"),
    hostCrashMarkerPolling: polling.polling("crash-marker"),
    hostCrashMarkerStore: markerStore,
    fatalFlushDeadline: {
      run: async <T>(operation: () => Promise<T>): Promise<T> => {
        deadlineCalls.push("run");
        if (deadlineFails) throw new Error("the deadline expired");
        return await operation();
      },
    },
    clock: { monotonicNow: () => 1_000 },
    hostLifecycleWatchdog: {
      arm: () => {
        const handle = { disposes: 0 };
        watchdogArms.push(handle);
        return { dispose: () => void (handle.disposes += 1) };
      },
    },
    ...(options.healthPath === undefined ? {} : { desktopHealthPath: options.healthPath }),
    createBoxLogShipper: (deps) => {
      shipperDeps.push(deps);
      return {
        start: async () => void shipperCalls.push("start"),
        stopPolling: async () => void shipperCalls.push("stopPolling"),
        checkpointOffsets: async () => void shipperCalls.push("checkpointOffsets"),
        dispose: async () => void shipperCalls.push("dispose"),
      };
    },
    analytics: analytics.analytics,
    logs: logs.logs,
    tracing: tracing.tracing,
  });
  return {
    service,
    logs,
    analytics,
    experiments,
    tracing,
    polling,
    renewals,
    modelApplied,
    shipperDeps,
    shipperCalls,
    watchdogArms,
    deadlineCalls,
    failActivation: analytics.failActivation,
    failDeadline: () => void (deadlineFails = true),
    restore: () => {
      for (const [key, value] of [["SLATE_DISABLE_TELEMETRY", previous.telemetry], ["SLATE_HOST_IN_BOX", previous.inBox], ["SLATE_HOST_LOG_FILE", previous.logFile]] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}

describe("the analytics a host that cannot report uses", () => {
  it("answers everything, and records nothing", async () => {
    const analytics: ProductAnalytics = new NoopProductAnalytics();
    assert.deepEqual(
      [
        analytics.canRecordEvents(),
        await analytics.activate({ checkGate: async () => false, subscribe: () => () => {} }),
        analytics.markActive("x"),
        analytics.trackEvent("slate.event", { a: 1 }),
        await analytics.dispose(),
      ],
      [false, undefined, undefined, undefined, undefined],
    );
  });
});

describe("credential renewals", () => {
  it("reports every renewal, including the one that happened before anyone listened", () => {
    const logs = fakeLogs();
    let listener: ((result: Renewal) => void) | undefined;
    let unsubscribed = 0;
    const unsubscribe = subscribeToCredentialRenewalTelemetry(
      {
        subscribeToRenewal: (given) => ((listener = given), () => void (unsubscribed += 1)),
        getLastRenewalEvent: () => RENEWAL_FAILED,
      },
      logs.logs,
    );
    // The renewal nobody was listening for is reported at once, and a failure is an error.
    assert.deepEqual(logs.renewals[0], { level: "error", metadata: { outcome: "failed", consecutive_failures: "3", duration_ms: "120", error_summary: "the backend refused" } });
    listener!({ outcome: "renewed", consecutiveFailures: 0, durationMs: 5 });
    assert.deepEqual(logs.renewals[1], { level: "info", metadata: { outcome: "renewed", consecutive_failures: "0", duration_ms: "5", error_summary: undefined } });
    assert.equal(unsubscribe(), undefined);
    assert.equal(unsubscribed, 1);
    // A host that never renewed anything reports nothing at subscribe time.
    const quiet = fakeLogs();
    subscribeToCredentialRenewalTelemetry({ subscribeToRenewal: () => () => {}, getLastRenewalEvent: () => null }, quiet.logs);
    assert.deepEqual(quiet.renewals, []);
  });
});

describe("starting and stopping the host's telemetry", () => {
  it("writes what the console says into the host log, and puts the console back", async () => {
    const world = telemetryWorld();
    const originals = { log: console.log, info: console.info, warn: console.warn, error: console.error };
    const written: string[] = [];
    const capture = (...args: unknown[]) => void written.push(args.join(" "));
    console.log = capture;
    console.info = capture;
    console.warn = capture;
    console.error = capture;
    try {
      await world.service.start();
      console.log("hello", 1);
      console.info("noted");
      console.warn("careful");
      console.error("broken");
      assert.deepEqual(written, ["hello 1", "noted", "careful", "broken"]);
      assert.deepEqual(world.logs.hostLogs, [
        { level: "info", line: "hello 1" },
        { level: "info", line: "noted" },
        { level: "warn", line: "careful" },
        { level: "error", line: "broken" },
      ]);
      // A transport that writes back to the console is not reported a second time.
      world.logs.startEchoingToConsole();
      console.warn("careful again");
      assert.deepEqual(written.slice(4), ["careful again", "[rather-a-transport] careful again"]);
      assert.deepEqual(world.logs.hostLogs.slice(4), [{ level: "warn", line: "careful again" }]);
      // A console the service did not wrap is left alone when it stops.
      const replacement = (...args: unknown[]) => void written.push(`replaced ${args.join(" ")}`);
      console.log = replacement;
      await world.service.dispose();
      assert.deepEqual([console.log, console.info, console.warn, console.error], [replacement, capture, capture, capture]);
      console.log("after dispose");
      assert.deepEqual(written.slice(6), ["replaced after dispose"]);
      assert.equal(world.logs.hostLogs.length, 5);
    } finally {
      Object.assign(console, originals);
      world.restore();
    }
  });

  it("turns on the event loop, the profiler, the heartbeat and the analytics only while telemetry is allowed", async () => {
    const allowed = telemetryWorld();
    try {
      await allowed.service.start();
      assert.deepEqual([allowed.polling.inState("desktop-health").starts, allowed.polling.inState("box-log").starts], [1, 0]);
      assert.equal(typeof allowed.logs.tickListener, "function");
      // The window and the profiler are fed by the log's own flush.
      allowed.logs.tick();
      // Analytics was activated with the host's own experiment gates, and the host is counted as started.
      assert.equal(allowed.analytics.gates[0], allowed.experiments);
      await tick();
      assert.deepEqual(allowed.analytics.marked, ["host_startup"]);
      // The experiment the host applied is noted, which counts the exposure once.
      for (const listener of allowed.modelApplied) listener();
      await tick();
      assert.deepEqual(allowed.analytics.events, [{ name: "slate.model_experiment.exposure", props: { arm: "flash" } }]);
      await allowed.service.dispose();
      assert.deepEqual([allowed.polling.inState("desktop-health").disposes, allowed.logs.tickListener, allowed.logs.disposed, allowed.analytics.disposed, allowed.tracing.disposed], [1, undefined, 1, 1, 1]);
      // Nothing this host subscribed to is left listening to it.
      assert.deepEqual([allowed.renewals.length, allowed.modelApplied.length], [0, 0]);
    } finally {
      allowed.restore();
    }
    const disabled = telemetryWorld({ disabled: true, inBox: true });
    try {
      await disabled.service.start();
      // With telemetry turned off there is no heartbeat, no window and no shipping — but the console is still wired.
      assert.deepEqual([Object.keys(disabled.polling.polls).length, disabled.shipperDeps.length, disabled.logs.tickListener], [0, 0, undefined]);
      await tick();
      assert.deepEqual(disabled.analytics.marked, ["host_startup"]);
      await disabled.service.dispose();
      assert.equal(disabled.logs.disposed, 1);
    } finally {
      disabled.restore();
    }
  });

  it("says what it could not do when analytics cannot be activated, instead of failing the start", async () => {
    const world = telemetryWorld();
    const warning = console.warn;
    const captured: string[] = [];
    console.warn = (...args: unknown[]) => void captured.push(args.join(" "));
    try {
      world.failActivation();
      await world.service.start();
      await tick();
      // The warning reaches the console as always, and the host log as well.
      assert.deepEqual(captured, ["[slate-telemetry] analytics activation failed (Error)"]);
      assert.deepEqual(world.logs.hostLogs, [{ level: "warn", line: "[slate-telemetry] analytics activation failed (Error)" }]);
      assert.deepEqual(world.analytics.marked, []);
      await world.service.dispose();
    } finally {
      console.warn = warning;
      world.restore();
    }
  });

  it("ships the box's logs only in a box, and never before the host knows which bundle it is", async () => {
    const outside = telemetryWorld();
    try {
      await outside.service.start();
      await outside.service.setHostBundleIdentity({ hostBundleVersion: "1.2.3" });
      assert.deepEqual(outside.shipperDeps, []);
    } finally {
      outside.restore();
    }
    const inBox = telemetryWorld({ inBox: true });
    try {
      await inBox.service.start();
      assert.deepEqual(inBox.shipperCalls, []);
      // The supervisor's own log is where the shipper would write about the shipping.
      assert.deepEqual(inBox.shipperDeps[0]!.skipPaths, [SUPERVISOR_LOG_PATH]);
      await inBox.service.setHostBundleIdentity({ hostBundleVersion: "1.2.3", boxStoreId: "store-1" });
      assert.deepEqual([inBox.logs.identity, inBox.shipperCalls], [[{ hostBundleVersion: "1.2.3", boxStoreId: "store-1" }], ["start"]]);
      // What the shipper reports is written by the host log, and what it settles comes back to it.
      const settled: string[] = [];
      inBox.shipperDeps[0]!.reportBatch([{ kind: "log", source: "a", line: "x" }], (settlement) => void settled.push(settlement));
      inBox.shipperDeps[0]!.reportBoxLogShip({ kind: "progress", bytesWritten: 1, bytesDelivered: 1, pendingWindowCount: 0, oldestPendingWindowAgeMs: 0 }, (settlement) => void settled.push(settlement));
      assert.deepEqual([inBox.logs.boxBatches, inBox.logs.boxShips, settled], [[[{ kind: "log", source: "a", line: "x" }]], [{ kind: "progress", bytesWritten: 1, bytesDelivered: 1, pendingWindowCount: 0, oldestPendingWindowAgeMs: 0 }], ["delivered", "delivered"]]);
      await inBox.service.dispose();
      assert.deepEqual(inBox.shipperCalls, ["start", "stopPolling", "checkpointOffsets", "dispose"]);
    } finally {
      inBox.restore();
    }
    // A host that names its own log file keeps that file out of the shipping instead.
    const named = telemetryWorld({ inBox: true, hostLogFile: "/tmp/slate-host.log" });
    try {
      await named.service.start();
      assert.deepEqual(named.shipperDeps[0]!.skipPaths, ["/tmp/slate-host.log"]);
      await named.service.dispose();
    } finally {
      named.restore();
    }
  });

  it("forwards the marker a crashed host left, and stops once there is nothing left to wait for", async () => {
    const absent = telemetryWorld();
    try {
      await absent.service.start();
      await absent.service.setHostBundleIdentity({});
      assert.equal(absent.polling.inState("crash-marker").starts, 1);
      // A second identity does not start a second watch for the same marker.
      await absent.service.setHostBundleIdentity({});
      assert.equal(absent.polling.inState("crash-marker").starts, 1);
      await absent.polling.run("crash-marker");
      assert.deepEqual([absent.polling.inState("crash-marker").disposes, absent.logs.exitConfirmed], [1, []]);
    } finally {
      absent.restore();
    }
    const unavailable = telemetryWorld({ markerRead: { kind: "unavailable" } });
    try {
      await unavailable.service.start();
      await unavailable.service.setHostBundleIdentity({});
      assert.equal(unavailable.polling.inState("crash-marker").starts, 1);
      await unavailable.polling.run("crash-marker");
      // A store that cannot be read is one to wait for, not one to give up on.
      assert.equal(unavailable.polling.inState("crash-marker").disposes, 0);
      await unavailable.service.dispose();
      assert.equal(unavailable.polling.inState("crash-marker").disposes, 1);
    } finally {
      unavailable.restore();
    }
    const delivered = telemetryWorld({ markerRead: { kind: "present", raw: JSON.stringify({ schemaVersion: 1, errorClass: "signal_exit", exitSignal: "SIGSEGV", startedAtMs: 500, crashedAtMs: 1_000, uptimeMs: 500 }) } });
    try {
      await delivered.service.start();
      await delivered.service.setHostBundleIdentity({});
      await delivered.polling.run("crash-marker");
      // The marker the host reads is the one it forwards, and the polling stops once it is delivered.
      assert.deepEqual(delivered.logs.exitConfirmed, [{ schemaVersion: 1, errorClass: "signal_exit", exitSignal: "SIGSEGV", startedAtMs: 500, crashedAtMs: 1_000, uptimeMs: 500 }]);
      assert.equal(delivered.polling.inState("crash-marker").disposes, 1);
    } finally {
      delivered.restore();
    }
    const unreadable = telemetryWorld({ markerRead: { kind: "present", raw: "not json" } });
    try {
      await unreadable.service.start();
      await unreadable.service.setHostBundleIdentity({});
      await unreadable.polling.run("crash-marker");
      // A marker that cannot be read is dropped rather than waited on: it will not get any more readable.
      assert.deepEqual([unreadable.logs.exitConfirmed, unreadable.polling.inState("crash-marker").disposes], [[], 1]);
    } finally {
      unreadable.restore();
    }
  });

  it("reports a message being sent with the counts and the flags a report carries", () => {
    const world = telemetryWorld();
    try {
      world.service.reportMessageSent({ agentId: "agent-1", prompt: "  hello there  ", attachmentPaths: ["/a", "/b"], richText: "**hi**", isFork: true, source: "code", isGroupRoom: true });
      assert.deepEqual(world.analytics.marked, ["user_action"]);
      assert.deepEqual(world.analytics.events, [{
        name: "slate.message.sent",
        props: { agent_id: "agent-1", char_count: 11, length_bucket: slateMessageLengthBucket(11), attachment_count: 2, has_rich_text: true, is_fork: true, source: "code", is_group_room: true },
      }]);
      // A message with nothing said about it is a desktop message of its own length.
      world.service.reportMessageSent({ agentId: "agent-2", prompt: "hi", richText: "", isGroupRoom: false });
      assert.deepEqual(world.analytics.events[1]!.props, { agent_id: "agent-2", char_count: 2, length_bucket: slateMessageLengthBucket(2), attachment_count: 0, has_rich_text: false, is_fork: false, source: "desktop", is_group_room: false });
    } finally {
      world.restore();
    }
  });

  it("hands the host the surface it asks for, wired to this host's own parts", async () => {
    const world = telemetryWorld();
    try {
      const api = world.service.api();
      assert.deepEqual(Object.keys(api).sort(), ["analytics", "brain", "createHostLifecycleProgress", "flushForFatalExit", "flushTracing", "logs", "noteSlateModelExperimentActive", "reportMessageSent", "setHostBundleIdentity"]);
      assert.deepEqual([api.logs === world.service.logs, api.analytics === world.service.analytics], [true, true]);
      // The phases are timed off the host's clock and reported through its log, with a watchdog armed per phase.
      const progress = api.createHostLifecycleProgress(123);
      assert.equal(world.watchdogArms.length, 1);
      progress.complete({ phase: "plugin_graph", pluginCount: 2 });
      assert.deepEqual(world.logs.lifecycle, [{ phase: "plugin_graph", pluginCount: 2, outcome: "completed", durationMs: 877 }]);
      assert.equal(world.watchdogArms[0]!.disposes, 1);
      // The exposure is noted the way the host names it.
      api.noteSlateModelExperimentActive();
      await tick();
      assert.deepEqual(world.analytics.events, [{ name: "slate.model_experiment.exposure", props: { arm: "flash" } }]);
      await api.flushTracing();
      assert.deepEqual(world.tracing.flushes, ["flush"]);
      await api.setHostBundleIdentity({ hostBundleVersion: "9.9.9" });
      assert.deepEqual(world.logs.identity, [{ hostBundleVersion: "9.9.9" }]);
      // The message-sent report is the same one the surface offers.
      api.reportMessageSent({ agentId: "agent-3", isGroupRoom: true });
      assert.deepEqual(world.analytics.events[1]!.name, "slate.message.sent");
    } finally {
      world.restore();
    }
  });

  it("flushes what must not be lost when the host is going down, and never fails the exit", async () => {
    const world = telemetryWorld({ inBox: true });
    try {
      await world.service.start();
      await world.service.setHostBundleIdentity({});
      world.shipperCalls.length = 0;
      await world.service.flushForFatalExit();
      assert.deepEqual([world.deadlineCalls.length, world.shipperCalls, world.logs.disposed], [1, ["stopPolling", "checkpointOffsets", "dispose"], 1]);
      // Nothing that outlives the exit is let go of here.
      assert.equal(world.analytics.disposed, 0);
      await world.service.dispose();
      assert.equal(world.analytics.disposed, 1);
    } finally {
      world.restore();
    }
    const expired = telemetryWorld();
    try {
      expired.failDeadline();
      await assert.doesNotReject(expired.service.flushForFatalExit());
      assert.equal(expired.logs.disposed, 0);
    } finally {
      expired.restore();
    }
  });

  it("says nothing about a desktop that left no health report, and follows one that did", async () => {
    const dir = mkdtempSync(join(tmpdir(), "slate-telemetry-service-"));
    const healthPath = join(dir, "desktop-health.json");
    const world = telemetryWorld({ healthPath });
    try {
      await world.service.forwardDesktopHealth();
      assert.deepEqual(world.logs.desktopHealth, []);
      writeFileSync(healthPath, HEALTH_ONE_DOWN);
      await world.service.forwardDesktopHealth();
      assert.deepEqual(world.logs.desktopHealth, [{
        level: "warn",
        metadata: { supervision_enabled: "true", overall: "degraded", total: "1", up: "0", down: "1", crashlooping: "0", restarts_window: "2", down_detail: "shared/xvfb", down_reason: "shared/xvfb=oom" },
      }]);
      // The same revision is not reported again until the heartbeat comes round.
      await world.service.forwardDesktopHealth();
      assert.equal(world.logs.desktopHealth.length, 1);
      writeFileSync(healthPath, HEALTH_ALL_UP);
      await world.service.forwardDesktopHealth();
      assert.deepEqual(world.logs.desktopHealth[1], {
        level: "info",
        metadata: { supervision_enabled: "true", overall: "healthy", total: "1", up: "1", down: "0", crashlooping: "0", restarts_window: "0", down_detail: undefined, down_reason: undefined },
      });
      // A report that cannot be read is left alone.
      writeFileSync(healthPath, "half a report");
      await world.service.forwardDesktopHealth();
      assert.equal(world.logs.desktopHealth.length, 2);
      await world.service.dispose();
    } finally {
      world.restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads the desktop's health from where the platform leaves it unless the host says otherwise", async () => {
    const world = telemetryWorld();
    const platformPath = SLATE_SUPERVISOR_DESKTOP_HEALTH_PATH;
    // Whatever the platform left here is put back: a report of its own, or nothing at all.
    const saved = existsSync(platformPath) ? readFileSync(platformPath, "utf8") : undefined;
    const dirExisted = existsSync(dirname(platformPath));
    try {
      if (saved === undefined) {
        await world.service.forwardDesktopHealth();
        assert.deepEqual(world.logs.desktopHealth, []);
      }
      mkdirSync(dirname(platformPath), { recursive: true });
      writeFileSync(platformPath, HEALTH_ONE_DOWN);
      await world.service.forwardDesktopHealth();
      assert.deepEqual(world.logs.desktopHealth.map((entry) => entry.metadata["overall"]), ["degraded"]);
      await world.service.dispose();
    } finally {
      if (saved === undefined) rmSync(platformPath, { force: true });
      else writeFileSync(platformPath, saved);
      if (!dirExisted) rmSync(dirname(platformPath), { recursive: true, force: true });
      world.restore();
    }
  });
});
