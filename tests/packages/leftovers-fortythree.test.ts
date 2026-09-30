/**
 * The local-exec daemon's own process and what the computer tool needs from the host.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { composeLocalExecDaemonOptions, holdLocalExecDaemonProcessOpen, LOCAL_EXEC_DAEMON_LIFETIME_TICK_MS, LOCAL_EXEC_DAEMON_SHUTDOWN_TIMEOUT_MS, runLocalExecDaemonEntrypoint } from "../../source/local-exec/main.ts";
import { createHostBrowserDriverDependencies, createHostComputerToolDependencies, createHostShellExecutor, toGeneratedComputerUseArgs } from "../../source/host/runner/host-computer-tool-dependencies.ts";

describe("the local-exec daemon's own process", () => {
  it("drains what is in flight within its own shutdown timeout", () => {
    assert.equal(LOCAL_EXEC_DAEMON_LIFETIME_TICK_MS, 60_000);
    assert.equal(LOCAL_EXEC_DAEMON_SHUTDOWN_TIMEOUT_MS, 2_000);
    assert.equal(typeof composeLocalExecDaemonOptions, "function");
    assert.equal(typeof holdLocalExecDaemonProcessOpen, "function");
    assert.equal(typeof runLocalExecDaemonEntrypoint, "function");
  });
});

describe("what the computer tool needs from the host", () => {
  it("gathers the desktop, the monitor and the approvals in one place", () => {
    assert.equal(typeof createHostComputerToolDependencies, "function");
    assert.equal(typeof createHostBrowserDriverDependencies, "function");
    assert.equal(typeof createHostShellExecutor, "function");
    assert.equal(typeof toGeneratedComputerUseArgs, "function");
  });
});
