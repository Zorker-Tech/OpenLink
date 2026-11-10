import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  LOCAL_EXEC_DAEMON_DISCOVERY_MISS_LIMIT,
  LOCAL_EXEC_DAEMON_LIVENESS_INTERVAL_MS,
  LOCAL_EXEC_DAEMON_READINESS_POLL_MS,
  LOCAL_EXEC_DAEMON_READINESS_TIMEOUT_MS,
  LOCAL_EXEC_DAEMON_REFRESH_INTERVAL_MS,
  LOCAL_EXEC_DAEMON_RESPAWN_LIMIT,
  createLocalExecDaemonLivenessPolicy,
  createLocalExecDaemonRefreshPolicy,
  createLocalExecDaemonSupervisor,
  decideLocalExecDaemonAction,
} from "../../source/coordinator/local-exec/supervisor.ts";
import { resolveLocalExecDaemonPaths } from "../../source/coordinator/local-exec/daemon-files.ts";

const ENTRY = "/opt/slate/local-exec.js";
function identityOf(pid: number, startEpochMs: number, token = "gen-1"): any {
  return { pid, startEpochMs, command: "node " + ENTRY + " --slate-local-exec-generation=" + token, entryRealpath: ENTRY, generationToken: token };
}
function discoveryOf(pid: number, startedAt: number, inflightCount?: number, token = "gen-1"): any {
  return { pid, startedAt, entryRealpath: ENTRY, generationToken: token, ...(inflightCount === undefined ? {} : { inflightCount }) };
}
function scenario(options: any = {}) {
  const dir = mkdtempSync(join(tmpdir(), "supervisor-test-"));
  const paths = resolveLocalExecDaemonPaths(dir);
  const ops: any[] = [];
  const timers: any[] = [];
  const disposed: string[] = [];
  let clock = 10_000;
  const identity = identityOf(options.pid ?? 4_242, options.startEpochMs ?? 1_000);
  if (options.discovery !== undefined) { mkdirSync(dir, { recursive: true }); writeFileSync(paths.discoveryPath, JSON.stringify(options.discovery)); }
  const control: any = {
    resolveGatewayConnection: async () => ({ url: "ws://gateway" }),
    mintLocalExecDaemonCredential: async () => ({ token: "credential-1" }),
    spawnLocalExecDaemon: async (args: any) => { ops.push(["spawn", args.env, "/log"]); if (options.spawnInvalid) return { bogus: true }; if (options.spawnWritesDiscovery !== false) writeFileSync(paths.discoveryPath, JSON.stringify({ pid: identity.pid, startedAt: identity.startEpochMs, entryRealpath: identity.entryRealpath, generationToken: identity.generationToken })); return identity; },
    isProcessAlive: async ({ pid }: any) => { ops.push(["alive", pid]); return true; },
    getProcessIdentity: async (expected: any) => typeof expected.startEpochMs === "number" ? expected : identityOf(expected.pid, expected.discoveryStartedAt ?? 1_000, expected.generationToken ?? "gen-1"),
    waitLocalExecDaemonExit: async () => await new Promise(() => undefined),
    terminateProcess: async ({ identity: target }: any) => { ops.push(["terminate", target.pid]); return { terminated: true }; },
  };
  const policy = (name: string) => ({ name, start: (work: any) => { timers.push(work); return { dispose: () => disposed.push(name) }; } });
  const supervisor: any = createLocalExecDaemonSupervisor({ dataDir: dir, isPackaged: true, control, refreshPolicy: policy("refresh") as never, livenessPolicy: policy("liveness") as never, readinessTimeoutMs: 500, readinessPollMs: 10, now: () => clock, delay: async (ms: number) => { clock += ms; } });
  const settle = async () => { await supervisor.whenIdle(); return supervisor.state(); };
  const cleanup = () => { rmSync(dir, { recursive: true, force: true }); };
  return { supervisor, paths, ops, timers, disposed, settle, cleanup, writeDiscovery: (value: any) => writeFileSync(paths.discoveryPath, JSON.stringify(value)), readDiscovery: () => { try { return JSON.parse(readFileSync(paths.discoveryPath, "utf8")); } catch { return null; } }, files: () => readdirSync(dir).sort() };
}

describe("keeping the local-exec daemon alive", () => {
  it("decides what to do with an existing daemon", () => {
    assert.deepEqual(decideLocalExecDaemonAction(null), { kind: "spawn" });
    assert.deepEqual(decideLocalExecDaemonAction({ pid: 1, inflightCount: 2 }), { kind: "adopt", pid: 1 });
    assert.deepEqual(decideLocalExecDaemonAction({ pid: 2 }), { kind: "replace", pid: 2 });
  });

  it("names its policies and constants", () => {
    assert.deepEqual([LOCAL_EXEC_DAEMON_REFRESH_INTERVAL_MS, LOCAL_EXEC_DAEMON_LIVENESS_INTERVAL_MS, LOCAL_EXEC_DAEMON_READINESS_TIMEOUT_MS, LOCAL_EXEC_DAEMON_READINESS_POLL_MS, LOCAL_EXEC_DAEMON_DISCOVERY_MISS_LIMIT, LOCAL_EXEC_DAEMON_RESPAWN_LIMIT], [30_000, 1_000, 5_000, 50, 2, 10]);
    assert.equal((createLocalExecDaemonRefreshPolicy() as any).name, "local-exec-daemon-refresh");
    assert.equal((createLocalExecDaemonLivenessPolicy() as any).name, "local-exec-daemon-liveness");
  });

  it("spawns a daemon and publishes its files", async () => {
    const harness = scenario();
    try {
      await harness.supervisor.start();
      const state = await harness.settle();
      assert.equal(state.phase, "active");
      assert.deepEqual(state.daemon.origin, "spawned");
      assert.deepEqual(harness.ops[0].slice(0, 2), ["spawn", { ELECTRON_RUN_AS_NODE: "1", SLATE_PACKAGED: "1" }]);
      assert.deepEqual(harness.files(), ["local-exec-daemon-connection.json", "local-exec-daemon-credential.json", "local-exec-daemon.json", "local-exec-supervisor.json"]);
      assert.deepEqual(harness.readDiscovery(), { pid: 4_242, startedAt: 1_000, entryRealpath: ENTRY, generationToken: "gen-1" });
    } finally { await harness.supervisor.dispose(); harness.cleanup(); }
  });

  it("adopts a daemon with work in flight and replaces an idle one", async () => {
    const adopted = scenario({ discovery: discoveryOf(7_000, 900, 2) });
    try {
      await adopted.supervisor.start();
      assert.equal((await adopted.settle()).daemon.origin, "adopted");
      assert.equal(adopted.ops.some((op) => op[0] === "spawn"), false);
    } finally { await adopted.supervisor.dispose(); adopted.cleanup(); }
    const replaced = scenario({ discovery: discoveryOf(7_000, 900, 0) });
    try {
      await replaced.supervisor.start();
      await replaced.settle();
      assert.deepEqual(replaced.ops.filter((op) => op[0] === "terminate" || op[0] === "spawn").map((op) => op[0]), ["terminate", "spawn"]);
    } finally { await replaced.supervisor.dispose(); replaced.cleanup(); }
  });

  it("fails the state when a spawn cannot become ready", async () => {
    const timeout = scenario({ spawnWritesDiscovery: false });
    const originalNow = timeout.supervisor;
    try {
      await timeout.supervisor.start();
      await timeout.settle();
      assert.match(timeout.supervisor.state().reason, /did not publish matching discovery before readiness timeout/);
    } finally { await timeout.supervisor.dispose(); timeout.cleanup(); }
    void originalNow;
    const invalid = scenario({ spawnInvalid: true });
    try {
      await invalid.supervisor.start();
      await invalid.settle();
      assert.equal(invalid.supervisor.state().reason, "local-exec spawn did not return a valid daemon identity");
    } finally { await invalid.supervisor.dispose(); invalid.cleanup(); }
  });

  it("heals a daemon whose discovery disappears", async () => {
    const harness = scenario({ discovery: discoveryOf(7_000, 900, 2) });
    try {
      await harness.supervisor.start();
      await harness.settle();
      rmSync(harness.paths.discoveryPath, { force: true });
      for (let index = 0; index < 3; index += 1) { await harness.timers[1](); await harness.settle(); }
      assert.equal(harness.supervisor.state().phase, "active");
      assert.equal(harness.ops.filter((op) => op[0] === "spawn").length, 1, "a fresh daemon was spawned");
    } finally { await harness.supervisor.dispose(); harness.cleanup(); }
  });

  it("quarantines a live process whose discovery generation changed", async () => {
    const harness = scenario({ discovery: discoveryOf(7_000, 900, 2) });
    try {
      await harness.supervisor.start();
      await harness.settle();
      harness.writeDiscovery(discoveryOf(7_000, 901, 2, "gen-2"));
      await harness.timers[1]();
      await harness.timers[1]();
      const state = await harness.settle();
      assert.equal(state.phase, "failed");
      assert.equal(state.reason, "local-exec active discovery generation changed while its verified process remained live");
    } finally { await harness.supervisor.dispose(); harness.cleanup(); }
  });

  it("retires on pause and comes back on resume, and disposes cleanly", async () => {
    const harness = scenario({ discovery: discoveryOf(7_000, 900, 2) });
    try {
      await harness.supervisor.start();
      await harness.settle();
      await harness.supervisor.setPaused(true);
      await harness.settle();
      assert.equal(harness.supervisor.state().phase, "absent");
      assert.equal(harness.readDiscovery(), null);
      await harness.supervisor.setPaused(false);
      await harness.settle();
      assert.equal(harness.supervisor.state().phase, "active");
    } finally { await harness.supervisor.dispose(); harness.supervisor.dispose(); harness.cleanup(); }
  });
});