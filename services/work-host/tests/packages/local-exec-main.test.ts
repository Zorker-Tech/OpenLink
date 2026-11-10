import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  composeLocalExecDaemonOptions,
  holdLocalExecDaemonProcessOpen,
  LOCAL_EXEC_DAEMON_LIFETIME_TICK_MS,
  LOCAL_EXEC_DAEMON_SHUTDOWN_TIMEOUT_MS,
  runLocalExecDaemonEntrypoint,
  reportLocalExecDaemonFatal,
  runLocalExecDaemonMain,
  type LocalExecDaemonMainDeps,
} from "../../source/local-exec/main.ts";
import type { DeadlinePolicy } from "../../source/host/extensions/scheduling.ts";
import type { RunLocalExecDaemonOptions } from "../../source/host/local-exec/local-exec-daemon.ts";
import { LOCAL_EXEC_IDENTITY_ARGUMENT_PREFIX, LOCAL_EXEC_IDENTITY_ENV_KEY } from "../../source/shared/local-exec-process-identity.ts";
import {
  loadDaemonCrashReporterRuntime,
  type DaemonCrashReporterRuntime,
} from "../../source/adapters/interop/telemetry/local-exec-crash-reporter-adapter.ts";

type Signal = "SIGTERM" | "SIGINT";

function processStub() {
  const listeners = new Map<Signal, () => void>();
  const exits: number[] = [];
  const processLike = {
    pid: 127,
    on(event: Signal, listener: () => void) {
      listeners.set(event, listener);
      return this;
    },
    exit(status: number) {
      exits.push(status);
      return undefined;
    },
  } as unknown as NonNullable<LocalExecDaemonMainDeps["process"]>;

  return {
    process: processLike,
    exits,
    signal(signal: Signal) {
      listeners.get(signal)?.();
    },
  };
}

function lifecycleHarness(overrides: Partial<LocalExecDaemonMainDeps> = {}) {
  const events: string[] = [];
  const messages: string[] = [];
  const guardScopes: string[] = [];
  const fakeProcess = processStub();
  const noTimeout: DeadlinePolicy = {
    name: "test shutdown",
    async run<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
      events.push("deadline");
      return work(new AbortController().signal);
    },
  };
  const installInvariantReporter = (() => {
    events.push("invariant reporter");
    return () => {};
  }) as NonNullable<LocalExecDaemonMainDeps["installInvariantReporter"]>;
  const installCrashGuards = ((options: { scope: string }) => {
    guardScopes.push(options.scope);
    events.push("crash guards");
    return {
      setReporter(reporter) {
        if (reporter !== undefined) events.push("crash reporter attached");
      },
    };
  }) as NonNullable<LocalExecDaemonMainDeps["installCrashGuards"]>;
  const deps: LocalExecDaemonMainDeps = {
    runDaemon: async () => ({
      async close() {
        events.push("daemon closed");
      },
    }),
    initCrashReporter: () => {
      events.push("crash reporter initialized");
      return () => {};
    },
    process: fakeProcess.process,
    log: (message) => messages.push(message),
    holdProcessOpen: () => ({ release: () => events.push("lifetime released") }),
    shutdownDeadline: noTimeout,
    installInvariantReporter,
    installCrashGuards,
    ...overrides,
  };

  return { deps, events, messages, guardScopes, ...fakeProcess };
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("the local-exec daemon process lifetime", () => {
  it("keeps a referenced handle until release and clears it once", () => {
    assert.equal(LOCAL_EXEC_DAEMON_LIFETIME_TICK_MS, 60_000);
    assert.equal(LOCAL_EXEC_DAEMON_SHUTDOWN_TIMEOUT_MS, 2_000);
    let refCalls = 0;
    let clearCalls = 0;
    const handle = { ref: () => { refCalls += 1; } } as unknown as ReturnType<typeof setInterval>;
    const setIntervalStub = ((...args: unknown[]) => {
      assert.equal(args[1], 60_000);
      return handle;
    }) as unknown as typeof setInterval;
    const lifetime = holdLocalExecDaemonProcessOpen(
      setIntervalStub,
      (cleared) => {
        assert.equal(cleared, handle);
        clearCalls += 1;
      },
    );

    assert.equal(refCalls, 1);
    lifetime.release();
    lifetime.release();
    assert.equal(clearCalls, 1);
  });

  it("starts the daemon and handles repeated shutdown signals only once", async () => {
    const daemonOptions = { executor: {} } as RunLocalExecDaemonOptions;
    let closeCalls = 0;
    let receivedOptions: RunLocalExecDaemonOptions | undefined;
    const state = lifecycleHarness({
      daemonOptions,
      runDaemon: async (options) => {
        receivedOptions = options;
        return {
          async close() {
            closeCalls += 1;
            state.events.push("daemon closed");
          },
        };
      },
    });

    const service = await runLocalExecDaemonMain(state.deps);
    assert.equal(receivedOptions, daemonOptions);
    assert.deepEqual(state.guardScopes, ["slate-local-exec-daemon"]);
    assert.deepEqual(state.messages, ["[slate-local-exec-daemon] started (pid 127); serving local exec over the gateway"]);
    assert.deepEqual(state.events.slice(0, 4), [
      "invariant reporter",
      "crash guards",
      "crash reporter initialized",
      "crash reporter attached",
    ]);

    service.shutdown("SIGTERM");
    service.shutdown("SIGINT");
    state.signal("SIGTERM");
    await nextTurn();

    assert.equal(closeCalls, 1);
    assert.equal(state.events.filter((event) => event === "deadline").length, 1);
    assert.equal(state.events.filter((event) => event === "lifetime released").length, 1);
    assert.deepEqual(state.exits, [0]);
  });

  it("remembers the first signal received during startup and drains as soon as startup resolves", async () => {
    let resolveStartup!: (daemon: { close(): Promise<void> }) => void;
    let closeCalls = 0;
    const state = lifecycleHarness({
      runDaemon: () => new Promise((resolve) => { resolveStartup = resolve; }),
    });

    const startup = runLocalExecDaemonMain(state.deps);
    state.signal("SIGINT");
    state.signal("SIGTERM");
    assert.deepEqual(state.messages, [
      "[slate-local-exec-daemon] received SIGINT during startup; shutdown queued",
      "[slate-local-exec-daemon] received SIGTERM during startup; shutdown queued",
    ]);

    resolveStartup({
      async close() {
        closeCalls += 1;
      },
    });
    const service = await startup;
    assert.equal(typeof service.shutdown, "function");
    await nextTurn();

    assert.equal(closeCalls, 1);
    assert.equal(state.messages.some((message) => message.includes("started (pid")), false);
    assert.equal(state.messages.includes("[slate-local-exec-daemon] received SIGINT, shutting down"), true);
    assert.equal(state.messages.includes("[slate-local-exec-daemon] received SIGTERM, shutting down"), false);
    assert.deepEqual(state.exits, [0]);
  });

  it("releases its keepalive and propagates a daemon startup failure", async () => {
    const failure = new Error("daemon startup failed");
    const state = lifecycleHarness({ runDaemon: async () => { throw failure; } });

    await assert.rejects(runLocalExecDaemonMain(state.deps), (error) => error === failure);

    assert.equal(state.events.filter((event) => event === "lifetime released").length, 1);
    assert.equal(state.events.includes("daemon closed"), false);
    assert.deepEqual(state.exits, []);
  });
});

describe("the local-exec daemon's supporting boundaries", () => {
  it("only creates a production executor when options do not already contain one", () => {
    const executorOptions = { executor: {} } as RunLocalExecDaemonOptions;
    let factoryCalls = 0;
    const madeExecutor = {} as NonNullable<RunLocalExecDaemonOptions["executor"]>;
    const factory = () => {
      factoryCalls += 1;
      return madeExecutor;
    };

    assert.equal(composeLocalExecDaemonOptions(executorOptions, factory), executorOptions);
    assert.equal(factoryCalls, 0);
    assert.equal(composeLocalExecDaemonOptions(undefined, undefined), undefined);
    const plainOptions = {} as RunLocalExecDaemonOptions;
    assert.equal(composeLocalExecDaemonOptions(plainOptions, undefined), plainOptions);

    const options = composeLocalExecDaemonOptions({}, factory);
    assert.notEqual(options, undefined);
    assert.equal(options?.executor, madeExecutor);
    assert.equal(factoryCalls, 1);
  });

  it("accepts a complete crash reporter runtime and ignores missing or failed modules", () => {
    const runtime = {
      init() {},
      captureException() {},
      async flush() { return true; },
      makeNodeTransport() { return { async send() {} }; },
    };

    let requestedModule: string | undefined;
    assert.equal(loadDaemonCrashReporterRuntime((name) => {
      requestedModule = name;
      return runtime;
    }), runtime);
    assert.equal(requestedModule, "@sentry/node");
    assert.equal(loadDaemonCrashReporterRuntime(() => ({ init() {}, captureException() {}, flush() {} })), undefined);
    assert.equal(loadDaemonCrashReporterRuntime(() => { throw new Error("module unavailable"); }), undefined);
  });

  it("reports fatal errors, flushes the reporter, then exits with failure", async () => {
    const events: string[] = [];
    let crash: { error: Error; kind: string } | undefined;
    const process = {
      pid: 8,
      on() { return this; },
      exit(status: number) { events.push(`exit:${status}`); return undefined; },
    } as unknown as NonNullable<LocalExecDaemonMainDeps["process"]>;

    await assert.rejects(reportLocalExecDaemonFatal({
      process,
      initCrashReporter: () => (error, kind) => { crash = { error, kind }; },
      flushCrashReporter: async (timeoutMs) => {
        events.push(`flush:${timeoutMs}`);
        return false;
      },
    }, "fatal reason"), /process\.exit returned unexpectedly/);

    assert.equal(crash?.error.message, "fatal reason");
    assert.equal(crash?.kind, "fatal");
    assert.deepEqual(events, ["flush:1500", "exit:1"]);
  });

  it("still exits after the fatal report flush rejects", async () => {
    const exits: number[] = [];
    const process = {
      pid: 8,
      on() { return this; },
      exit(status: number) { exits.push(status); return undefined; },
    } as unknown as NonNullable<LocalExecDaemonMainDeps["process"]>;

    await assert.rejects(reportLocalExecDaemonFatal({
      process,
      flushCrashReporter: async () => { throw new Error("flush failed"); },
    }, new Error("fatal reason")), /process\.exit returned unexpectedly/);

    assert.deepEqual(exits, [1]);
  });

  it("refuses to start when the process argument is not bound to its environment token", async () => {
    const savedArgv = process.argv;
    const savedGeneration = process.env[LOCAL_EXEC_IDENTITY_ENV_KEY];
    const savedSentryEnvironment = process.env.SLATE_SENTRY_ENVIRONMENT;
    const savedSentryRelease = process.env.SLATE_SENTRY_RELEASE;
    const fakeProcess = processStub();
    const captured: string[] = [];
    const crashReporterRuntime = {
      init() {},
      eventFiltersIntegration() { return {}; },
      functionToStringIntegration() { return {}; },
      linkedErrorsIntegration() { return {}; },
      dedupeIntegration() { return {}; },
      makeNodeTransport() { return { async send() {} }; },
      setTag() {},
      captureException(error: Error) { captured.push(error.message); },
      async flush(timeoutMs: number) {
        captured.push(`flush:${timeoutMs}`);
        return true;
      },
    } as unknown as DaemonCrashReporterRuntime;

    try {
      process.argv = [process.execPath, new URL(import.meta.url).pathname, `${LOCAL_EXEC_IDENTITY_ARGUMENT_PREFIX}wrong`];
      process.env[LOCAL_EXEC_IDENTITY_ENV_KEY] = "expected";
      process.env.SLATE_SENTRY_ENVIRONMENT = "test";
      process.env.SLATE_SENTRY_RELEASE = "local-exec-main-test";

      await assert.rejects(runLocalExecDaemonEntrypoint({
        daemonOptions: { executor: {} as NonNullable<RunLocalExecDaemonOptions["executor"]> },
        crashReporterRuntime,
        process: fakeProcess.process,
      }), /process\.exit returned unexpectedly/);
    } finally {
      process.argv = savedArgv;
      if (savedGeneration === undefined) delete process.env[LOCAL_EXEC_IDENTITY_ENV_KEY];
      else process.env[LOCAL_EXEC_IDENTITY_ENV_KEY] = savedGeneration;
      if (savedSentryEnvironment === undefined) delete process.env.SLATE_SENTRY_ENVIRONMENT;
      else process.env.SLATE_SENTRY_ENVIRONMENT = savedSentryEnvironment;
      if (savedSentryRelease === undefined) delete process.env.SLATE_SENTRY_RELEASE;
      else process.env.SLATE_SENTRY_RELEASE = savedSentryRelease;
    }

    assert.deepEqual(fakeProcess.exits, [1]);
    assert.deepEqual(captured, ["local-exec daemon entry identity is not bound", "flush:1500"]);
  });
});
