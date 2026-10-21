/**
 * The host process and its lifecycle: the phases startup walks, what health means, what a box reports when it is ready,
 * and how the process exits when startup fails or a shutdown overruns its watchdog.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { BOX_READY_REPORT_ATTEMPTS, BOX_READY_STAGE_MARKER_PATH, SlateHost, createProductionSlateHost, type HostExtensionRegistry, type SlateHostRuntime } from "../../source/host/slate-host.ts";
import { installShutdownHandlers, main, reportLockOutcome } from "../../source/host/main.ts";

/** A registry of extension APIs: every method a startup or a health check calls, recording what it was asked to do. */
function registry(overrides: { isBusy?: boolean; backgroundShell?: boolean; diskPressureLevel?: string | null } = {}) {
  const calls: string[] = [];
  const awaiters: Array<() => void> = [];
  const record = (name: string) => (...args: unknown[]) => {
    calls.push(args.length === 0 ? name : `${name}:${JSON.stringify(args)}`);
  };
  const apis: Record<string, Record<string, unknown>> = {
    telemetry: {
      createHostLifecycleProgress: () => ({
        complete: (phase: Record<string, unknown>) => {
          calls.push(`phase:${String(phase.phase)}`);
          awaiters.forEach((resolve) => resolve());
        },
        fail: () => {
          calls.push("phase:failed");
        },
      }),
      setHostBundleIdentity: record("setHostBundleIdentity"),
      logs: { reportHostStartup: record("reportHostStartup") },
    },
    transcript: {
      hasRunningBackgroundShellWork: () => overrides.backgroundShell === true,
      getActiveAgentId: () => "agent-1",
      kickstartAgent: async () => true,
      listAgentsSync: () => [],
      subscribe: record("subscribeTranscript"),
      subscribeAgents: record("subscribeAgents"),
      createAwaitingStateSink: () => undefined,
      setAgentForgottenObserver: record("setAgentForgottenObserver"),
      setShouldEmitAutomations: record("setShouldEmitAutomations"),
      setConnectorConnectCardObserver: record("setConnectorConnectCardObserver"),
      ensureLoaded: async () => [],
      liveRunningAgentIds: () => [],
      dispose: async () => calls.push("disposeTranscript"),
    },
    // The roster's own bookkeeping asks for these on every apply, so the stub exposes them as the real extension does.
    attachments: { setFallbackAgentId: record("setFallbackAgentId") },
    "state-backstop": { isEnabled: false, scheduleSnapshot: record("scheduleSnapshot") },
    "source-map": { getOrCreate: async () => ({}) },
    "forever-box": {
      diskPressureLevel: overrides.diskPressureLevel ?? null,
      isAutoUpdateEnabled: false,
      subscribeToDiskPressure: record("subscribeDiskPressure"),
      diskPressureReminder: { enroll: record("enroll") },
      setBusy: record("setBusy"),
    },
    "host-upgrade": { resolveHostBundleIdentityVersion: async () => "1.2.3", startSharedUpdateWatch: record("startSharedUpdateWatch") },
    "box-store-sync": { getStoreId: async () => "store-1", isEnabled: false, scheduleStoreDbSnapshot: record("scheduleStoreDbSnapshot") },
    mcp: { subscribeToAuthCompletion: record("subscribeAuthCompletion") },
    "cross-user-sharing": { subscribe: record("subscribeSharing"), prepareForUpgrade: record("prepareSharing") },
    settings: { subscribeToChanges: record("subscribeSettings") },
    "local-tool-permission": { bindAskSurfaces: record("bindAskSurfaces") },
    "local-exec": { checkLiveComputerForAsk: () => true },
    "turn-execution": { bindExecutor: record("bindExecutor") },
    inference: { isReady: async () => true },
    "managed-setup": { dispose: record("disposeManagedSetup") },
    automations: { suspendWakes: async () => calls.push("suspendWakes"), reconcileNow: record("reconcileNow") },
    "auto-review": { agentIdsWithPendingApprovals: () => [], expirePendingApprovals: record("expireApprovals") },
    trays: {},
    memory: {},
    "teach-recording": {},
    session: {},
  };
  const registry: HostExtensionRegistry = {
    order: ["telemetry", "transcript", "forever-box"],
    api: ((id: string) => apis[id] ?? {}) as HostExtensionRegistry["api"],
    stop: async () => {
      calls.push("stopExtensions");
    },
  };
  return { registry, calls };
}

/** Waits (bounded) until the predicate holds. */
async function until(predicate: () => boolean): Promise<void> {
  for (let tick = 0; tick < 400; tick += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("the expected state never arrived");
}

function runtime(overrides: Record<string, unknown> = {}) {
  const state = registry();
  const runnerCalls: string[] = [];
  return {
    calls: state.calls,
    runtime: {
      async startExtensions() {
        state.calls.push("startExtensions");
        return state.registry as never;
      },
      createRunnerComposition() {
        runnerCalls.push("createRunnerComposition");
        return {
          createRunner: () => ({}),
          createGroupMemberRunner: () => ({}),
          canAskLocalToolPermission: () => false,
          forgetLocalToolPermission: () => {},
          dispose: async () => {
            runnerCalls.push("disposeComposition");
          },
        };
      },
      resolveMcpAuthCompletion: () => {},
      registerConnectorConnectCard: () => {},
      createGatewayDependencies: (options: Record<string, unknown>) => options as never,
      now: () => 1_000,
      ...overrides,
    } as unknown as SlateHostRuntime,
    runnerCalls,
  };
}

describe("the host lifecycle", () => {
  it("walks its startup phases in order and reports the graph it started", async () => {
    const { runtime: hostRuntime, calls } = runtime();
    const logs: string[] = [];
    const host = new SlateHost({ ...hostRuntime, log: { log: (message: string) => logs.push(message), error: () => {} } } as never);
    await host.start();
    const phases = calls.filter((call) => call.startsWith("phase:"));
    assert.deepEqual(phases, ["phase:plugin_graph", "phase:identity", "phase:log_catchup", "phase:transcript_read", "phase:ready"]);
    assert.equal(logs.some((line) => line.includes("telemetry -> transcript -> forever-box")), true);
  });

  it("refuses to hand out an API, a health check or a bridge before startup", () => {
    const { runtime: hostRuntime } = runtime();
    const host = new SlateHost(hostRuntime);
    assert.throws(() => host.getApi(), /host extensions are not started/);
    assert.throws(() => host.getHealth(), /host extensions are not started/);
  });

  it("tells a new listener the current disk-pressure level, then stops telling it anything", async () => {
    const { runtime: hostRuntime } = runtime();
    const host = new SlateHost({ ...hostRuntime } as never);
    await host.start();
    const seen: unknown[] = [];
    const unsubscribe = host.subscribe((event) => seen.push(event));
    assert.deepEqual(seen[0], { channel: "box-disk-pressure", payload: null });
    unsubscribe();
    host.subscribe(() => {});
    assert.equal(seen.length, 1);
  });

  it("disposes its parts in the order the platform depends on", async () => {
    const { runtime: hostRuntime, calls } = runtime();
    const host = new SlateHost(hostRuntime);
    await host.start();
    await host.dispose();
    const order = calls.filter((call) => ["disposeManagedSetup", "suspendWakes", "prepareSharing", "expireApprovals", "disposeTranscript", "stopExtensions"].includes(call));
    assert.deepEqual(order, ["disposeManagedSetup", "suspendWakes", "prepareSharing", "expireApprovals", "disposeTranscript", "stopExtensions"]);
  });
});

describe("a box reporting itself ready", () => {
  const env = { ...process.env };
  const withBoxEnv = () => {
    process.env.SLATE_BOX_BOOT_ID = "boot-1";
    process.env.SLATE_BOX_BOOT_STARTED_AT_MS = "1000";
  };

  it("does nothing outside a box", async () => {
    delete process.env.SLATE_BOX_BOOT_ID;
    const { runtime: hostRuntime } = runtime();
    const host = new SlateHost(hostRuntime);
    await host.start();
    await host.reportBoxReady();
  });

  it("reports once and writes the marker, and reports nothing when the boot already did", async () => {
    withBoxEnv();
    const markers: string[] = [];
    let delivered = true;
    const { runtime: hostRuntime, calls } = runtime({
      readReadyMarker: async () => null,
      writeReadyMarker: async (bootId: string) => {
        markers.push(bootId);
      },
    });
    const host = new SlateHost({ ...hostRuntime, log: { log: () => {}, error: () => {} } } as never);
    await host.start();
    const logs = (host as unknown as { hostExtensions: { api(id: string): Record<string, unknown> } }).hostExtensions.api("telemetry").logs as Record<string, unknown>;
    logs.reportBoxBootStageConfirmed = async () => delivered;
    await host.reportBoxReady();
    assert.deepEqual(markers, ["boot-1"]);
    // A boot whose marker is already there reports nothing.
    delivered = true;
    markers.length = 0;
    const already = new SlateHost({ ...hostRuntime, readReadyMarker: async () => "boot-1", log: { log: () => {}, error: () => {} } } as never);
    await already.start();
    await already.reportBoxReady();
    assert.deepEqual(markers, []);
    process.env = { ...env };
  });

  it("retries a report it could not deliver, a bounded number of times", async () => {
    withBoxEnv();
    const attempts: number[] = [];
    const { runtime: hostRuntime } = runtime({ readReadyMarker: async () => null, writeReadyMarker: async () => {}, readyRetryDelay: async () => {} });
    const host = new SlateHost({ ...hostRuntime, log: { log: () => {}, error: () => {} } } as never);
    await host.start();
    const logs = (host as unknown as { hostExtensions: { api(id: string): Record<string, unknown> } }).hostExtensions.api("telemetry").logs as Record<string, unknown>;
    logs.reportBoxBootStageConfirmed = async () => {
      attempts.push(attempts.length + 1);
      return false;
    };
    await host.reportBoxReady();
    assert.equal(attempts.length, BOX_READY_REPORT_ATTEMPTS);
    assert.equal(BOX_READY_STAGE_MARKER_PATH.endsWith("slate-box-ready-stage"), true);
    process.env = { ...env };
  });
});

describe("the process", () => {
  function processControl(argv: string[] = []) {
    const exits: number[] = [];
    const handlers = new Map<string, () => void>();
    return {
      control: {
        argv,
        pid: 42,
        on: (signal: string, listener: () => void) => handlers.set(signal, listener),
        exit: (code: number) => exits.push(code),
      },
      exits,
      handlers,
    };
  }

  function hostStub(overrides: Record<string, unknown> = {}) {
    const calls: string[] = [];
    const host = {
      startedAt: 1_000,
      async start() {},
      async dispose() {
        calls.push("dispose");
      },
      getApi: () => ({}),
      subscribe: () => () => {},
      getHealth: () => ({}),
      noteEventStreamClosed: () => {},
      noteDesktopContact: () => {},
      async prepareForUpgrade() {
        return {};
      },
      getLocalExecBridge: () => ({}),
      getWebAuthnBridge: () => ({}),
      reportProcessCrash: (error: unknown, kind: string) => calls.push(`crash:${kind}`),
      reportInvariantViolation: () => {},
      reportHostDiagnostic: () => {},
      reportGatewayCommandError: () => {},
      reportGatewayCommandSuccess: () => {},
      async flushTelemetryForFatalExit() {
        calls.push("flush");
      },
      async reportBoxReady() {
        calls.push("boxReady");
      },
      ...overrides,
    };
    return { host, calls };
  }

  function deps(overrides: Record<string, unknown> = {}) {
    const { host, calls } = hostStub();
    const lock = { released: 0, release() { this.released += 1; } };
    return {
      calls,
      lock,
      deps: {
        async executeBoxCopyInFromEnv() {
          calls.push("copyIn");
          return 0;
        },
        installProcessCrashGuards: () => ({ setReporter: () => {} }),
        installInvariantReporter: () => {},
        pinHostDiagnosticsReporter: () => {},
        async acquireHostLock() {
          calls.push("lock");
          return { lock, outcome: "fresh" };
        },
        getSlateRootDir: () => "/tmp/slate",
        createHost: () => host,
        resolveGatewayServerConfig: () => ({ host: "127.0.0.1", port: 1234 }),
        gatewayScheme: () => "http",
        async startGatewayServer() {
          calls.push("gateway");
          return {
            port: 1234,
            async close() {
              calls.push("closeGateway");
            },
          };
        },
        async writeGatewayDiscovery() {
          calls.push("discovery");
        },
        async clearGatewayDiscovery() {
          calls.push("clearDiscovery");
        },
        log: { log: () => {}, error: () => {} },
        ...overrides,
      } as never,
    };
  }

  it("runs the copy-in helper and exits with what it said, failing closed", async () => {
    const { control, exits } = processControl(["--box-copy-in"]);
    const { deps: hostDeps } = deps({
      async executeBoxCopyInFromEnv() {
        throw new Error("bad environment");
      },
    });
    await main(hostDeps, control as never);
    assert.deepEqual(exits, [1]);
  });

  it("starts the host and the gateway, writes discovery, and exits 0 on SIGTERM", async () => {
    const { control, exits, handlers } = processControl();
    const { deps: hostDeps, calls } = deps();
    await main(hostDeps, control as never);
    assert.deepEqual(calls.filter((call) => ["lock", "gateway", "discovery", "boxReady"].includes(call)), ["lock", "gateway", "discovery", "boxReady"]);
    assert.equal(typeof handlers.get("SIGTERM"), "function");
    handlers.get("SIGTERM")!();
    await until(() => exits.length > 0);
    assert.deepEqual(exits, [0]);
    assert.deepEqual(calls.filter((call) => ["closeGateway", "dispose", "clearDiscovery"].includes(call)), ["closeGateway", "dispose", "clearDiscovery"]);
  });

  it("cleans up and exits 1 when startup fails", async () => {
    const { control, exits } = processControl();
    const { deps: hostDeps, calls, lock } = deps({
      async startGatewayServer() {
        throw new Error("port taken");
      },
    });
    await main(hostDeps, control as never);
    assert.deepEqual(exits, [1]);
    assert.equal(calls.includes("crash:fatal_startup"), true);
    assert.equal(calls.includes("flush"), true);
    assert.equal(lock.released, 1);
    assert.equal(calls.includes("boxReady"), false);
  });

  it("shuts down once, and reports a watchdog that fires before the shutdown finished", async () => {
    const { control, exits, handlers } = processControl();
    const { deps: hostDeps, calls, lock } = deps({
      async startGatewayServer() {
        return { port: 1234, close: () => new Promise<void>(() => {}) };
      },
    });
    await main(hostDeps, control as never);
    const registration = installShutdownHandlers(
      { dispose: async () => {}, reportProcessCrash: (error, kind) => calls.push(`crash:${kind}`), flushTelemetryForFatalExit: async () => {} },
      { close: () => new Promise<void>(() => {}) },
      lock,
      async () => {},
      control as never,
      { log: () => {} },
      5,
    );
    registration.shutdown("SIGTERM");
    registration.shutdown("SIGTERM");
    await until(() => exits.length > 0);
    assert.deepEqual(exits, [1]);
    assert.equal(calls.includes("crash:shutdown_watchdog"), true);
    assert.equal(lock.released, 1);
  });

  it("says which host it took the lock from", () => {
    const lines: string[] = [];
    reportLockOutcome({ lock: { release: () => {} }, outcome: "took-over", previousPid: 7 }, "/tmp/slate", { log: (line: string) => lines.push(line) });
    reportLockOutcome({ lock: { release: () => {} }, outcome: "stale", previousPid: 8 }, "/tmp/slate", { log: (line: string) => lines.push(line) });
    reportLockOutcome({ lock: { release: () => {} }, outcome: "fresh" }, "/tmp/slate", { log: (line: string) => lines.push(line) });
    assert.equal(lines.length, 2);
    assert.match(lines[0]!, /took over .* pid 7/);
    assert.match(lines[1]!, /reclaimed .* from pid 8/);
  });

  it("builds the production host around the ports it was given", () => {
    const host = createProductionSlateHost({
      extensionsById: {},
      extensionHost: { boxGenerated: {}, convertCloudAgentConversationToTrace: () => [] },
      runnerContext: {},
      createTranscriptMirror: () => ({}) as never,
    } as never);
    assert.throws(() => host.getApi(), /host extensions are not started/);
  });
});
