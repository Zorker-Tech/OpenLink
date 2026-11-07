import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BOX_COPY_IN_ARG,
  BOX_COPY_IN_EXIT_FAILED,
  SHUTDOWN_WATCHDOG_MS,
  createProductionHostMainDependencies,
  installShutdownHandlers,
  main,
  reportLockOutcome,
} from "../../source/host/main.ts";

// ---------------------------------------------------------------------------------------------
// harnesses
// ---------------------------------------------------------------------------------------------

const until = async (predicate: () => boolean): Promise<void> => {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 2_000) throw new Error("timed out");
    await new Promise(resolve => setTimeout(resolve, 2));
  }
};

function processControl(argv: string[] = []) {
  const exits: number[] = [];
  const handlers = new Map<string, () => void>();
  return {
    exits,
    handlers,
    control: {
      argv,
      pid: 4242,
      on: (signal: string, listener: () => void) => { handlers.set(signal, listener); },
      exit: (code: number) => { exits.push(code); },
    },
  };
}

interface DepsOverrides {
  executeBoxCopyInFromEnv?: () => Promise<number>;
  acquireHostLock?: () => Promise<unknown>;
  releaseHostLock?: () => void;
  startBoxExecDaemon?: () => Promise<unknown>;
  closeBoxExecDaemon?: () => Promise<void>;
  createHost?: () => unknown;
  startHost?: () => Promise<void>;
  disposeHost?: () => Promise<void>;
  flushTelemetry?: () => Promise<void>;
  resolveGatewayServerConfig?: () => unknown;
  startGatewayServer?: (options: unknown) => Promise<unknown>;
  closeGateway?: () => Promise<void>;
  writeGatewayDiscovery?: (discovery: unknown) => Promise<void>;
  clearGatewayDiscovery?: () => Promise<void>;
  reportBoxReady?: () => Promise<void>;
  withDaemon?: boolean;
  withLog?: boolean;
}

function graph(overrides: DepsOverrides = {}) {
  const calls: string[] = [];
  const logs: string[] = [];
  const errors: unknown[][] = [];
  const options: unknown[] = [];
  const discovery: unknown[] = [];
  let released = 0;
  const host = {
    startedAt: 1_000,
    start: async () => { calls.push("host.start"); await overrides.startHost?.(); },
    dispose: async () => { calls.push("host.dispose"); await overrides.disposeHost?.(); },
    getApi: () => "api",
    subscribe: () => () => {},
    getHealth: () => "health",
    getLocalExecBridge: () => "localExec",
    getWebAuthnBridge: () => "webauthn",
    noteEventStreamClosed: () => {},
    noteDesktopContact: () => {},
    prepareForUpgrade: async () => "prepared",
    reportProcessCrash: (error: unknown, kind: string) => { calls.push("crash:" + kind); void error; },
    reportInvariantViolation: () => {},
    reportHostDiagnostic: () => {},
    reportGatewayCommandError: () => {},
    reportGatewayCommandSuccess: () => {},
    flushTelemetryForFatalExit: async () => { calls.push("flush"); await overrides.flushTelemetry?.(); },
    reportBoxReady: overrides.reportBoxReady ?? (async () => { calls.push("boxReady"); }),
  };
  const daemon = { close: async () => { calls.push("daemon.close"); await overrides.closeBoxExecDaemon?.(); } };
  const deps: Record<string, unknown> = {
    executeBoxCopyInFromEnv: overrides.executeBoxCopyInFromEnv ?? (async () => { calls.push("copyIn"); return 0; }),
    installProcessCrashGuards: () => ({ setReporter: () => { calls.push("setReporter"); } }),
    installInvariantReporter: () => {},
    pinHostDiagnosticsReporter: () => {},
    acquireHostLock: overrides.acquireHostLock ?? (async () => { calls.push("lock"); return { lock: { release: () => { released += 1; calls.push("lock.release"); overrides.releaseHostLock?.(); } }, outcome: "fresh" }; }),
    getSlateRootDir: () => "/tmp/slate-root",
    createHost: overrides.createHost ?? (() => { calls.push("createHost"); return host; }),
    resolveGatewayServerConfig: overrides.resolveGatewayServerConfig ?? (() => { calls.push("gatewayConfig"); return { host: "127.0.0.1", port: 4321 }; }),
    gatewayScheme: () => { calls.push("scheme"); return "http"; },
    startGatewayServer: overrides.startGatewayServer ?? (async (gatewayOptions: unknown) => { calls.push("gateway"); options.push(gatewayOptions); return { port: 4321, close: async () => { calls.push("gateway.close"); await overrides.closeGateway?.(); } }; }),
    writeGatewayDiscovery: overrides.writeGatewayDiscovery ?? (async (record: unknown) => { calls.push("discovery"); discovery.push(record); }),
    clearGatewayDiscovery: overrides.clearGatewayDiscovery ?? (async () => { calls.push("clearDiscovery"); }),
    ...(overrides.withDaemon === false ? {} : { startBoxExecDaemon: overrides.startBoxExecDaemon ?? (async () => { calls.push("daemon.start"); return daemon; }) }),
    ...(overrides.withLog === false ? {} : { log: { log: (line: string) => logs.push(line), error: (...args: unknown[]) => errors.push(args) } }),
  };
  return { calls, logs, errors, options, discovery, host, deps, lockState: () => released };
}

// ---------------------------------------------------------------------------------------------
// the process, its two modes and its exits
// ---------------------------------------------------------------------------------------------

describe("the host process entry point", () => {
  it("fails closed when the copy-in helper fails, and exits with what it said otherwise", async () => {
    const { control, exits } = processControl(["--box-copy-in"]);
    const failed = graph({ executeBoxCopyInFromEnv: async () => { throw new Error("bad environment"); } });
    await main(failed.deps as never, control as never);
    assert.deepEqual(exits, [BOX_COPY_IN_EXIT_FAILED]);
    assert.equal(failed.errors.length, 1);
    assert.match(String(failed.errors[0]![0]), /\[box-copy-in\] unexpected error \(failing closed\):/);
    assert.equal(failed.calls.includes("lock"), false, "the copy-in mode never takes the lock");

    const { control: secondControl, exits: secondExits } = processControl(["--box-copy-in"]);
    const returned = graph({ executeBoxCopyInFromEnv: async () => 7 });
    await main(returned.deps as never, secondControl as never);
    assert.deepEqual(secondExits, [7]);
    assert.equal(SHUTDOWN_WATCHDOG_MS, 5_000);
    assert.equal(BOX_COPY_IN_ARG, "--box-copy-in");
  });

  it("starts the host and gateway in order, then logs and hands the gateway its discovery record", async () => {
    const { control, exits, handlers } = processControl();
    const { deps, calls, logs, options, discovery } = graph({ resolveGatewayServerConfig: () => ({ host: "0.0.0.0", port: 4321, authToken: "secret" }) });
    await main(deps as never, control as never);
    assert.deepEqual(calls.filter(call => !call.startsWith("crash:")), [
      "lock", "createHost", "setReporter", "daemon.start", "host.start", "scheme", "gateway", "discovery", "boxReady",
    ]);
    assert.deepEqual(options[0], {
      api: "api",
      subscribe: options[0] && typeof (options[0] as Record<string, unknown>).subscribe === "function" ? (options[0] as Record<string, unknown>).subscribe : undefined,
      getHealth: options[0] && (options[0] as Record<string, unknown>).getHealth,
      onEventStreamClosed: options[0] && (options[0] as Record<string, unknown>).onEventStreamClosed,
      onDesktopContact: options[0] && (options[0] as Record<string, unknown>).onDesktopContact,
      prepareForUpgrade: options[0] && (options[0] as Record<string, unknown>).prepareForUpgrade,
      startedAt: 1_000,
      host: "0.0.0.0",
      port: 4321,
      authToken: "secret",
      localExec: "localExec",
      webauthn: "webauthn",
      onCommandError: options[0] && (options[0] as Record<string, unknown>).onCommandError,
      onCommandComplete: options[0] && (options[0] as Record<string, unknown>).onCommandComplete,
    });
    assert.deepEqual(discovery[0], { port: 4321, pid: 4242, startedAt: 1_000, scheme: "http", host: "0.0.0.0", token: "secret" });
    assert.deepEqual(logs, ["[slate-host] gateway listening on http://0.0.0.0:4321 (auth required)"]);
    assert.deepEqual([...handlers.keys()], ["SIGTERM", "SIGINT"]);
    await until(() => calls.includes("boxReady"));
    assert.deepEqual(exits, []);

    handlers.get("SIGTERM")!();
    await until(() => exits.length > 0);
    assert.deepEqual(exits, [0]);
    assert.match(logs.at(-1)!, /\[slate-host\] received SIGTERM, shutting down/);
    assert.deepEqual(calls.filter(call => ["gateway.close", "host.dispose", "daemon.close", "clearDiscovery", "lock.release"].includes(call)), ["gateway.close", "host.dispose", "daemon.close", "clearDiscovery", "lock.release"]);
  });

  it("leaves out the gateway's optional parts when the config does not have them", async () => {
    const { control, exits } = processControl();
    const { deps, options, discovery, logs, calls } = graph({ resolveGatewayServerConfig: () => ({ host: "example" }), withDaemon: false });
    await main(deps as never, control as never);
    const gatewayOptions = options[0] as Record<string, unknown>;
    assert.equal(Object.hasOwn(gatewayOptions, "port"), false);
    assert.equal(Object.hasOwn(gatewayOptions, "authToken"), false);
    assert.equal(Object.hasOwn(gatewayOptions, "tls"), false);
    assert.deepEqual(discovery[0], { port: 4321, pid: 4242, startedAt: 1_000, scheme: "http", host: "example" });
    assert.deepEqual(logs, ["[slate-host] gateway listening on http://example:4321"]);
    assert.equal(calls.includes("daemon.start"), false);
  });

  it("reports a startup failure, flushes, cleans up, releases the lock and exits non-zero", async () => {
    const { control, exits } = processControl();
    const { deps, calls, lockState } = graph({ startHost: async () => { throw new Error("host failed"); } });
    await main(deps as never, control as never);
    assert.deepEqual(exits, [1]);
    assert.equal(calls.includes("crash:fatal_startup"), true);
    assert.equal(calls.includes("flush"), true);
    assert.equal(calls.includes("gateway"), false, "the gateway never started");
    assert.equal(calls.includes("boxReady"), false);
    const cleanup = calls.indexOf("crash:fatal_startup");
    assert.equal(calls.indexOf("flush") > cleanup, true, "telemetry is flushed after the crash is reported");
    assert.equal(calls.includes("host.dispose"), true, "a partially started host is disposed");
    assert.equal(calls.includes("clearDiscovery"), false, "existing discovery is preserved until a replacement was attempted");
    assert.equal(calls.includes("daemon.close"), true);
    assert.equal(calls.includes("lock.release"), true);
    assert.equal(lockState(), 1);
  });

  it("releases the lock when host construction fails after lock acquisition", async () => {
    const { control, exits } = processControl();
    const { deps, calls } = graph({
      createHost: () => { calls.push("createHost"); throw new Error("host construction failed"); },
    });
    await main(deps as never, control as never);
    assert.deepEqual(exits, [1]);
    assert.equal(calls.includes("lock.release"), true);
    assert.equal(calls.includes("daemon.start"), false);
  });

  it("continues startup cleanup when the fatal telemetry flush hangs", async () => {
    const { control, exits } = processControl();
    const { deps, calls, lockState } = graph({
      startHost: async () => { throw new Error("host start failed"); },
      flushTelemetry: () => new Promise<void>(() => {}),
    });
    await main(deps as never, control as never);
    assert.deepEqual(exits, [1]);
    assert.equal(calls.includes("host.dispose"), true);
    assert.equal(calls.includes("daemon.close"), true);
    assert.equal(calls.includes("lock.release"), true);
    assert.equal(lockState(), 1);
  });

  it("closes an opened gateway when discovery publication fails", async () => {
    const { control, exits } = processControl();
    const { deps, calls, lockState } = graph({
      writeGatewayDiscovery: async () => { calls.push("discovery"); throw new Error("discovery write failed"); },
    });
    await main(deps as never, control as never);
    assert.deepEqual(exits, [1]);
    assert.deepEqual(calls.filter(call => [
      "gateway.close", "host.dispose", "daemon.close", "clearDiscovery", "lock.release",
    ].includes(call)), ["gateway.close", "host.dispose", "daemon.close", "clearDiscovery", "lock.release"]);
    assert.equal(lockState(), 1);
  });

  it("continues startup cleanup when each cleanup step fails", async () => {
    const { control, exits } = processControl();
    const { deps, calls, lockState } = graph({
      writeGatewayDiscovery: async () => { calls.push("discovery"); throw new Error("discovery write failed"); },
      closeGateway: async () => { throw new Error("gateway close failed"); },
      disposeHost: async () => { throw new Error("host dispose failed"); },
      closeBoxExecDaemon: async () => { throw new Error("daemon close failed"); },
      clearGatewayDiscovery: async () => { calls.push("clearDiscovery"); throw new Error("discovery clear failed"); },
    });
    await main(deps as never, control as never);

    assert.deepEqual(exits, [1]);
    assert.deepEqual(calls.filter(call => [
      "gateway.close", "host.dispose", "daemon.close", "clearDiscovery", "lock.release",
    ].includes(call)), ["gateway.close", "host.dispose", "daemon.close", "clearDiscovery", "lock.release"]);
    assert.equal(calls.includes("crash:gateway_startup_cleanup"), true);
    assert.equal(calls.includes("crash:host_startup_cleanup"), true);
    assert.equal(calls.includes("crash:box_exec_daemon_startup_cleanup"), true);
    assert.equal(calls.includes("crash:gateway_discovery_startup_cleanup"), true);
    assert.equal(calls.filter(call => call === "flush").length, 2);
    assert.equal(lockState(), 1);
  });

  it("logs a failed box-ready report without leaving a rejected promise unhandled", async () => {
    const { control, exits, handlers } = processControl();
    const { deps, calls, errors } = graph({
      reportBoxReady: async () => { calls.push("boxReady"); throw new Error("telemetry unavailable"); },
    });
    await main(deps as never, control as never);
    await until(() => errors.length > 0);
    assert.deepEqual(exits, []);
    assert.equal(calls.includes("crash:fatal_startup"), false);
    assert.match(String(errors[0]?.[0]), /box-ready reporting failed/);
    handlers.get("SIGTERM")!();
    await until(() => exits.length > 0);
    assert.deepEqual(exits, [0]);
  });

  it("reports a box-exec daemon that also fails to close during startup cleanup", async () => {
    const { control, exits } = processControl();
    const { deps, calls } = graph({
      startHost: async () => { throw new Error("host failed"); },
      startBoxExecDaemon: async () => ({ close: async () => { throw new Error("close failed"); } }),
    });
    await main(deps as never, control as never);
    assert.deepEqual(exits, [1]);
    assert.equal(calls.includes("crash:box_exec_daemon_startup_cleanup"), true);
  });
});

// ---------------------------------------------------------------------------------------------
// shutdown
// ---------------------------------------------------------------------------------------------

function shutdownHarness(overrides: {
  gatewayClose?: () => Promise<void>;
  dispose?: () => Promise<void>;
  daemonClose?: () => Promise<void>;
  clearDiscovery?: () => Promise<void>;
  flush?: () => Promise<void>;
  releaseLock?: () => void;
  watchdogMs?: number;
  withDaemon?: boolean;
} = {}) {
  const calls: string[] = [];
  const logs: string[] = [];
  const exits: number[] = [];
  const handlers = new Map<string, () => void>();
  const host = {
    dispose: async () => { calls.push("host.dispose"); await overrides.dispose?.(); },
    reportProcessCrash: (error: unknown, kind: string) => { calls.push("crash:" + kind); void error; },
    flushTelemetryForFatalExit: async () => { calls.push("flush"); await overrides.flush?.(); },
  };
  const gateway = { close: async () => { calls.push("gateway.close"); await overrides.gatewayClose?.(); } };
  const lock = { release: () => { calls.push("lock.release"); overrides.releaseLock?.(); } };
  const daemon = overrides.withDaemon === false ? undefined : { close: async () => { calls.push("daemon.close"); await overrides.daemonClose?.(); } };
  const control = {
    argv: [], pid: 1,
    on: (signal: string, listener: () => void) => { handlers.set(signal, listener); },
    exit: (code: number) => { exits.push(code); },
  };
  const registration = installShutdownHandlers(host as never, gateway as never, lock as never, async () => { calls.push("clearDiscovery"); await overrides.clearDiscovery?.(); }, control as never, {
    log: (line: string) => logs.push(line),
    error: (...values: unknown[]) => logs.push(values.map(String).join(" ")),
  }, overrides.watchdogMs ?? SHUTDOWN_WATCHDOG_MS, daemon as never);
  return { calls, logs, exits, handlers, registration };
}

describe("shutdown", () => {
  it("closes in order, once, and exits zero", async () => {
    const harness = shutdownHarness();
    assert.deepEqual(Object.keys(harness.registration), ["shutdown"]);
    harness.registration.shutdown("SIGTERM");
    harness.registration.shutdown("SIGTERM");
    await until(() => harness.exits.length > 0);
    assert.deepEqual(harness.logs, ["[slate-host] received SIGTERM, shutting down"]);
    assert.deepEqual(harness.calls, ["gateway.close", "host.dispose", "daemon.close", "clearDiscovery", "lock.release"]);
    assert.deepEqual(harness.exits, [0]);
  });

  it("reports a failed shutdown step, flushes and still exits zero", async () => {
    for (const failing of ["gatewayClose", "dispose", "daemonClose", "clearDiscovery"] as const) {
      const harness = shutdownHarness({ [failing]: async () => { throw new Error("step failed"); } });
      harness.registration.shutdown("SIGINT");
      await until(() => harness.exits.length > 0);
      assert.equal(harness.calls.includes("crash:shutdown_error"), true, failing);
      assert.equal(harness.calls.includes("flush"), true, failing);
      assert.deepEqual(harness.exits, [0], failing);
      assert.equal(harness.calls.includes("lock.release"), true, failing);
      assert.deepEqual(harness.calls.filter(call => [
        "gateway.close", "host.dispose", "daemon.close", "clearDiscovery",
      ].includes(call)), ["gateway.close", "host.dispose", "daemon.close", "clearDiscovery"], failing);
    }
  });

  it("exits non-zero when it cannot release the host lock", async () => {
    const harness = shutdownHarness({ releaseLock: () => { throw new Error("lock release failed"); } });
    harness.registration.shutdown("SIGTERM");
    await until(() => harness.exits.length > 0);
    assert.deepEqual(harness.exits, [1]);
    assert.equal(harness.calls.includes("crash:shutdown_error"), true);
  });

  it("reports a shutdown that overruns its watchdog and exits non-zero", async () => {
    const harness = shutdownHarness({ gatewayClose: () => new Promise<void>(() => {}), watchdogMs: 5 });
    harness.registration.shutdown("SIGTERM");
    await until(() => harness.exits.length > 0);
    assert.deepEqual(harness.exits, [1]);
    assert.equal(harness.calls.includes("crash:shutdown_watchdog"), true);
    assert.equal(harness.calls.includes("flush"), true);
    assert.equal(harness.calls.includes("lock.release"), true);
  });

  it("releases the lock and exits when the watchdog telemetry flush also hangs", async () => {
    const harness = shutdownHarness({
      gatewayClose: () => new Promise<void>(() => {}),
      flush: () => new Promise<void>(() => {}),
      watchdogMs: 5,
    });
    harness.registration.shutdown("SIGTERM");
    await until(() => harness.exits.length > 0);
    assert.deepEqual(harness.exits, [1]);
    assert.equal(harness.calls.includes("crash:shutdown_watchdog"), true);
    assert.equal(harness.calls.includes("lock.release"), true);
  });
});

// ---------------------------------------------------------------------------------------------
// the lock line and the production graph
// ---------------------------------------------------------------------------------------------

describe("what the process says and what it is wired with", () => {
  it("says where the lock came from, and says nothing about a fresh one", () => {
    const lines: string[] = [];
    const log = { log: (line: string) => lines.push(line) };
    reportLockOutcome({ lock: { release: () => {} }, outcome: "took-over", previousPid: 7 } as never, "/tmp/slate-root", log);
    reportLockOutcome({ lock: { release: () => {} }, outcome: "stale", previousPid: 8 } as never, "/tmp/slate-root", log);
    reportLockOutcome({ lock: { release: () => {} }, outcome: "fresh" } as never, "/tmp/slate-root", log);
    assert.deepEqual(lines, [
      "[slate-host] took over /tmp/slate-root from live host pid 7",
      "[slate-host] reclaimed /tmp/slate-root lock (stale) from pid 8",
    ]);
  });

  it("wires the production graph, with the daemon owned by the process unless the deployment owns it", () => {
    const ports = { extensionsById: {}, extensionHost: { boxGenerated: {} }, runnerContext: {}, createTranscriptMirror: () => ({}), executeBoxCopyInFromEnv: async () => 0 } as never;
    const previous = process.env.SLATE_USE_EXISTING_BOX_EXEC_DAEMON;
    try {
      delete process.env.SLATE_USE_EXISTING_BOX_EXEC_DAEMON;
      const owned = createProductionHostMainDependencies(ports);
      assert.equal(typeof owned.startBoxExecDaemon, "function");
      assert.equal(Object.hasOwn(owned, "log"), false);
      const withLog = createProductionHostMainDependencies({ ...(ports as Record<string, unknown>), log: { log: () => {}, error: () => {} } } as never);
      assert.equal(Object.hasOwn(withLog, "log"), true);
      assert.deepEqual(Object.keys(withLog).slice(-2), ["log", "startBoxExecDaemon"], "the log and the daemon are the graph's last two optional parts");
      process.env.SLATE_USE_EXISTING_BOX_EXEC_DAEMON = "1";
      const existing = createProductionHostMainDependencies(ports);
      assert.equal(Object.hasOwn(existing, "startBoxExecDaemon"), false, "the deployment's own daemon is not started twice");
      process.env.SLATE_USE_EXISTING_BOX_EXEC_DAEMON = "0";
      assert.equal(typeof createProductionHostMainDependencies(ports).startBoxExecDaemon, "function");
    } finally {
      if (previous === undefined) delete process.env.SLATE_USE_EXISTING_BOX_EXEC_DAEMON;
      else process.env.SLATE_USE_EXISTING_BOX_EXEC_DAEMON = previous;
    }
  });
});
