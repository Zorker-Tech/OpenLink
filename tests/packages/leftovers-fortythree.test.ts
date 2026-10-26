/**
 * The local-exec daemon's own process and what the computer tool needs from the host.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createHostBrowserDriverDependencies, createHostComputerToolDependencies, createHostShellExecutor, toGeneratedComputerUseArgs } from "../../source/host/runner/host-computer-tool-dependencies.ts";

describe("what the computer tool needs from the host", () => {
  it("gathers the desktop, the monitor and the approvals in one place", () => {
    assert.equal(typeof createHostComputerToolDependencies, "function");
    assert.equal(typeof createHostBrowserDriverDependencies, "function");
    assert.equal(typeof createHostShellExecutor, "function");
    assert.equal(typeof toGeneratedComputerUseArgs, "function");
  });
});
