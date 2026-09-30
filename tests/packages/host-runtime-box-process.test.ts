/**
 * The host's runtime pieces, thirteenth group: the switches the box's extension reads, the exec daemon as a process this
 * host owns, and the generated pieces the box is built from.
 */

import assert from "node:assert/strict";
import { createServer } from "node:net";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { computerUseExecutorResource } from "../../source/packages/agent-exec/computer-use.ts";
import { readExecutorResource } from "../../source/packages/agent-exec/read-operation.ts";
import { createContext } from "../../source/packages/context/context.ts";
import { createBoxTransport } from "../../source/host/boxes/box-remote-accessor.ts";
import { BOX_EXEC_DAEMON_ENTRY_RELATIVE, BOX_EXEC_DAEMON_START_TIMEOUT_MS, BOX_EXEC_DAEMON_STOP_TIMEOUT_MS, resolveBoxExecDaemonEntry, startBoxExecDaemonProcess } from "../../source/host/boxes/exec-daemon-process.ts";
import { createForeverBoxExtension, foreverBoxExtension, imageWatchIntervalMs, imageWatchJitterRatio, initialImageWatchDelayMs, isHostBundleAutoUpdateEnabled, isImageAutoUpdateEnabled, jitteredImageWatchIntervalMs } from "../../source/host/boxes/forever-box/extension.ts";
import { BOX_GENERATED_PACKAGE_VERSIONS, productionBoxGeneratedPorts } from "../../source/host/boxes/generated-production.ts";
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

  const workspace = () => ({ workspaceRoot: mkdtempSync(join(tmpdir(), "slate-box-workspace-")), terminalsDirectory: mkdtempSync(join(tmpdir(), "slate-box-terminals-")) });

  it("resolves the daemon's entry beside the host's own", () => {
    assert.equal(BOX_EXEC_DAEMON_ENTRY_RELATIVE, "../box-exec/main.cjs");
    assert.equal(BOX_EXEC_DAEMON_START_TIMEOUT_MS, 20_000);
    assert.equal(BOX_EXEC_DAEMON_STOP_TIMEOUT_MS, 5_000);
    assert.equal(resolveBoxExecDaemonEntry("/app/host/main.cjs"), "/app/box-exec/main.cjs");
    // Without a host entry there is nowhere to resolve the daemon's from — neither an empty one nor a process that
    // was started without one.
    assert.throws(() => resolveBoxExecDaemonEntry(""), { message: "cannot resolve box exec-daemon entry without a host process entry" });
    const argv = process.argv as unknown as Array<string | undefined>;
    const saved = argv[1];
    try {
      argv[1] = undefined;
      assert.throws(() => resolveBoxExecDaemonEntry(), { message: "cannot resolve box exec-daemon entry without a host process entry" });
    } finally {
      argv[1] = saved;
    }
  });

  it("starts the daemon, waits until it answers an authenticated call, and stops it again", async () => {
    const port = await freePort();
    const { workspaceRoot, terminalsDirectory } = workspace();
    const daemon = await startBoxExecDaemonProcess({
      entryPath: join(sourceRoot, "source/box-exec/cli.ts"),
      generated: productionBoxGeneratedPorts,
      port,
      workspaceRoot,
      terminalsDirectory,
      execPath: typeStrippingNode(),
      authToken: "test-token",
      log: { log: () => {}, error: () => {} },
    });
    try {
      assert.equal(typeof daemon.pid, "number");
      assert.equal(daemon.entryPath.endsWith("box-exec/cli.ts"), true);
      await daemon.ready;
      // It answers the box's own control call with the token it was started with, and the machine it was given.
      const control = productionBoxGeneratedPorts.createControlClient(createBoxTransport({ host: "127.0.0.1", port, authToken: "test-token" }, productionBoxGeneratedPorts.createTransport));
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
      await startBoxExecDaemonProcess({
        entryPath: join(sourceRoot, "source/box-exec/main.ts"),
        generated: productionBoxGeneratedPorts,
        port: address.port,
        workspaceRoot,
        terminalsDirectory,
        execPath: typeStrippingNode(),
        log: { log: () => {}, error: () => {} },
      }).then(
        () => assert.fail("the daemon started on a port that was already bound"),
        (error: Error) => assert.equal(error.message, `refusing contaminated box exec-daemon startup: 127.0.0.1:${address.port} is already bound`),
      );
    } finally {
      await new Promise<void>((resolve) => taken.close(() => resolve()));
    }
  });

  it("reports a daemon that is not there rather than waiting for one", async () => {
    const port = await freePort();
    const { workspaceRoot, terminalsDirectory } = workspace();
    await startBoxExecDaemonProcess({
      entryPath: join(workspaceRoot, "no-such-daemon.ts"),
      generated: productionBoxGeneratedPorts,
      port,
      workspaceRoot,
      terminalsDirectory,
      startTimeoutMs: 500,
      log: { log: () => {}, error: () => {} },
    }).then(
      () => assert.fail("a daemon that does not exist was started"),
      (error: Error) => assert.equal((error as Error & { code?: string }).code, "ENOENT"),
    );
  });
});

describe("the generated pieces a box is built from", () => {
  it("binds this build's own package versions", () => {
    assert.equal(Object.isFrozen(BOX_GENERATED_PACKAGE_VERSIONS), true);
    assert.deepEqual(BOX_GENERATED_PACKAGE_VERSIONS, { protobuf: "1.10.1", connect: "1.6.1", connectNode: "1.6.1" });
    assert.deepEqual(Object.keys(productionBoxGeneratedPorts), ["createTransport", "createControlClient", "createExecClient", "createResourceAccessor", "withFileReadGuard", "withNoMonitorComputerUse"]);
  });

  it("checks a read before it happens, and takes computer use out of the box's own hands", async () => {
    const calls: Array<[string, unknown]> = [];
    const base = { get: (resource: unknown) => ({ execute: async (_ctx: unknown, args: unknown) => { calls.push([resource === readExecutorResource ? "read" : resource === computerUseExecutorResource ? "computer-use" : "other", args]); return { result: { case: "success", value: { from: "base" } } }; } }) };
    const guarded = productionBoxGeneratedPorts.withFileReadGuard(base as never, async (path: string) => {
      calls.push(["guard", path]);
      if (path === "/secret") throw new Error("that path is not readable here");
    });
    // The read is asked about first, and goes through when it may.
    assert.deepEqual(await guarded.get(readExecutorResource).execute(createContext(), { path: "/workspace/notes.txt" } as never, undefined) as unknown, { result: { case: "success", value: { from: "base" } } });
    assert.deepEqual(calls, [["guard", "/workspace/notes.txt"], ["read", { path: "/workspace/notes.txt" }]]);
    calls.length = 0;
    // A read that is not allowed never reaches the box.
    await guarded.get(readExecutorResource).execute(createContext(), { path: "/secret" } as never, undefined).then(
      () => assert.fail("a read that was refused went through"),
      (error: Error) => assert.equal(error.message, "that path is not readable here"),
    );
    assert.deepEqual(calls, [["guard", "/secret"]]);

    calls.length = 0;
    const unmonitored = productionBoxGeneratedPorts.withNoMonitorComputerUse(base as never);
    // A box without a private desktop says so instead of pretending it took a screenshot.
    assert.equal(isNoMonitorComputerUseExecutor(unmonitored.get(computerUseExecutorResource)), true);
    await unmonitored.get(computerUseExecutorResource).execute(createContext(), { action: "screenshot" } as never, undefined).then(
      () => assert.fail("computer use ran on a box that has no private desktop"),
      (error: Error) => assert.equal(error.message, "No private desktop monitor is available on the shared box."),
    );
    assert.deepEqual(calls, []);
  });

  it("builds an accessor and a client over what the box is given", () => {
    const accessor = productionBoxGeneratedPorts.createResourceAccessor({} as never);
    assert.equal(typeof accessor.get, "function");
    const client = productionBoxGeneratedPorts.createExecClient({} as never);
    assert.equal(typeof client.exec, "function");
  });
});
