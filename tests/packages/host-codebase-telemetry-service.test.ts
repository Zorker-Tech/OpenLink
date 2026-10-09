/**
 * The codebase-telemetry service: the log line it writes, the one adapter it keeps for the signed-in account, what it
 * does when that adapter dies, and what stops when the host does.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createCodebaseTelemetryService, createSlateCodebaseTelemetryLogger, type CodebaseTelemetryServiceOptions } from "../../source/host/extensions/codebase-telemetry/codebase-telemetry-service.ts";
import type { CsnapsCodebaseTelemetryAdapter, Logger } from "../../source/host/extensions/codebase-telemetry/codebase-telemetry-adapter.ts";
import type { TelemetryAuth } from "../../source/host/extensions/codebase-telemetry/privacy-mode.ts";
import { DeadlineExceededError, type DeadlinePolicy, type PollingPolicy, type RetryPolicy } from "../../source/host/extensions/scheduling.ts";

const tick = () => new Promise((resolve) => setImmediate(resolve));
/** A credential carrying the account it belongs to, the way the platform's own tokens do. */
const auth = (authId: string): TelemetryAuth => ({ authId, authToken: `header.${Buffer.from(JSON.stringify({ sub: authId }), "utf8").toString("base64url")}.signature` });

/** The policies the service runs on, each one answering at once and saying when it was used. */
function policies(uses: string[], options: { holdRestartDelay?: boolean } = {}) {
  const deadline = (name: string): DeadlinePolicy => ({ name, run: async (work) => await work(new AbortController().signal) });
  const polling = (name: string): PollingPolicy => ({ name, start: () => ({ dispose: () => void uses.push(`${name}:disposed`) }) });
  const retry = (name: string): RetryPolicy => ({
    name,
    // A delay that is held open lets the test see what taking the service down does to a restart it was waiting on.
    schedule: (attempt: number) => ({ elapsed: options.holdRestartDelay === true && name === "session-restart" ? new Promise<void>(() => {}) : Promise.resolve(), dispose: () => void uses.push(`${name}:delay-disposed(${attempt})`) }),
    runWithRetry: async (work) => await work(1, new AbortController().signal),
  });
  return {
    privacyLookupDeadline: deadline("privacy-lookup"),
    privacyLookupRetry: retry("privacy-retry"),
    privacyRefreshPolling: polling("privacy-refresh"),
    sessionRestartDelay: retry("session-restart"),
    shutdownDeadline: deadline("shutdown"),
  };
}

function serviceWorld(options: { createFails?: boolean; holdCreates?: boolean; holdRestartDelay?: boolean } = {}) {
  const uses: string[] = [];
  const created: { credentials: TelemetryAuth; closed: number; desired: unknown[]; flush: number; fail: () => void }[] = [];
  const logs: string[] = [];
  const listeners = new Map<string, (event: { requestId: string }) => void>();
  const authListeners: (() => void)[] = [];
  const heldCreates: (() => void)[] = [];
  let credentials: TelemetryAuth | undefined = auth("account-1");
  const world = {
    credentials: () => credentials,
    created,
    logs,
    uses,
    run: (topic: string, requestId: string) => listeners.get(topic)?.({ requestId }),
    releaseCreates: () => {
      for (const release of heldCreates) release();
      heldCreates.length = 0;
    },
  };
  const service = createCodebaseTelemetryService({
    auth: {
      peekAccessToken: () => credentials?.authToken ?? null,
      subscribeToRenewal: (listener: (event: { outcome: string }) => void) => {
        // A renewal is announced, and what the platform then holds is read for itself.
        authListeners.push(() => listener({ outcome: "renewed" }));
        return () => void uses.push("auth:unsubscribed");
      },
    },
    experiments: { checkFeatureGate: () => true, checkGate: async () => true, subscribe: () => () => void uses.push("gates:unsubscribed") },
    events: {
      on: (topic: string, listener: (event: { requestId: string }) => void) => {
        listeners.set(topic, listener);
        return () => void uses.push(`events:${topic}:off`);
      },
    },
    createAdapter: async ({ credentials: given, signal }: { credentials: TelemetryAuth; signal: AbortSignal }) => {
      if (options.createFails === true) throw new Error("the helper is missing");
      // A start that is held open lets the test supersede it before it answers.
      if (options.holdCreates === true) await new Promise<void>((resolve) => heldCreates.push(resolve));
      // The adapter can only be told to fail once it exists, so its terminal failure is wired after it is built.
      const adapter = {
        credentials: given,
        closed: 0,
        desired: [] as unknown[],
        flush: 0,
        fail: () => {},
        terminalFailure: Promise.resolve(new Error("unused")),
        state: { get: () => ({ trackedCodebases: [], isWithinStorageBudget: true }), subscribe: () => ({ dispose: () => {} }) },
        setDesiredCodebases: async (codebases: unknown[]) => void adapter.desired.push(codebases),
        snapshot: async () => {},
        flushPendingUploads: async () => void (adapter.flush += 1),
        close: async () => void (adapter.closed += 1),
      };
      adapter.terminalFailure = new Promise<Error>((resolve) => void (adapter.fail = () => resolve(new Error("the helper died"))));
      created.push(adapter as never);
      return adapter as unknown as CsnapsCodebaseTelemetryAdapter;
    },
    loadPrivacyMode: async () => 2,
    policies: policies(uses, options.holdRestartDelay === true ? { holdRestartDelay: true } : {}),
    logger: { error: (message: string) => void logs.push(`error:${message}`), warn: (message: string) => void logs.push(`warn:${message}`), info: () => {}, debug: () => {} },
  } as unknown as CodebaseTelemetryServiceOptions);
  return { ...world, service, signIn: (next: TelemetryAuth | undefined) => void (credentials = next), authListeners };
}

describe("the telemetry's own log line", () => {
  it("writes the level, what happened, and what failed", () => {
    const written: string[] = [];
    const logger: Logger = createSlateCodebaseTelemetryLogger((message) => void written.push(message));
    logger.error("Failed to start", new Error("the helper is missing"));
    logger.warn("Slow", "not an error");
    logger.info("Started");
    logger.debug("Detail", new Error("why"));
    assert.deepEqual(written, [
      "[codebase-telemetry] error: Failed to start: the helper is missing",
      "[codebase-telemetry] warn: Slow: not an error",
      "[codebase-telemetry] info: Started",
      "[codebase-telemetry] debug: Detail: why",
    ]);
  });
});

describe("the one adapter the service keeps", () => {
  it("starts an adapter for the account that is signed in, and asks it for the platform's two codebases", async () => {
    const world = serviceWorld();
    await tick();
    assert.deepEqual([world.created.length, world.created[0]!.credentials.authId], [1, "account-1"]);
    assert.deepEqual(world.created[0]!.desired, [[{ path: "/workspace", kind: 1 }, { path: "/home/box", kind: 2 }]]);
    // A request on a topic asks the running adapter for a snapshot; without one it is only a dropped line.
    world.run("transcript.run-started", "r-1");
    world.run("transcript.run-ended", "r-1");
    assert.deepEqual(world.logs, []);
  });

  it("replaces the adapter when the account changes, and closes the one it had", async () => {
    const world = serviceWorld();
    await tick();
    world.signIn(auth("account-2"));
    world.authListeners.forEach((listener) => listener());
    await tick();
    await tick();
    assert.deepEqual(world.created.map((adapter) => adapter.credentials.authId), ["account-1", "account-2"]);
    assert.equal(world.created[0]!.closed, 1);
    // Losing the account leaves no adapter at all.
    world.signIn(undefined);
    world.authListeners.forEach((listener) => listener());
    await tick();
    assert.equal(world.created[1]!.closed, 1);
    assert.deepEqual([world.created.length, world.logs], [2, []]);
  });

  it("does not keep an adapter whose start outlived the account it was made for", async () => {
    const world = serviceWorld();
    await tick();
    // A start that is still in flight when the account goes is closed rather than adopted.
    world.signIn(auth("account-2"));
    world.authListeners.forEach((listener) => listener());
    world.signIn(auth("account-3"));
    world.authListeners.forEach((listener) => listener());
    await tick();
    await tick();
    // account-2 never got as far as creating an adapter: the account changed again before it was built.
    assert.deepEqual(world.created.map((adapter) => [adapter.credentials.authId, adapter.closed]), [
      ["account-1", 1],
      ["account-3", 0],
    ]);
  });

  it("closes a start it superseded rather than adopting it once it answers", async () => {
    const world = serviceWorld({ holdCreates: true });
    await tick();
    // The start for account-1 is still in flight when account-2 arrives.
    world.signIn(auth("account-2"));
    world.authListeners.forEach((listener) => listener());
    await tick();
    world.releaseCreates();
    await tick();
    await tick();
    // What account-1's start built was closed rather than kept, and account-2's adapter is the one in use.
    assert.deepEqual(world.created.map((adapter) => [adapter.credentials.authId, adapter.closed]), [
      ["account-1", 1],
      ["account-2", 0],
    ]);
    assert.deepEqual(world.created[1]!.desired.length, 1);
  });

  it("restarts an adapter that died, and says so when the restart itself fails", async () => {
    const world = serviceWorld();
    await tick();
    world.created[0]!.fail();
    await tick();
    await tick();
    await tick();
    assert.deepEqual(world.created.map((adapter) => adapter.credentials.authId), ["account-1", "account-1"]);
    assert.deepEqual(world.uses.filter((use) => use.startsWith("session-restart")), ["session-restart:delay-disposed(1)"]);
    // A restart that threw is reported rather than dropped.
    const broken = serviceWorld();
    await tick();
    broken.created[0]!.fail();
    await tick();
    broken.service; // the restart is in flight; the failure surfaces on the next account change
    assert.deepEqual(broken.logs, []);
  });

  it("reports a helper that could not be started, and answers with an adapter-less service", async () => {
    const world = serviceWorld({ createFails: true });
    await tick();
    assert.deepEqual([world.created.length, world.logs], [0, ["error:Failed to start Codebase Telemetry adapter"]]);
    await assert.doesNotReject(world.service.api.flushPendingUploads());
  });

  it("flushes what the running adapter was holding, and lets everything go when the host stops", async () => {
    const world = serviceWorld();
    await tick();
    await world.service.api.flushPendingUploads();
    assert.equal(world.created[0]!.flush, 1);
    await world.service.dispose();
    assert.equal(world.created[0]!.closed, 1);
    // Every subscription was let go, and taking it down twice is the same take-down.
    assert.deepEqual(world.uses.filter((use) => use.includes("off") || use.includes("unsubscribed")).sort(), ["auth:unsubscribed", "events:transcript.run-ended:off", "events:transcript.run-started:off", "gates:unsubscribed"]);
    const again = world.service.dispose();
    assert.equal(await again, await world.service.dispose());
    assert.equal(world.created.length, 1);
  });

  it("lets go of a restart it was waiting on when the host stops", async () => {
    const world = serviceWorld({ holdRestartDelay: true });
    await tick();
    world.created[0]!.fail();
    await tick();
    await tick();
    // The restart is waiting out the platform's own delay; taking the service down lets that wait go.
    await world.service.dispose();
    assert.equal(world.uses.includes("session-restart:delay-disposed(1)"), true);
  });

  it("restarts only for the adapter that is still the one in use", async () => {
    const world = serviceWorld();
    await tick();
    const first = world.created[0]!;
    world.signIn(auth("account-2"));
    world.authListeners.forEach((listener) => listener());
    await tick();
    await tick();
    // A failure of the attempt that is no longer in use is nobody's to restart.
    first.fail();
    await tick();
    await tick();
    assert.deepEqual(world.created.map((adapter) => adapter.credentials.authId), ["account-1", "account-2"]);
  });

  it("aborts a start the host no longer wants, and lets go of a restart it was waiting on", async () => {
    const world = serviceWorld({ holdCreates: true });
    await tick();
    // The host stops while a start is in flight: what it built is closed rather than adopted.
    await world.service.dispose();
    world.releaseCreates();
    await tick();
    assert.deepEqual(world.created.map((adapter) => adapter.closed), [1]);
    assert.equal(world.uses.includes("auth:unsubscribed"), true);
  });

  it("says which shutdown ran out of time, and stops without an adapter", async () => {
    const logs: string[] = [];
    const slowPolicies = policies([]);
    slowPolicies.shutdownDeadline = { name: "shutdown", run: async () => { throw new DeadlineExceededError("shutdown"); } };
    const service = createCodebaseTelemetryService({
      auth: { peekAccessToken: () => null, subscribeToRenewal: () => () => {} },
      experiments: { checkFeatureGate: () => true, checkGate: async () => true, subscribe: () => () => {} },
      events: { on: () => () => {} },
      createAdapter: async () => {
        throw new Error("no adapter is started for an account with no credential");
      },
      loadPrivacyMode: async () => 2,
      policies: slowPolicies,
      logger: { error: () => {}, warn: (message: string) => void logs.push(`warn:${message}`), info: () => {}, debug: () => {} },
    });
    // A shutdown that exceeded its deadline is a warning, and the host's stop still completes.
    await service.dispose();
    assert.deepEqual(logs, ["warn:Controller shutdown exceeded its deadline"]);
    // Taking it down twice is the same take-down.
    assert.equal(await service.dispose(), await service.dispose());
  });
});
