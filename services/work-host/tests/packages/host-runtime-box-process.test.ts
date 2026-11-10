/**
 * The host's runtime pieces, thirteenth group: the switches the box's extension reads, the exec daemon as a process this
 * host owns, and the generated pieces the box is built from.
 */

import assert from "node:assert/strict";
import { createConnection, createServer } from "node:net";
import { chmodSync, existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it } from "node:test";

import { computerUseExecutorResource } from "../../source/adapters/interop/agent/computer-use-executor-adapter.ts";
import { readExecutorResource } from "../../source/packages/agent-exec/read-operation.ts";
import { createContext } from "../../source/packages/context/context.ts";
import { createBoxTransport } from "../../source/host/boxes/box-remote-accessor.ts";
import { BOX_DAEMON_ENTRY_FROM_HOST, BOX_DAEMON_READY_TIMEOUT_MS, BOX_DAEMON_STOP_GRACE_MS, launchBoxExecDaemon, resolveBoxDaemonEntryFromHost } from "../../source/host/boxes/exec-daemon-process.ts";
import { createForeverBoxExtension, foreverBoxExtension, imageWatchIntervalMs, imageWatchJitterRatio, initialImageWatchDelayMs, isHostBundleAutoUpdateEnabled, isImageAutoUpdateEnabled, jitteredImageWatchIntervalMs } from "../../source/host/boxes/forever-box/extension.ts";
import { SLATE_BOX_PROTOCOL_VERSION, productionSlateBoxPorts } from "../../source/host/boxes/slate-production.ts";
import { HostExtensions } from "../../source/host/extensions/extension-ids.generated.ts";
import { isNoMonitorComputerUseExecutor } from "../../source/host/ports/box.ts";

describe("the box this build keeps running", () => {
  it("registers under its own id with what it depends on", () => {
    assert.equal(foreverBoxExtension.kind, "host-extension");
    assert.equal(foreverBoxExtension.id, HostExtensions.ForeverBox);
    assert.deepEqual(foreverBoxExtension.dependencies, ["box-lifecycle", "codebase-telemetry", "telemetry", "trays"]);
    assert.equal(typeof createForeverBoxExtension, "function");
  });

  it("only updates the box's image where the store is synced in and nothing turned it off", () => {
    // The image is only touched where the store is both synced and copied in, and the switch can still turn it off.
    assert.equal(isImageAutoUpdateEnabled({}), false);
    assert.equal(isImageAutoUpdateEnabled({ SLATE_BOX_STORE_SYNC: "1" }), false);
    assert.equal(isImageAutoUpdateEnabled({ SLATE_BOX_STORE_COPY_IN: "1" }), false);
    assert.equal(isImageAutoUpdateEnabled({ SLATE_BOX_STORE_SYNC: "1", SLATE_BOX_STORE_COPY_IN: "1" }), true);
    assert.equal(isImageAutoUpdateEnabled({ SLATE_BOX_STORE_SYNC: "1", SLATE_BOX_STORE_COPY_IN: "1", SLATE_BOX_AUTO_UPDATE: "0" }), false);
    assert.equal(isImageAutoUpdateEnabled({ SLATE_BOX_STORE_SYNC: "1", SLATE_BOX_STORE_COPY_IN: "1", SLATE_BOX_AUTO_UPDATE: "false" }), false);
    assert.equal(isImageAutoUpdateEnabled({ SLATE_BOX_STORE_SYNC: "1", SLATE_BOX_STORE_COPY_IN: "1", SLATE_BOX_AUTO_UPDATE: "  Yes  " }), true);
    // The host's own bundle is updated wherever the switch does not say no.
    assert.equal(isHostBundleAutoUpdateEnabled({}), true);
    assert.equal(isHostBundleAutoUpdateEnabled({ SLATE_BOX_AUTO_UPDATE: "0" }), false);
    assert.equal(isHostBundleAutoUpdateEnabled({ SLATE_BOX_AUTO_UPDATE: "false" }), false);
    assert.equal(isHostBundleAutoUpdateEnabled({ SLATE_BOX_AUTO_UPDATE: "no" }), false);
    assert.equal(isHostBundleAutoUpdateEnabled({ SLATE_BOX_AUTO_UPDATE: "yes" }), true);
  });

  it("watches for a new image on the platform's interval unless the environment names another", () => {
    assert.equal(imageWatchIntervalMs({}), 24 * 60 * 60_000);
    assert.equal(imageWatchIntervalMs({ SLATE_BOX_UPDATE_WATCH_INTERVAL_MS: "5000" }), 5_000);
    // A number that is not a positive count of milliseconds is not an interval.
    assert.equal(imageWatchIntervalMs({ SLATE_BOX_UPDATE_WATCH_INTERVAL_MS: "0" }), 24 * 60 * 60_000);
    assert.equal(imageWatchIntervalMs({ SLATE_BOX_UPDATE_WATCH_INTERVAL_MS: "abc" }), 24 * 60 * 60_000);
    assert.equal(imageWatchIntervalMs({ SLATE_BOX_UPDATE_WATCH_INTERVAL_MS: "-5" }), 24 * 60 * 60_000);
    assert.equal(imageWatchJitterRatio({}), 0.5);
    assert.equal(imageWatchJitterRatio({ SLATE_BOX_UPDATE_WATCH_JITTER_RATIO: "0" }), 0);
    // A ratio is a share of the interval: more than all of it is all of it, and less than none of it is the default.
    assert.equal(imageWatchJitterRatio({ SLATE_BOX_UPDATE_WATCH_JITTER_RATIO: "2" }), 1);
    assert.equal(imageWatchJitterRatio({ SLATE_BOX_UPDATE_WATCH_JITTER_RATIO: "-1" }), 0.5);
    assert.equal(imageWatchJitterRatio({ SLATE_BOX_UPDATE_WATCH_JITTER_RATIO: "nope" }), 0.5);
  });

  it("spreads the watch out rather than asking every host at the same moment", () => {
    // The first watch waits a share of the interval, and none of it when there is no jitter.
    assert.equal(initialImageWatchDelayMs({ intervalMs: 10_000, ratio: 0.5 }, () => 0.4), 4_000);
    assert.equal(initialImageWatchDelayMs({ intervalMs: 10_000, ratio: 0 }, () => 0.9), 0);
    assert.equal(initialImageWatchDelayMs({ intervalMs: 10_000, ratio: 0.5 }, () => 0), 0);
    // Later watches come back around the interval, and never sooner than a millisecond.
    assert.equal(jitteredImageWatchIntervalMs({ intervalMs: 10_000, ratio: 0.5 }, () => 0), 5_000);
    assert.equal(jitteredImageWatchIntervalMs({ intervalMs: 10_000, ratio: 0.5 }, () => 1), 15_000);
    assert.equal(jitteredImageWatchIntervalMs({ intervalMs: 10_000, ratio: 0 }, () => 0.7), 10_000);
    assert.equal(jitteredImageWatchIntervalMs({ intervalMs: 1, ratio: 1 }, () => 0) >= 1, true);
  });
});

describe("the box's exec daemon as a process this host owns", () => {
  const sourceRoot = fileURLToPath(new URL("../..", import.meta.url));

  /** A port nothing is listening on, taken by asking the system for one and letting it go again. */
  async function freePort(): Promise<number> {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const address = probe.address();
    assert.ok(address !== null && typeof address === "object");
    const port = address.port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    return port;
  }

  /** The daemon's own sources are TypeScript, so the entry it is started through is the one that runs it, and the
   * process is started by a node that strips the types — the built entry is a compiled file, which is what the shipped
   * layout names. */
  function typeStrippingNode(): string {
    const directory = mkdtempSync(join(tmpdir(), "slate-node-"));
    const wrapper = join(directory, "daemon-node");
    writeFileSync(wrapper, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} --experimental-transform-types --no-warnings "$@"\n`);
    chmodSync(wrapper, 0o755);
    return wrapper;
  }

  const workspace = () => {
    const root = mkdtempSync(join(tmpdir(), "slate-box-directories-"));
    return { workspaceRoot: join(root, "workspace"), terminalsDirectory: join(root, "terminals") };
  };

  function waitForTcpListener(host: string, port: number, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = createConnection({ host, port });
      socket.setTimeout(timeoutMs, () => {
        socket.destroy();
        reject(new Error("box listener did not open before the probe timed out"));
      });
      socket.once("connect", () => {
        socket.end();
        resolve();
      });
      socket.once("error", reject);
    });
  }

  it("resolves the daemon's entry beside the host's own", () => {
    assert.equal(BOX_DAEMON_ENTRY_FROM_HOST, "../box-exec/main.cjs");
    assert.equal(BOX_DAEMON_READY_TIMEOUT_MS, 20_000);
    assert.equal(BOX_DAEMON_STOP_GRACE_MS, 5_000);
    assert.equal(resolveBoxDaemonEntryFromHost("/app/host/main.cjs"), "/app/box-exec/main.cjs");
    // Without a host entry there is nowhere to resolve the daemon's from — neither an empty one nor a process that
    // was started without one.
    assert.throws(() => resolveBoxDaemonEntryFromHost(""), { message: "cannot resolve box exec-daemon entry without a host process entry" });
    const argv = process.argv as unknown as Array<string | undefined>;
    const saved = argv[1];
    try {
      argv[1] = undefined;
      assert.throws(() => resolveBoxDaemonEntryFromHost(), { message: "cannot resolve box exec-daemon entry without a host process entry" });
    } finally {
      argv[1] = saved;
    }
  });

  it("owns and closes a standalone daemon child without relying on a Node TypeScript loader", async () => {
    const port = await freePort();
    const root = mkdtempSync(join(tmpdir(), "slate-box-owned-daemon-"));
    const entryPath = join(root, "daemon.cjs");
    writeFileSync(entryPath, [
      'const net = require("node:net");',
      'console.log(JSON.stringify({ port: process.env.SLATE_BOX_EXEC_DAEMON_PORT, token: process.env.SLATE_BOX_EXEC_DAEMON_AUTH_TOKEN, workspace: process.env.SLATE_BOX_WORKSPACE_ROOT, terminals: process.env.SLATE_BOX_TERMINALS_DIRECTORY }));',
      'const server = net.createServer(socket => socket.end());',
      'server.listen(Number(process.env.SLATE_BOX_EXEC_DAEMON_PORT), "127.0.0.1");',
      'setInterval(() => {}, 1_000);',
    ].join("\n"));
    const { workspaceRoot, terminalsDirectory } = workspace();
    const logs: string[] = [];
    const rpcPorts = {
      createTransport: (options: { readonly baseUrl: string }) => {
        const endpoint = new URL(options.baseUrl);
        return { host: endpoint.hostname, port: Number(endpoint.port) };
      },
      createControlClient: (endpoint: { readonly host: string; readonly port: number }) => ({
        ping: async (_context: unknown, _request: unknown, options: { readonly timeoutMs: number }) =>
          await waitForTcpListener(endpoint.host, endpoint.port, options.timeoutMs),
      }),
    };
    const daemon = await launchBoxExecDaemon({
      daemonEntryPath: entryPath,
      rpcPorts: rpcPorts as never,
      bindPort: port,
      workspaceDirectory: workspaceRoot,
      terminalDirectory: terminalsDirectory,
      nodeExecutable: process.execPath,
      controlToken: "launch-token",
      readinessTimeoutMs: 1_000,
      processEnvironment: {
        SLATE_BOX_EXEC_DAEMON_PORT: String(port === 65_535 ? port - 1 : port + 1),
        SLATE_BOX_EXEC_DAEMON_AUTH_TOKEN: "inherited-token",
        SLATE_BOX_WORKSPACE_ROOT: "/inherited/workspace",
        SLATE_BOX_TERMINALS_DIRECTORY: "/inherited/terminals",
      },
      output: { log: line => logs.push(line), error: () => {} },
    });

    try {
      await daemon.ready;
      assert.equal(typeof daemon.pid, "number");
      assert.equal(daemon.daemonEntryPath, entryPath);
      const outputDeadline = Date.now() + 1_000;
      while (logs.length === 0 && Date.now() < outputDeadline) await new Promise(resolve => setTimeout(resolve, 10));
      const startup = JSON.parse(logs.join("\n").split("[box-exec-daemon] ").at(-1) ?? "{}") as Record<string, string>;
      assert.deepEqual(startup, {
        port: String(port),
        token: "launch-token",
        workspace: workspaceRoot,
        terminals: terminalsDirectory,
      });

      await daemon.close();
      await daemon.close();
      await assert.rejects(waitForTcpListener("127.0.0.1", port, 100));
    } finally {
      await daemon.close().catch(() => {});
    }
  });

  it("starts the daemon, waits until it answers an authenticated call, and stops it again", async () => {
    const port = await freePort();
    const { workspaceRoot, terminalsDirectory } = workspace();
    const daemonLogs: string[] = [];
    const daemon = await launchBoxExecDaemon({
      daemonEntryPath: join(sourceRoot, "source/box-exec/cli.ts"),
      rpcPorts: productionSlateBoxPorts,
      bindPort: port,
      workspaceDirectory: workspaceRoot,
      terminalDirectory: terminalsDirectory,
      nodeExecutable: typeStrippingNode(),
      controlToken: "test-token",
      readinessTimeoutMs: 3_000,
      processEnvironment: {
        SLATE_BOX_EXEC_DAEMON_PORT: "1",
        SLATE_BOX_EXEC_DAEMON_AUTH_TOKEN: "incorrect",
        SLATE_BOX_WORKSPACE_ROOT: "/incorrect/workspace",
        SLATE_BOX_TERMINALS_DIRECTORY: "/incorrect/terminals",
      },
      output: { log: line => daemonLogs.push(line), error: () => {} },
    });
    try {
      assert.equal(typeof daemon.pid, "number");
      assert.equal(daemon.pid > 0, true);
      assert.notEqual(daemon.pid, process.pid);
      assert.equal(daemon.daemonEntryPath.endsWith("box-exec/cli.ts"), true);
      assert.equal(existsSync(workspaceRoot), true);
      assert.equal(existsSync(terminalsDirectory), true);
      await daemon.ready;
      assert.equal(daemonLogs.some(line => line.includes(workspaceRoot)), true);
      assert.equal(daemonLogs.some(line => line.includes(terminalsDirectory)), true);
      // It answers the box's own control call with the token it was started with, and the machine it was given.
      const control = productionSlateBoxPorts.createControlClient(createBoxTransport({ host: "127.0.0.1", port, authToken: "test-token" }, productionSlateBoxPorts.createTransport));
      assert.deepEqual(await control.ping(createContext(), {}, { timeoutMs: 2_000 }).then(() => "answered"), "answered");
      // It is the process this host owns: it stops when asked, and leaves nothing listening.
      await daemon.close();
      await assert.rejects(control.ping(createContext(), {}, { timeoutMs: 500 }));
      // Closing again is not an error, and neither is closing a daemon that has already stopped.
      await daemon.close();
    } finally {
      await daemon.close().catch(() => {});
    }
  });

  it("refuses to start on a port something else is already using", async () => {
    const taken = createServer();
    await new Promise<void>((resolve) => taken.listen(0, "127.0.0.1", resolve));
    const address = taken.address();
    assert.ok(address !== null && typeof address === "object");
    const { workspaceRoot, terminalsDirectory } = workspace();
    try {
      await launchBoxExecDaemon({
        daemonEntryPath: join(sourceRoot, "source/box-exec/main.ts"),
        rpcPorts: productionSlateBoxPorts,
        bindPort: address.port,
        workspaceDirectory: workspaceRoot,
        terminalDirectory: terminalsDirectory,
        nodeExecutable: typeStrippingNode(),
        output: { log: () => {}, error: () => {} },
      }).then(
        () => assert.fail("the daemon started on a port that was already bound"),
        (error: Error) => assert.equal(error.message, `refusing contaminated box exec-daemon startup: 127.0.0.1:${address.port} is already bound`),
      );
    } finally {
      await new Promise<void>((resolve) => taken.close(() => resolve()));
    }
    assert.equal(existsSync(workspaceRoot), false);
    assert.equal(existsSync(terminalsDirectory), false);
  });

  it("reports a daemon that is not there rather than waiting for one", async () => {
    const port = await freePort();
    const { workspaceRoot, terminalsDirectory } = workspace();
    await launchBoxExecDaemon({
      daemonEntryPath: join(workspaceRoot, "no-such-daemon.ts"),
      rpcPorts: productionSlateBoxPorts,
      bindPort: port,
      workspaceDirectory: workspaceRoot,
      terminalDirectory: terminalsDirectory,
      readinessTimeoutMs: 500,
      output: { log: () => {}, error: () => {} },
    }).then(
      () => assert.fail("a daemon that does not exist was started"),
      (error: Error) => assert.equal((error as Error & { code?: string }).code, "ENOENT"),
    );
    assert.equal(existsSync(workspaceRoot), false);
    assert.equal(existsSync(terminalsDirectory), false);
  });

  it("reports an early child exit with its status and forwards its output", async () => {
    const port = await freePort();
    const root = mkdtempSync(join(tmpdir(), "slate-box-early-exit-"));
    const entryPath = join(root, "exit.cjs");
    writeFileSync(entryPath, 'console.log(process.cwd()); console.log(process.env.SLATE_BOX_PROBE_MARKER); process.stderr.write("invalid config\\n"); setTimeout(() => { process.exitCode = 7; }, 30);');
    const { workspaceRoot, terminalsDirectory } = workspace();
    const logs: string[] = [];
    const errors: string[] = [];
    const previousMarker = process.env.SLATE_BOX_PROBE_MARKER;
    delete process.env.SLATE_BOX_PROBE_MARKER;
    try {
      await launchBoxExecDaemon({
        daemonEntryPath: entryPath,
        rpcPorts: productionSlateBoxPorts,
        bindPort: port,
        workspaceDirectory: workspaceRoot,
        terminalDirectory: terminalsDirectory,
        nodeExecutable: process.execPath,
        readinessTimeoutMs: 1_000,
        processEnvironment: { SLATE_BOX_PROBE_MARKER: "from-launch-options" },
        output: { log: line => logs.push(line), error: line => errors.push(line) },
      }).then(
        () => assert.fail("a process that exited before Ping was accepted"),
        (error: Error) => assert.match(error.message, /box exec-daemon exited before readiness: .*"code":7/),
      );
    } finally {
      if (previousMarker === undefined) delete process.env.SLATE_BOX_PROBE_MARKER;
      else process.env.SLATE_BOX_PROBE_MARKER = previousMarker;
    }
    const outputDeadline = Date.now() + 2_000;
    while (
      (!logs.join("\n").includes("from-launch-options") || errors.length === 0)
      && Date.now() < outputDeadline
    ) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(logs.join("\n").includes(`[box-exec-daemon] ${realpathSync(root)}`), true);
    assert.equal(logs.join("\n").includes("from-launch-options"), true);
    assert.deepEqual(errors, ["[box-exec-daemon] invalid config"]);
    assert.equal(existsSync(workspaceRoot), true);
    assert.equal(existsSync(terminalsDirectory), true);
  });

  it("stops a child that never answers the authenticated readiness call", async () => {
    const port = await freePort();
    const root = mkdtempSync(join(tmpdir(), "slate-box-no-readiness-"));
    const entryPath = join(root, "silent.cjs");
    writeFileSync(entryPath, 'const net = require("node:net"); const server = net.createServer(); server.listen(Number(process.env.SLATE_BOX_EXEC_DAEMON_PORT), "127.0.0.1"); process.on("SIGTERM", () => setTimeout(() => server.close(() => process.exit(0)), 150)); setInterval(() => {}, 1_000);');
    const { workspaceRoot, terminalsDirectory } = workspace();
    await assert.rejects(
      launchBoxExecDaemon({
        daemonEntryPath: entryPath,
        rpcPorts: productionSlateBoxPorts,
        bindPort: port,
        workspaceDirectory: workspaceRoot,
        terminalDirectory: terminalsDirectory,
        nodeExecutable: process.execPath,
        readinessTimeoutMs: 50,
        output: { log: () => {}, error: () => {} },
      }),
      /box exec-daemon did not answer authenticated generated Ping/,
    );
    assert.equal(existsSync(workspaceRoot), true);
    assert.equal(existsSync(terminalsDirectory), true);

    const probe = createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(port, "127.0.0.1", resolve);
    });
    await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  });

  it("forces down a daemon process that keeps its event loop alive after SIGTERM", async () => {
    const port = await freePort();
    const root = mkdtempSync(join(tmpdir(), "slate-box-forced-stop-"));
    const entryPath = join(root, "hold-open.cjs");
    const daemonCliPath = join(sourceRoot, "source/box-exec/cli.ts");
    const daemonCli = pathToFileURL(daemonCliPath).href;
    const keepAliveAfterReady = join(root, "ready");
    writeFileSync(entryPath, [
      "const fs = require(\"node:fs\");",
      `process.on("SIGTERM", () => { if (fs.existsSync(${JSON.stringify(keepAliveAfterReady)})) setInterval(() => {}, 1_000); else process.exit(0); });`,
      // The daemon CLI starts only when Node's entry path matches the imported file.
      `process.argv[1] = ${JSON.stringify(daemonCliPath)};`,
      `import(${JSON.stringify(daemonCli)});`,
    ].join("\n"));
    const { workspaceRoot, terminalsDirectory } = workspace();
    const daemon = await launchBoxExecDaemon({
      daemonEntryPath: entryPath,
      rpcPorts: productionSlateBoxPorts,
      bindPort: port,
      workspaceDirectory: workspaceRoot,
      terminalDirectory: terminalsDirectory,
      nodeExecutable: typeStrippingNode(),
      shutdownTimeoutMs: 50,
      output: { log: () => {}, error: () => {} },
    });

    writeFileSync(keepAliveAfterReady, "ready");
    await assert.rejects(daemon.close(), new RegExp(`box exec-daemon pid ${daemon.pid} required forced shutdown`));
    await daemon.close();
  });
});

describe("the generated pieces a box is built from", () => {
  it("binds this build's own package versions", () => {
    assert.equal(SLATE_BOX_PROTOCOL_VERSION, 1);
    assert.deepEqual(Object.keys(productionSlateBoxPorts), ["createTransport", "createControlClient", "createExecClient", "createResourceAccessor", "withFileReadGuard", "withNoMonitorComputerUse"]);
  });

  it("checks a read before it happens, and takes computer use out of the box's own hands", async () => {
    const calls: Array<[string, unknown]> = [];
    const base = { get: (resource: unknown) => ({ execute: async (_ctx: unknown, args: unknown) => {
      calls.push([resource === readExecutorResource ? "read" : resource === computerUseExecutorResource ? "computer-use" : "other", args]);
      return resource === readExecutorResource
        ? { kind: "success", path: "/workspace/notes.txt", totalLines: 0, fileSize: 0n, truncated: false, rangeApplied: false }
        : { result: { case: "success", value: { from: "base" } } };
    } }) };
    const guarded = productionSlateBoxPorts.withFileReadGuard(base as never, async (path: string) => {
      calls.push(["guard", path]);
      if (path === "/secret") throw new Error("that path is not readable here");
    });
    // The read is asked about first, and goes through when it may.
    assert.deepEqual(await guarded.get(readExecutorResource).execute(createContext(), { path: "/workspace/notes.txt" }, undefined), {
      kind: "success", path: "/workspace/notes.txt", totalLines: 0, fileSize: 0n, truncated: false, rangeApplied: false,
    });
    assert.deepEqual(calls, [["guard", "/workspace/notes.txt"], ["read", { path: "/workspace/notes.txt" }]]);
    calls.length = 0;
    // A read that is not allowed never reaches the box.
    await guarded.get(readExecutorResource).execute(createContext(), { path: "/secret" } as never, undefined).then(
      () => assert.fail("a read that was refused went through"),
      (error: Error) => assert.equal(error.message, "that path is not readable here"),
    );
    assert.deepEqual(calls, [["guard", "/secret"]]);

    calls.length = 0;
    const unmonitored = productionSlateBoxPorts.withNoMonitorComputerUse(base as never);
    // A box without a private desktop says so instead of pretending it took a screenshot.
    assert.equal(isNoMonitorComputerUseExecutor(unmonitored.get(computerUseExecutorResource)), true);
    await unmonitored.get(computerUseExecutorResource).execute(createContext(), { toolCallId: "call-1", actions: [{ kind: "screenshot" }] } as never, undefined).then(
      () => assert.fail("computer use ran on a box that has no private desktop"),
      (error: Error) => assert.equal(error.message, "No private desktop monitor is available on the shared box."),
    );
    assert.deepEqual(calls, []);
  });

  it("builds an accessor and a client over what the box is given", () => {
    const accessor = productionSlateBoxPorts.createResourceAccessor({} as never);
    assert.equal(typeof accessor.get, "function");
    const client = productionSlateBoxPorts.createExecClient({} as never);
    assert.equal(typeof client.exec, "function");
  });
});
