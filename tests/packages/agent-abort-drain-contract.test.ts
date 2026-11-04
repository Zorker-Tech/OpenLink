import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createContext } from "../../source/packages/context/context.ts";
import { loggerKey, type ContextLogEntry } from "../../source/packages/context/logging.ts";
import { metricsKey, type MetricHandle, type MetricLabels, type MetricsBackend } from "../../source/packages/metrics/index.ts";
import { drainPendingWritesOnRunStreamError } from "../../source/packages/agent/abort-drain.ts";

interface MetricCall {
  readonly operation: "record" | "increment" | "gauge" | "histogram";
  readonly handle: MetricHandle;
  readonly value: number;
  readonly labels: MetricLabels | undefined;
}

function telemetryContext() {
  const metrics: MetricCall[] = [];
  const logs: ContextLogEntry[] = [];
  const write = (operation: MetricCall["operation"]) => (
    _context: Parameters<MetricsBackend["record"]>[0],
    handle: MetricHandle,
    value: number,
    labels?: MetricLabels,
  ) => metrics.push({ operation, handle, value, labels });
  const backend: MetricsBackend = {
    record: write("record"),
    increment: write("increment"),
    gauge: write("gauge"),
    histogram: write("histogram"),
  };
  const context = createContext()
    .with(metricsKey, backend)
    .with(loggerKey, { log: (_context, entry) => logs.push(entry) });
  return { context, metrics, logs };
}

describe("the bounded drain after a run fails", () => {
  it("waits for checkpoints and flush, counts success, and stays quiet", async () => {
    const state = telemetryContext();
    let flushFinished = false;
    await drainPendingWritesOnRunStreamError(state.context, {
      pendingCheckpoints: Promise.resolve(),
      flush: async () => { flushFinished = true; },
    });

    assert.equal(flushFinished, true);
    assert.deepEqual(state.metrics.map(({ operation, handle, value, labels }) => ({
      operation,
      name: handle.name,
      value,
      labels,
    })), [{
      operation: "increment",
      name: "agent.run_stream.abort_drain",
      value: 1,
      labels: { outcome: "succeeded" },
    }]);
    assert.deepEqual(state.logs, []);
  });

  it("records a bounded timeout and returns without throwing", async () => {
    const state = telemetryContext();
    await assert.doesNotReject(() => drainPendingWritesOnRunStreamError(state.context, {
      pendingCheckpoints: Promise.resolve(),
      flush: () => new Promise(() => {}),
      timeoutMs: 5,
    }));

    assert.equal(state.metrics[0]?.labels?.outcome, "timed_out");
    assert.equal(state.logs[0]?.level, "warn");
    assert.equal(state.logs[0]?.scope, "agent/abort-drain");
    assert.equal(state.logs[0]?.message, "Pending transcript writes did not finish before run shutdown");
    assert.deepEqual(state.logs[0]?.metadata?.outcome, "timed_out");
    assert.deepEqual(state.logs[0]?.metadata?.timeoutMs, 5);
  });

  it("starts flush even when checkpoint persistence fails, records failure, and does not throw", async () => {
    const state = telemetryContext();
    const failure = new Error("checkpoint write failed");
    let flushStarted = false;
    await assert.doesNotReject(() => drainPendingWritesOnRunStreamError(state.context, {
      pendingCheckpoints: Promise.reject(failure),
      flush: async () => { flushStarted = true; },
    }));

    assert.equal(flushStarted, true);
    assert.equal(state.metrics[0]?.labels?.outcome, "failed");
    assert.equal(state.logs[0]?.level, "warn");
    assert.equal(state.logs[0]?.metadata?.error, failure);
    assert.equal(state.logs[0]?.metadata?.outcome, "failed");
  });
});
