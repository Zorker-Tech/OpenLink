import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createContext } from "../../source/packages/context/context.ts";
import { BOX_FORK_NOVNC_PORT } from "../../source/packages/constants/box-endpoints.ts";
import {
  BOX_TERMINALS_FOLDER,
  DEFAULT_AUTH_TOKEN,
  DAEMON_READY_TIMEOUT_MS,
  EXEC_DAEMON_PORT,
  LoopbackBox,
  VNC_PORT,
  daemonPingReadinessState,
  type BoxEndpoint,
  type DaemonPingReport,
  type LoopbackOperations,
  type LoopbackTelemetry,
  type PingResult,
} from "../../source/host/boxes/loopback-slate-box.ts";
import type { BoxEnvironmentUpdate } from "../../source/host/boxes/box-env.ts";
import type { ShellAccessor } from "../../source/host/boxes/box-windows.ts";
import { SlateBoxDaemonUnreachableError } from "../../source/host/ports/box.ts";
import { executeBoxWindowShellCommand } from "../../source/adapters/interop/agent/box-window-shell-result-adapter.ts";

type Accessor = ShellAccessor & { endpoint: BoxEndpoint };

interface BoxHarness {
  box: LoopbackBox<Accessor>;
  calls: {
    pings: BoxEndpoint[];
    accessors: Accessor[];
    starts: string[];
    stops: string[];
    guards: Array<(path: string) => Promise<void>>;
    uploads: Array<{ path: string; bytes: Uint8Array }>;
    environment: Array<{ endpoint: BoxEndpoint; update: BoxEnvironmentUpdate }>;
    mcp: Array<{ endpoint: BoxEndpoint; configJson: string }>;
    sleeps: number[];
    reports: DaemonPingReport[];
  };
  outcomes: PingResult[];
  setNow(value: number): void;
  now(): number;
}

function harness(options: {
  outcomes?: PingResult[];
  withTelemetry?: boolean;
  readyTimeoutMs?: number;
  pollIntervalMs?: number;
  watchdogIntervalMs?: number;
  protectedBoxPaths?: readonly string[];
  transports?: { environment?: boolean; mcp?: boolean; upload?: boolean };
} = {}): BoxHarness {
  const calls: BoxHarness["calls"] = {
    pings: [], accessors: [], starts: [], stops: [], guards: [], uploads: [], environment: [], mcp: [], sleeps: [], reports: [],
  };
  const outcomes = [...(options.outcomes ?? [])];
  let clock = 0;
  const telemetry: LoopbackTelemetry = { reportDaemonPing: report => calls.reports.push(report) };
  const operations: LoopbackOperations<Accessor> = {
    async ping(_ctx, endpoint) {
      calls.pings.push(endpoint);
      return outcomes.shift() ?? { outcome: "ok" };
    },
    createRemoteAccessor(endpoint) {
      const accessor = {
        endpoint,
        get() {
          return {
            async execute(_ctx: unknown, args: { command?: string }) {
              if (args.command?.startsWith("/usr/local/bin/start-window ")) calls.starts.push(args.command);
              if (args.command?.startsWith("/usr/local/bin/stop-window ")) calls.stops.push(args.command);
              return { outcome: { kind: "success", command: String(args.command ?? ""), workingDirectory: "/workspace", exitCode: 0, signal: "", stdout: "", stderr: "", executionTimeMs: 0 } };
            },
          };
        },
      } as unknown as Accessor;
      calls.accessors.push(accessor);
      return accessor;
    },
    protectRemoteAccessor(accessor, assertAllowed) {
      calls.guards.push(assertAllowed);
      return accessor;
    },
    executeWindowCommand: executeBoxWindowShellCommand,
    ...(options.transports?.environment === false ? {} : {
      async applyEnvironment(_ctx, endpoint, update) { calls.environment.push({ endpoint, update }); },
    }),
    ...(options.transports?.mcp === false ? {} : {
      async loadMcpServers(_ctx, endpoint, configJson) { calls.mcp.push({ endpoint, configJson }); return ["calendar", "search"]; },
    }),
    ...(options.transports?.upload === false ? {} : {
      async uploadFile(_ctx, _accessor, path, bytes) { calls.uploads.push({ path, bytes }); },
    }),
    sleep: async ms => { calls.sleeps.push(ms); clock += ms; },
    now: () => clock,
  };
  const box = new LoopbackBox<Accessor>({
    operations,
    ...(options.withTelemetry === false ? {} : { telemetry }),
    ...(options.readyTimeoutMs === undefined ? {} : { readyTimeoutMs: options.readyTimeoutMs }),
    ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
    ...(options.watchdogIntervalMs === undefined ? { watchdogIntervalMs: 0 } : { watchdogIntervalMs: options.watchdogIntervalMs }),
    ...(options.protectedBoxPaths === undefined ? {} : { protectedBoxPaths: options.protectedBoxPaths }),
  });
  return { box, calls, outcomes, setNow: value => { clock = value; }, now: () => clock };
}

describe("loopback box contract", () => {
  it("keeps its local endpoint, default credentials, and always-available box identity", async () => {
    const { box } = harness();
    assert.deepEqual(box.describe(), { backend: "loopback" });
    assert.equal(await box.isAvailable(), true);
    assert.deepEqual(box.primaryEndpoint(), { host: "127.0.0.1", port: EXEC_DAEMON_PORT, authToken: DEFAULT_AUTH_TOKEN });
    assert.equal(box.getTerminalsFolder(), BOX_TERMINALS_FOLDER);
    assert.equal(box.readyTimeoutMs, DAEMON_READY_TIMEOUT_MS);
    assert.deepEqual(new LoopbackBox({ host: "localhost", authToken: "secret", operations: {
      ping: async () => ({ outcome: "ok" }),
      createRemoteAccessor: endpoint => ({ endpoint, get: () => ({}) } as unknown as Accessor),
      protectRemoteAccessor: accessor => accessor,
      executeWindowCommand: async () => ({ kind: "completed", exitCode: 0, stderr: "" }),
    } }).primaryEndpoint(), { host: "localhost", port: EXEC_DAEMON_PORT, authToken: "secret" });
  });

  it("waits for the primary daemon and returns a protected accessor and primary display", async () => {
    const h = harness({ outcomes: [{ outcome: "refused" }, { outcome: "ok" }], pollIntervalMs: 7 });
    const ready = await h.box.ensureReady(createContext(), "agent-a");
    assert.equal(ready.remoteAccessor, h.calls.accessors[0]);
    assert.equal(ready.vncUrl, `http://127.0.0.1:${VNC_PORT}/vnc.html`);
    assert.equal(ready.terminalsFolder, BOX_TERMINALS_FOLDER);
    assert.equal(h.calls.pings.length, 2);
    assert.deepEqual(h.calls.sleeps, [7]);
    assert.equal(h.calls.guards.length, 1);
  });

  it("reports the complete foreground retry interval after recovery", async () => {
    const h = harness({ outcomes: [{ outcome: "dns", causeSummary: "lookup failed" }, { outcome: "ok" }], pollIntervalMs: 11 });
    await h.box.waitUntilReady(createContext(), h.box.primaryEndpoint());
    assert.deepEqual(h.calls.reports, [{
      outcome: "ok", attempts: 2, durationMs: 11, unreadyDurationMs: 11, readinessState: "ready_after_retry", target: "127.0.0.1:1337",
    }]);
  });

  it("maps daemon refusal, timeout, and disconnect outcomes to stable readiness labels", () => {
    assert.equal(daemonPingReadinessState("refused"), "up_but_exec_refused");
    assert.equal(daemonPingReadinessState("timeout"), "up_but_exec_unresponsive");
    assert.equal(daemonPingReadinessState("dns"), "up_but_exec_disconnected");
  });

  it("reports timeout context and throws the typed unreachable error", async () => {
    const h = harness({ outcomes: Array.from({ length: 3 }, () => ({ outcome: "timeout", causeSummary: "connect ETIMEDOUT" })), readyTimeoutMs: 30, pollIntervalMs: 10 });
    await assert.rejects(h.box.waitUntilReady(createContext(), h.box.primaryEndpoint()), error => {
      assert.ok(error instanceof SlateBoxDaemonUnreachableError);
      assert.equal(error.outcome, "timeout");
      assert.match(error.message, /127\.0\.0\.1:1337/);
      assert.match(error.message, /connect ETIMEDOUT/);
      return true;
    });
    assert.equal(h.calls.reports.at(-1)?.outcome, "timeout");
    assert.equal(h.calls.reports.at(-1)?.readinessState, "up_but_exec_unresponsive");
  });

  it("keeps non-primary readiness checks outside primary watchdog coordination", async () => {
    const h = harness({ outcomes: [{ outcome: "ok" }] });
    await h.box.waitUntilReady(createContext(), { host: "127.0.0.1", port: 1339, authToken: "local" });
    assert.equal(h.calls.pings.length, 1);
    assert.equal(h.calls.reports.length, 0);
  });

  it("tracks watchdog outages and reports one recovery with accumulated attempts", async () => {
    const h = harness({ outcomes: [{ outcome: "ok" }, { outcome: "refused" }, { outcome: "timeout" }, { outcome: "ok" }] });
    const endpoint = h.box.primaryEndpoint();
    await h.box.pollDaemonWatchdog(endpoint);
    h.setNow(1_000);
    await h.box.pollDaemonWatchdog(endpoint);
    h.setNow(1_500);
    await h.box.pollDaemonWatchdog(endpoint);
    h.setNow(2_000);
    await h.box.pollDaemonWatchdog(endpoint);
    assert.deepEqual(h.calls.reports, [
      { outcome: "refused", attempts: 1, durationMs: 0, unreadyDurationMs: 0, readinessState: "up_but_exec_refused", target: "127.0.0.1:1337" },
      { outcome: "ok", attempts: 3, durationMs: 1_000, unreadyDurationMs: 1_000, readinessState: "ready_after_retry", target: "127.0.0.1:1337" },
    ]);
  });

  it("uses the primary connection for the primary window", async () => {
    const h = harness();
    const primary = await h.box.ensureWindow(createContext(), "agent-a", 1);
    assert.equal(primary.windowIndex, 1);
    assert.equal(primary.computerUse, h.calls.accessors[0]);
    assert.equal(primary.vncUrl, `http://127.0.0.1:${VNC_PORT}/vnc.html`);
    assert.equal(h.calls.starts.length, 0);
  });

  it("allocates a fork with display and owner headers, then reuses it for the same owner", async () => {
    const h = harness();
    const first = await h.box.ensureWindow(createContext(), "agent-a", 2, { ownerToken: "owner-1" });
    const again = await h.box.ensureWindow(createContext(), "agent-a", 2, { ownerToken: "owner-1" });
    assert.equal(again, first);
    assert.equal(first.windowIndex, 2);
    assert.equal(first.vncUrl, `http://127.0.0.1:${BOX_FORK_NOVNC_PORT}/vnc.html?path=websockify%3Ftoken%3D2`);
    assert.equal(h.calls.starts.length, 1);
    assert.deepEqual(h.calls.pings.at(-1), {
      host: "127.0.0.1", port: 1339, authToken: "local", headers: { "x-slate-display": "2", "x-slate-window-owner": "owner-1" },
    });
    assert.equal(h.calls.pings.length, 3);
  });

  it("replaces stale owner connections and retires fork connections on release or hibernate", async () => {
    const h = harness();
    await h.box.ensureWindow(createContext(), "agent-a", 2, { ownerToken: "owner-1" });
    await h.box.ensureWindow(createContext(), "agent-a", 2, { ownerToken: "owner-2" });
    assert.equal(h.calls.starts.length, 2);
    await h.box.releaseWindow(createContext(), "agent-a", 2);
    assert.equal(h.calls.stops.length, 1);
    assert.match(h.calls.stops[0] ?? "", /stop-window 2/);
    await h.box.ensureWindow(createContext(), "agent-a", 2);
    await h.box.ensureWindow(createContext(), "agent-b", 2);
    const before = h.calls.starts.length;
    await h.box.hibernate(createContext(), "agent-a");
    await h.box.ensureWindow(createContext(), "agent-a", 2);
    assert.equal(h.calls.starts.length, before + 1);
    assert.equal(h.calls.starts.length, 5);
  });

  it("does not stop the primary window when a fork is released", async () => {
    const h = harness();
    await h.box.releaseWindow(createContext(), "agent-a", 1);
    assert.equal(h.calls.stops.length, 0);
    assert.equal(h.calls.pings.length, 0);
  });

  it("rejects a malformed owner token before running the start command", async () => {
    const h = harness();
    await assert.rejects(h.box.ensureWindow(createContext(), "agent-a", 2, { ownerToken: "bad token" }), /malformed owner token/);
    assert.equal(h.calls.starts.length, 0);
  });

  it("applies environment and loads MCP servers only after the daemon is ready", async () => {
    const h = harness();
    const update: BoxEnvironmentUpdate = { replace: true, env: { PATH: "/bin" } };
    await h.box.applyEnvironment(createContext(), update);
    assert.deepEqual(h.calls.environment, [{ endpoint: h.box.primaryEndpoint(), update }]);
    assert.deepEqual(await h.box.loadMcpServers(createContext(), "{\"servers\":[]}"), ["calendar", "search"]);
    assert.deepEqual(h.calls.mcp, [{ endpoint: h.box.primaryEndpoint(), configJson: "{\"servers\":[]}" }]);
    assert.equal((await h.box.mcpResourceAccessor(createContext())).endpoint.port, EXEC_DAEMON_PORT);
  });

  it("fails honestly when an optional operation has no transport", async () => {
    const h = harness({ transports: { environment: false, mcp: false, upload: false } });
    await assert.rejects(h.box.applyEnvironment(createContext(), { replace: true, env: {} }), /environment transport is unavailable/);
    await assert.rejects(h.box.loadMcpServers(createContext(), "{}"), /MCP transport is unavailable/);
    await assert.rejects(h.box.uploadFile(createContext(), "agent-a", "note.txt", new Uint8Array()), /upload transport is unavailable/);
  });

  it("refuses protected paths before handing an accessor to a remote reader", async () => {
    const h = harness({ protectedBoxPaths: ["/workspace/private"] });
    const ready = await h.box.ensureReady(createContext(), "agent-a");
    const guard = h.calls.guards[0];
    assert.ok(guard);
    await assert.rejects(guard("/workspace/private/key.txt"), /protected host-only store/);
    await guard("/workspace/project/file.txt");
    assert.equal(ready.remoteAccessor, h.calls.accessors[0]);
  });

  it("resolves upload paths under the workspace and returns downloaded bytes", async t => {
    const h = harness();
    const payload = new Uint8Array([1, 3, 5]);
    await h.box.uploadFile(createContext(), "agent-a", "uploads/sample.bin", payload);
    assert.deepEqual(h.calls.uploads, [{ path: "/workspace/uploads/sample.bin", bytes: payload }]);

    const directory = await mkdtemp(join(tmpdir(), "slate-loopback-box-"));
    t.after(async () => rm(directory, { recursive: true, force: true }));
    const localFile = join(directory, "result.bin");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(localFile, payload);
    assert.deepEqual(await h.box.downloadFile(createContext(), "agent-a", localFile), Buffer.from(payload));
    assert.deepEqual(await readFile(localFile), Buffer.from(payload));
  });

  it("converts a missing downloaded file into an actionable box file error", async () => {
    const { box } = harness();
    await assert.rejects(box.downloadFile(createContext(), "agent-a", "/workspace/missing.bin"), /file missing/);
  });

  it("does not start a watchdog without telemetry and stops its background loop when disposed", async () => {
    const quiet = harness({ withTelemetry: false, watchdogIntervalMs: 1 });
    await quiet.box.waitUntilReady(createContext(), quiet.box.primaryEndpoint());
    await quiet.box.dispose();
    assert.equal(quiet.calls.pings.length, 1);

    const h = harness({ watchdogIntervalMs: 1 });
    h.box.options.operations.sleep = async (_ms, signal) => {
      if (signal?.aborted) return;
      await new Promise<void>(resolve => signal?.addEventListener("abort", () => resolve(), { once: true }));
    };
    await h.box.waitUntilReady(createContext(), h.box.primaryEndpoint());
    await h.box.dispose();
    assert.equal(h.calls.pings.length, 1);
  });
});
