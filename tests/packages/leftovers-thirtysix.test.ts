/**
 * A turn's observation, the subagent runtime and the worker pool agents' work runs in.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createTurnObservation, MCP_EXEC_STALL_THRESHOLD_MS } from "../../source/host/runner/turn-observation.ts";
import { computeSubagentRequestId, createSubagentRuntime, subagentSteerRunOptions } from "../../source/host/runner/subagent-runtime.ts";
import { AgentWorkerConnection, AgentWorkerPool, DEFAULT_IDLE_TIMEOUT_MS, DEFAULT_MAX_WORKERS, DEFAULT_SWEEP_INTERVAL_MS, MAX_FORWARDED_WORKER_LINE_BYTES } from "../../source/host/agents/isolation/agent-worker-pool.ts";

describe("what a turn looks like while it runs", () => {
  it("gives a stalled MCP call its own threshold", () => {
    assert.equal(MCP_EXEC_STALL_THRESHOLD_MS, 900_000);
    assert.equal(typeof createTurnObservation, "function");
  });
});

describe("running a subagent", () => {
  it("is created with its own conversation, and its work is named", () => {
    assert.equal(typeof createSubagentRuntime, "function");
    assert.equal(typeof computeSubagentRequestId, "function");
    assert.equal(typeof subagentSteerRunOptions, "function");
  });
});

describe("the pool agents' work runs in", () => {
  it("bounds how many workers run, how long they idle and what a line may carry", () => {
    assert.equal(DEFAULT_MAX_WORKERS, 64);
    assert.equal(DEFAULT_IDLE_TIMEOUT_MS, 300_000);
    assert.equal(DEFAULT_SWEEP_INTERVAL_MS, 30_000);
    assert.equal(MAX_FORWARDED_WORKER_LINE_BYTES, 8_192);
    assert.equal(typeof AgentWorkerPool, "function");
    assert.equal(typeof AgentWorkerConnection, "function");
  });
});
