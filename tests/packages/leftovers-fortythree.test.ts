/**
 * The local-exec daemon's own process and what the computer tool needs from the host.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createHostBrowserDriverDependencies, createHostComputerToolDependencies, createHostShellExecutor } from "../../source/host/runner/host-computer-tool-dependencies.ts";
import { toGeneratedComputerUseArgs } from "../../source/adapters/interop/agent/computer-use-executor-adapter.ts";

describe("what the computer tool needs from the host", () => {
  it("gathers the desktop, the monitor and the approvals in one place", () => {
    assert.equal(typeof createHostComputerToolDependencies, "function");
    assert.equal(typeof createHostBrowserDriverDependencies, "function");
    assert.equal(typeof createHostShellExecutor, "function");
    assert.equal(typeof toGeneratedComputerUseArgs, "function");
  });
});
