/**
 * The codebase-telemetry host and the adapter in front of its helper: the account and the gate the host follows, the
 * two codebases it always asks for, and the adapter that republishes what the helper tracks — fails when the helper
 * fails, and closes over the polling and the credential lookups it started.
 */

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  CodebaseKind,
  CodebaseTelemetryFeatureGate,
  createAuthSource,
  createFeatureGateSource,
  createSlateCodebaseTelemetryHost,
  SLATE_BOX_HOME_DIR,
  SLATE_BOX_WORKSPACE_ROOT,
  SLATE_CODEBASE_TELEMETRY_FEATURE_GATE,
} from "../../source/host/extensions/codebase-telemetry/codebase-telemetry-host.ts";
import {
  CodebaseEnvironment,
  CsnapsAdapterError,
  CsnapsCodebaseTelemetryAdapter,
  toAdapterState,
  toCodebase,
  type CsnapsHandle,
  type CsnapsState,
} from "../../source/host/extensions/codebase-telemetry/codebase-telemetry-adapter.ts";
import { csnapsAvailability } from "../../source/host/extensions/codebase-telemetry/csnaps-capability.ts";
import type { Clock } from "../../source/host/extensions/scheduling.ts";

/** A scratch directory the capability check can look at. */
const scratch = mkdtempSync(join(tmpdir(), "slate-csnaps-capability-"));

/** A credential carrying the account it belongs to, the way the platform's own tokens do. */
function tokenWithPayload(payload: unknown): string {
  return `header.${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}.signature`;
}

const tokenFor = (principal: string) => tokenWithPayload({ sub: principal });

function authWorld(options: { token?: string | null } = {}) {
  let peeked = options.token === undefined ? tokenFor("account-1") : options.token;
  const renewals: ((event: { outcome: string }) => void)[] = [];
  const published: { authId: string; authToken: string }[] = [];
  const logged: string[] = [];
  let unsubscribed = 0;
  let cleared = 0;
  const source = createAuthSource({
    auth: {
      peekAccessToken: () => peeked,
      subscribeToRenewal: (listener) => {
        renewals.push(listener);
        return () => {
          unsubscribed += 1;
          renewals.splice(renewals.indexOf(listener), 1);
        };
      },
    },
    logger: { warn: (message) => void logged.push(message), error: (message) => void logged.push(message) },
    privacyMode: { setAuth: (next) => void published.push(next), clearAuth: () => void (cleared += 1) },
  });
  return {
    source,
    published,
    logged,
    signIn: (token: string | null) => void (peeked = token),
    renew: (outcome: string) => {
      for (const listener of renewals) listener({ outcome });
    },
    get cleared() {
      return cleared;
    },
    get unsubscribed() {
      return unsubscribed;
    },
  };
}

function gateWorld(options: { gate?: boolean } = {}) {
  let gate = options.gate ?? false;
  const readings: string[] = [];
  const subscriptions: (() => void)[] = [];
  const checks: string[] = [];
  const logged: string[] = [];
  let unsubscribed = 0;
  const source = createFeatureGateSource({
    experiments: {
      checkFeatureGate: (name) => {
        readings.push(name);
        return gate;
      },
      checkGate: async (name) => {
        checks.push(name);
        return true;
      },
      subscribe: (listener) => {
        subscriptions.push(listener);
        return () => void (unsubscribed += 1);
      },
    },
    logger: { error: (message) => void logged.push(message) },
  });
  return {
    source,
    readings,
    checks,
    logged,
    setGate: (value: boolean) => void (gate = value),
    change: () => {
      for (const listener of subscriptions) listener();
    },
    get unsubscribed() {
      return unsubscribed;
    },
  };
}

const homeOf = (): CsnapsState => ({ tracked: [] });
const tracked = (codebaseUuid: string, path: string, kind: number = CodebaseKind.WORKSPACE_ROOT): CsnapsState["tracked"][number] => ({
  codebaseUuid,
  path,
  kind,
  environment: CodebaseEnvironment.SLATE_BOX,
});

function csnapsHandle(options: { initialState?: CsnapsState; rejected?: readonly unknown[]; failClose?: boolean } = {}) {
  const calls: string[] = [];
  const uploads: Record<string, unknown>[] = [];
  const flushes: Record<string, unknown>[] = [];
  const snapshots: unknown[] = [];
  const terminal = Promise.withResolvers<Error>();
  const state = options.initialState ?? homeOf();
  const handle: CsnapsHandle = {
    terminalFailure: terminal.promise,
    applyCodebaseSpecs: async (codebases) => {
      calls.push("applyCodebaseSpecs");
      return { state, rejected: options.rejected ?? [] };
    },
    snapshot: async (reason) => {
      calls.push("snapshot");
      snapshots.push(reason);
    },
    triggerUpload: async (credentials) => {
      calls.push("triggerUpload");
      uploads.push(credentials);
    },
    flushPendingUploads: async (credentials) => {
      calls.push("flushPendingUploads");
      flushes.push(credentials);
    },
    close: async () => {
      calls.push("close");
      if (options.failClose === true) throw new Error("the helper would not close");
    },
  };
  return { handle, calls, uploads, flushes, snapshots, fail: (error: Error) => terminal.resolve(error) };
}

async function adapterWorld(
  options: { initialState?: CsnapsState; rejected?: readonly unknown[]; signal?: AbortSignal; failClose?: boolean; failPollingDispose?: boolean; clock?: Clock } = {},
) {
  const csnaps = csnapsHandle(options);
  const spawned: { executablePath: string; initializeParams: Record<string, unknown>; deadlines: { name: string }[]; hasSignal: boolean; signal?: AbortSignal }[] = [];
  const ticks: (() => Promise<void>)[] = [];
  const logged: string[] = [];
  let pollingDisposed = 0;
  let credentials = 0;
  let failCredentials = false;
  let beforeCredentialReturn: (() => void) | undefined;
  const adapter = await CsnapsCodebaseTelemetryAdapter.create({
    credentials: { authId: "account-1" },
    paths: { codebaseUuidStatePath: "/state/codebases.json", snapshotsBaseDir: "/state/snapshots" },
    backendUrl: "https://backend.test",
    csnapsBinPath: "/opt/slate/csnaps",
    spawnCsnaps: (async (given: { executablePath: string; initializeParams: Record<string, unknown>; deadlines: Record<string, { name: string }>; signal?: AbortSignal }) => {
      spawned.push({ executablePath: given.executablePath, initializeParams: given.initializeParams, deadlines: Object.values(given.deadlines), hasSignal: "signal" in given, ...(given.signal === undefined ? {} : { signal: given.signal }) });
      return { handle: csnaps.handle, initialState: options.initialState ?? homeOf() };
    }) as never,
    uploadPolling: {
      name: "csnaps-upload-polling",
      start: (tick: () => Promise<void>) => {
        ticks.push(tick);
        return {
          dispose: () => {
            pollingDisposed += 1;
            if (options.failPollingDispose === true) throw new Error("polling would not stop");
          },
        };
      },
    },
    createUploadCredentials: async () => {
      credentials += 1;
      beforeCredentialReturn?.();
      if (failCredentials) throw new Error("no upload credentials today");
      return { token: `upload-${credentials}` };
    },
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    logger: { error: (message) => void logged.push(message), warn: (message) => void logged.push(message), info: () => {}, debug: () => {} },
  });
  return {
    adapter,
    csnaps,
    spawned,
    ticks,
    logged,
    get pollingDisposed() {
      return pollingDisposed;
    },
    get credentials() {
      return credentials;
    },
    setFailCredentials: (value: boolean) => void (failCredentials = value),
    beforeCredentialReturn: (work: () => void) => void (beforeCredentialReturn = work),
  };
}

describe("the account the telemetry follows", () => {
  it("publishes the credential it was handed, republishes a renewed one, and clears what is no longer there", () => {
    const world = authWorld();
    assert.deepEqual(world.published, [{ authId: "account-1", authToken: tokenFor("account-1") }]);
    assert.equal(world.source.receiver.get()?.authId, "account-1");
    // The same credential seen again is not published a second time.
    world.renew("renewed");
    assert.equal(world.published.length, 1);
    // A credential that is the same account but a new token is published again: the token is what a reader needs.
    const rotated = `${tokenFor("account-1")}rotated`;
    world.signIn(rotated);
    world.renew("renewed");
    assert.deepEqual(world.published.map((entry) => entry.authToken), [tokenFor("account-1"), rotated]);
    // A renewal that is not a renewal matters only when there is nothing left to hand over.
    world.renew("failed");
    assert.deepEqual([world.published.length, world.cleared], [2, 0]);
    world.signIn(null);
    world.renew("failed");
    assert.deepEqual([world.cleared, world.source.receiver.get()], [1, undefined]);
    // With no credential at all, nothing was ever handed to the privacy mode, so nothing is cleared.
    const empty = authWorld({ token: null });
    assert.deepEqual([empty.published.length, empty.cleared, empty.source.receiver.get()], [0, 0, undefined]);
  });

  it("refuses a credential whose subject claim it cannot use, and says so", () => {
    const world = authWorld();
    const unusable = ["not-a-jwt", tokenWithPayload({}), tokenWithPayload({ sub: 7 }), tokenWithPayload({ sub: "" }), `header.!!!.signature`];
    for (const token of unusable) {
      world.signIn(token);
      world.renew("renewed");
    }
    assert.equal(world.published.length, 1);
    assert.deepEqual([world.cleared, world.source.receiver.get()], [1, undefined]);
    assert.deepEqual(new Set(world.logged), new Set(["Credential has no usable subject claim"]));
    assert.equal(world.logged.length, unusable.length);
    // Once disposed it stops listening: nothing is published or cleared again.
    const disposed = authWorld();
    disposed.source.dispose();
    disposed.signIn(tokenFor("account-9"));
    disposed.renew("renewed");
    assert.deepEqual([disposed.unsubscribed, disposed.published.length], [1, 1]);
  });

  it("reads the gate it was created with, tells subscribers when the reading changed, and answers for its own gate only", async () => {
    const world = gateWorld();
    assert.deepEqual(world.readings, [SLATE_CODEBASE_TELEMETRY_FEATURE_GATE]);
    assert.equal(SLATE_CODEBASE_TELEMETRY_FEATURE_GATE, "slate_codebase_telemetry");
    const seen: { kind: string; gates: readonly string[] }[] = [];
    const throwing = world.source.receiver.changes.subscribe(() => {
      throw new Error("a subscriber that cannot listen");
    });
    world.source.receiver.changes.subscribe((value) => void seen.push(value));
    // A reading that did not change tells no one.
    world.change();
    assert.deepEqual(seen, []);
    assert.deepEqual(world.logged, []);
    world.setGate(true);
    world.change();
    assert.deepEqual(seen, [{ kind: "some", gates: [CodebaseTelemetryFeatureGate.MAIN] }]);
    assert.equal(CodebaseTelemetryFeatureGate.MAIN, "main");
    // The throwing subscriber is the one that failed, and the other one still heard.
    assert.deepEqual(world.logged, ["Feature gate subscriber failed"]);
    assert.equal(await world.source.receiver.check(CodebaseTelemetryFeatureGate.MAIN), true);
    assert.deepEqual(world.checks, [SLATE_CODEBASE_TELEMETRY_FEATURE_GATE]);
    assert.deepEqual(await world.source.receiver.check(CodebaseTelemetryFeatureGate.GIT_HISTORY), false);
    assert.deepEqual(world.checks, [SLATE_CODEBASE_TELEMETRY_FEATURE_GATE]);
    // A subscriber that stopped listening, and a source that was disposed, hear nothing more.
    throwing.dispose();
    world.source.dispose();
    world.change();
    assert.deepEqual(seen.length, 1);
    assert.equal(world.unsubscribed, 1);
  });

  it("wires the account, the gate and the two codebases the platform's own computer always has", () => {
    const published: { authId: string; authToken: string }[] = [];
    const unsubscribed: string[] = [];
    const logger = { warn: () => {}, error: () => {} };
    const privacyReceiver = { get: () => undefined, subscribe: () => ({ dispose: () => {} }) };
    const createAdapter = async () => "adapter";
    const host = createSlateCodebaseTelemetryHost({
      auth: { peekAccessToken: () => tokenFor("account-1"), subscribeToRenewal: () => () => void unsubscribed.push("renewal") },
      experiments: { checkFeatureGate: () => true, checkGate: async () => true, subscribe: () => () => void unsubscribed.push("gate") },
      privacyMode: { receiver: privacyReceiver, setAuth: (next) => void published.push(next), clearAuth: () => {} },
      createAdapter,
      logger,
    });
    assert.equal(host.logger, logger);
    assert.equal(host.createAdapter, createAdapter);
    assert.equal(host.privacyMode, privacyReceiver);
    assert.deepEqual(host.desiredCodebases.get(), [
      { path: SLATE_BOX_WORKSPACE_ROOT, kind: CodebaseKind.WORKSPACE_ROOT },
      { path: SLATE_BOX_HOME_DIR, kind: CodebaseKind.HOME_DIRECTORY },
    ]);
    assert.deepEqual([SLATE_BOX_WORKSPACE_ROOT, SLATE_BOX_HOME_DIR], ["/workspace", "/home/box"]);
    assert.deepEqual(host.desiredCodebases.changes.subscribe().dispose(), undefined);
    // The account is followed from the first token on.
    assert.deepEqual(published, [{ authId: "account-1", authToken: tokenFor("account-1") }]);
    // Disposing takes the wiring with it: the account and the gate are no longer followed.
    host.dispose();
    assert.deepEqual(unsubscribed, ["renewal", "gate"]);
  });
});

describe("the adapter in front of the helper", () => {  it("starts the helper with the account, the paths and the deadlines it was given", async () => {
    const signal = new AbortController().signal;
    const world = await adapterWorld({ signal, initialState: { tracked: [tracked("cb-1", "/workspace")] } });
    const given = world.spawned[0]!;
    assert.equal(given.executablePath, "/opt/slate/csnaps");
    assert.deepEqual(given.initializeParams, {
      authId: "account-1",
      codebaseUuidStatePath: "/state/codebases.json",
      snapshotsBaseDir: "/state/snapshots",
      environment: CodebaseEnvironment.SLATE_BOX,
      backendUrl: "https://backend.test",
    });
    assert.equal(CodebaseEnvironment.SLATE_BOX, 1);
    assert.equal(given.hasSignal, true);
    assert.equal(given.signal, signal);
    assert.deepEqual(given.deadlines.map((deadline) => deadline.name), [
      "csnaps-ping",
      "csnaps-initialize",
      "csnaps-apply-codebase-specs",
      "csnaps-snapshot",
      "csnaps-trigger-upload",
      "csnaps-flush-pending-uploads",
      "csnaps-shutdown",
      "csnaps-exit",
    ]);
    // What the helper already tracks is the adapter's state from the start.
    assert.deepEqual(world.adapter.state.get(), {
      trackedCodebases: [{ codebaseUuid: "cb-1", authId: "account-1", path: "/workspace", kind: 1, environment: 1 }],
      isWithinStorageBudget: true,
    });
    // A start that was not given a signal does not make one up.
    const withoutSignal = await adapterWorld();
    assert.equal(withoutSignal.spawned[0]!.hasSignal, false);
    assert.deepEqual(withoutSignal.adapter.state.get(), { trackedCodebases: [], isWithinStorageBudget: true });
    // The helper's own timeouts are the protocol's: two minutes to come up, ten for a reconciliation or a snapshot,
    // thirty seconds for an upload, half an hour for a flush, and the shorter ones around a shutdown.
    const recorded: number[] = [];
    const clock = { now: () => 0, monotonicNow: () => 0, schedule: (delayMs: number) => { recorded.push(delayMs); return { dispose: () => {} }; } };
    const timed = await adapterWorld({ clock });
    for (const deadline of timed.spawned[0]!.deadlines as unknown as { run<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> }[]) await deadline.run(async () => {});
    assert.deepEqual(recorded, [10_000, 120_000, 600_000, 600_000, 30_000, 1_800_000, 15_000, 3_000]);
  });

  it("tracks only codebases of ours, and asks the helper for the desired ones", async () => {
    assert.deepEqual(toCodebase("account-1", tracked("cb-1", "/workspace")), { codebaseUuid: "cb-1", authId: "account-1", path: "/workspace", kind: 1, environment: 1 });
    assert.equal(toCodebase("account-1", tracked("cb-2", "/home/box", CodebaseKind.HOME_DIRECTORY)).kind, CodebaseKind.HOME_DIRECTORY);
    for (const outside of [tracked("cb-3", "/elsewhere", 3), { ...tracked("cb-4", "/workspace"), environment: 2 }]) {
      assert.throws(() => toCodebase("account-1", outside), CsnapsAdapterError);
    }
    assert.throws(() => toCodebase("account-1", tracked("cb-5", "/workspace", 0)), /csnaps returned a codebase outside Slate/);
    assert.deepEqual(toAdapterState("account-1", { tracked: [tracked("cb-1", "/workspace")] }).trackedCodebases.length, 1);
    assert.equal(toAdapterState("account-1", homeOf()).isWithinStorageBudget, true);
    assert.throws(() => toAdapterState("account-1", { tracked: [tracked("cb-6", "/workspace", 3)] }), CsnapsAdapterError);

    const desired = [{ path: SLATE_BOX_WORKSPACE_ROOT, kind: CodebaseKind.WORKSPACE_ROOT }];
    const world = await adapterWorld({ initialState: { tracked: [tracked("cb-1", "/workspace")] } });
    await world.adapter.setDesiredCodebases(desired);
    assert.deepEqual(world.csnaps.calls, ["applyCodebaseSpecs"]);
    assert.deepEqual(world.adapter.state.get().trackedCodebases.map((codebase) => codebase.codebaseUuid), ["cb-1"]);
    assert.deepEqual(world.ticks.length, 1);
    await world.adapter.setDesiredCodebases(desired);
    assert.deepEqual([world.csnaps.calls.length, world.ticks.length], [2, 1]);
    // A codebase the helper would not take fails the request — and nothing is published or polled for.
    const refused = await adapterWorld({ initialState: { tracked: [tracked("cb-1", "/workspace")] }, rejected: [{ path: "/home/box" }] });
    await assert.rejects(refused.adapter.setDesiredCodebases(desired), /csnaps rejected a required codebase/);
    assert.deepEqual([refused.adapter.state.get().trackedCodebases.length, refused.ticks.length], [1, 0]);
    assert.deepEqual(refused.logged, []);
  });

  it("uploads on the helper's own polling, with a credential fetched for each attempt, and says so when it cannot", async () => {
    const world = await adapterWorld();
    await world.adapter.setDesiredCodebases([]);
    await world.ticks[0]!();
    await world.ticks[0]!();
    assert.deepEqual(world.csnaps.uploads, [{ token: "upload-1" }, { token: "upload-2" }]);
    assert.deepEqual(world.logged, []);
    world.setFailCredentials(true);
    await world.ticks[0]!();
    assert.deepEqual([world.csnaps.uploads.length, world.logged], [2, ["Failed to trigger snapshot upload"]]);
  });

  it("flushes pending uploads with a fresh credential, and stops the moment it is closed", async () => {
    const world = await adapterWorld();
    await world.adapter.flushPendingUploads();
    assert.deepEqual(world.csnaps.flushes, [{ token: "upload-1" }]);
    // Credentials that come back after the adapter was closed are not used to flush.
    const closing = await adapterWorld();
    closing.beforeCredentialReturn(() => void closing.adapter.close());
    await closing.adapter.flushPendingUploads();
    assert.deepEqual([closing.csnaps.flushes.length, closing.credentials], [0, 1]);
    // Once closed, a flush does not even ask for credentials.
    await world.adapter.close();
    await world.adapter.flushPendingUploads();
    assert.deepEqual([world.csnaps.flushes.length, world.credentials], [1, 1]);
  });

  it("snapshots for a reason, and reports the helper dying as its own terminal failure", async () => {
    const world = await adapterWorld({ initialState: { tracked: [tracked("cb-1", "/workspace")] } });
    await world.adapter.snapshot({ type: "AGENT_REQUEST_START", requestId: "r-1" });
    assert.deepEqual(world.csnaps.snapshots, [{ type: "AGENT_REQUEST_START", requestId: "r-1" }]);
    await world.adapter.reconcileFeatureGates({});
    await world.adapter.runGitHistoryCapture();
    assert.deepEqual(world.csnaps.calls, ["snapshot"]);
    // The terminal failure is the helper's own: while the helper lives, nothing is said.
    const failure = new Error("the helper died");
    let settled: Error | undefined;
    void world.adapter.terminalFailure.then((error) => void (settled = error));
    await Promise.resolve();
    assert.deepEqual([settled, world.adapter.state.get().isWithinStorageBudget], [undefined, true]);
    world.csnaps.fail(failure);
    assert.equal(await world.adapter.terminalFailure, failure);
    assert.deepEqual(world.adapter.state.get(), { trackedCodebases: [], isWithinStorageBudget: false });
    // A helper that died after the adapter was closed changes nothing, and its failure is never handed on.
    const closed = await adapterWorld();
    let lateSettled = false;
    void closed.adapter.terminalFailure.then(() => void (lateSettled = true));
    await closed.adapter.close();
    closed.csnaps.fail(new Error("the helper died after the fact"));
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual([lateSettled, closed.adapter.state.get()], [false, { trackedCodebases: [], isWithinStorageBudget: true }]);
  });

  it("closes once, over everything it started, and reports what it could not clean up", async () => {
    const world = await adapterWorld();
    await world.adapter.setDesiredCodebases([]);
    const first = world.adapter.close();
    assert.deepEqual(await first, { kind: "closed" });
    assert.deepEqual([world.pollingDisposed, world.csnaps.calls.filter((call) => call === "close").length], [1, 1]);
    assert.equal(world.adapter.close(), first);
    // Every part that would not clean up is reported, with the failure that caused it.
    const failing = await adapterWorld({ failClose: true, failPollingDispose: true });
    await failing.adapter.setDesiredCodebases([]);
    assert.deepEqual(await failing.adapter.close(), { kind: "cleanupFailed", errors: [new Error("polling would not stop"), new Error("the helper would not close")] });
    failing.adapter.dispose();
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(failing.logged, ["Failed to close adapter"]);
  });

  it("keeps the state for the subscribers that can take it, and drops the ones that asked to stop", async () => {
    const world = await adapterWorld();
    const seen: unknown[] = [];
    world.adapter.state.subscribe(() => {
      throw new Error("a subscriber that cannot listen");
    });
    const listener = world.adapter.state.subscribe((value) => void seen.push(value));
    await world.adapter.setDesiredCodebases([]);
    assert.equal(seen.length, 1);
    assert.deepEqual(world.logged, ["Adapter state subscriber failed"]);
    listener.dispose();
    await world.adapter.setDesiredCodebases([]);
    assert.equal(seen.length, 1);
    // A closed adapter takes no more work: no codebases are applied, no snapshot is taken.
    const closed = await adapterWorld();
    await closed.adapter.close();
    await closed.adapter.setDesiredCodebases([{ path: "/workspace", kind: 1 }]);
    await closed.adapter.snapshot("reason");
    assert.deepEqual(closed.csnaps.calls, ["close"]);
  });
});

describe("whether the helper is there to be run", () => {
  it("tells a helper that is not there from one that is there but cannot run", () => {
    const absent = csnapsAvailability({ SLATE_CSNAPS_BIN: join(scratch, "not-there") } as NodeJS.ProcessEnv);
    assert.deepEqual(absent, { available: false, executablePath: join(scratch, "not-there"), reason: "missing" });
    const directory = mkdtempSync(join(scratch, "a-directory-"));
    assert.deepEqual(csnapsAvailability({ SLATE_CSNAPS_BIN: directory } as NodeJS.ProcessEnv), { available: false, executablePath: directory, reason: "not-file" });
    const readable = join(scratch, "read-but-not-runnable");
    writeFileSync(readable, "#!/bin/sh\n");
    chmodSync(readable, 0o644);
    assert.deepEqual(csnapsAvailability({ SLATE_CSNAPS_BIN: readable } as NodeJS.ProcessEnv), { available: false, executablePath: readable, reason: "not-executable" });
    const runnable = join(scratch, "runnable");
    writeFileSync(runnable, "#!/bin/sh\n");
    chmodSync(runnable, 0o755);
    assert.deepEqual(csnapsAvailability({ SLATE_CSNAPS_BIN: runnable } as NodeJS.ProcessEnv), { available: true, executablePath: runnable });
  });
});
