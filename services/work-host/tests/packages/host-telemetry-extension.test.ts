/**
 * Telemetry, as the host extension declares it: what it depends on, the service it brings up with the platform's own
 * policies, and the surface it hands the host — brought up and taken down with nothing left running.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { HostExtensions } from "../../source/host/extensions/extension-ids.generated.ts";
import { SlateStructuredLogTelemetry } from "../../source/host/telemetry/structured-log-telemetry.ts";
import { FATAL_TELEMETRY_FLUSH_TIMEOUT_MS, HOST_CRASH_MARKER_FORWARD_INTERVAL_MS, HOST_LIFECYCLE_STUCK_MS, STRUCTURED_LOG_SUBMIT_DEADLINE_MS, telemetryExtension } from "../../source/host/telemetry/extension.ts";

const tick = () => new Promise((resolve) => setImmediate(resolve));

/** The three parts the extension is given: a signed-in account, the platform's gates, and the inference port. */
function extensionWorld() {
  const renewals: ((result: { outcome: string; consecutiveFailures: number; durationMs: number; errorSummary?: string }) => void)[] = [];
  const modelApplied: (() => void)[] = [];
  return {
    deps: {
      [HostExtensions.Auth]: {
        peekAccessToken: () => "token",
        getAccessToken: async () => "token",
        getMachineId: async () => "machine-1",
        subscribeToRenewal: (listener: (result: { outcome: string; consecutiveFailures: number; durationMs: number }) => void) => (renewals.push(listener), () => void renewals.splice(renewals.indexOf(listener), 1)),
        getLastRenewalEvent: () => null,
      },
      [HostExtensions.Experiments]: {
        checkGate: async () => false,
        subscribe: () => () => {},
        hasHydratedExperimentUser: () => true,
        waitForHydratedExperimentUser: async () => true,
        getSlateModelExperimentState: () => null,
        logSlateModelExperimentExposure: () => true,
        getDynamicConfig: () => undefined,
        checkFeatureGate: () => false,
      },
      [HostExtensions.Inference]: {
        onModelExperimentApplied: (listener: () => void) => (modelApplied.push(listener), () => void modelApplied.splice(modelApplied.indexOf(listener), 1)),
      },
    },
    renewals,
    modelApplied,
  };
}

describe("the telemetry extension", () => {
  it("declares what it is and what it needs before it can report anything", () => {
    assert.equal(telemetryExtension.id, HostExtensions.Telemetry);
    assert.deepEqual(telemetryExtension.dependencies, [HostExtensions.Auth, HostExtensions.Experiments, HostExtensions.Inference]);
    // The policies it runs on are the platform's own numbers.
    assert.deepEqual([FATAL_TELEMETRY_FLUSH_TIMEOUT_MS, HOST_CRASH_MARKER_FORWARD_INTERVAL_MS, HOST_LIFECYCLE_STUCK_MS, STRUCTURED_LOG_SUBMIT_DEADLINE_MS], [2_000, 5 * 60_000, 5 * 60_000, 15_000]);
  });

  it("brings the service up, hands the host its surface, and takes it down when the host stops", async () => {
    const world = extensionWorld();
    const teardowns: (() => void | Promise<void>)[] = [];
    const originalLog = console.log;
    const originalWarn = console.warn;
    const quiet: string[] = [];
    const silentLog = () => {};
    console.log = silentLog;
    console.warn = (...args: unknown[]) => void quiet.push(args.join(" "));
    try {
      const api = (await telemetryExtension.start({ deps: world.deps, host: {}, onStop: (teardown: () => void | Promise<void>) => void teardowns.push(teardown) } as never)) as {
        logs: unknown;
        brain: unknown;
        analytics: { canRecordEvents(): boolean };
        createHostLifecycleProgress(startedAt: number): { complete(completion: { phase: string; pluginCount?: number }): void };
        setHostBundleIdentity(identity: { hostBundleVersion?: string; boxStoreId?: string }): Promise<void>;
        flushForFatalExit(): Promise<void>;
        reportMessageSent(report: { agentId: string; prompt?: string; isGroupRoom: boolean }): void;
        noteSlateModelExperimentActive(): void;
      };
      assert.deepEqual(Object.keys(api).sort(), ["analytics", "brain", "createHostLifecycleProgress", "flushForFatalExit", "flushTracing", "logs", "noteSlateModelExperimentActive", "reportMessageSent", "setHostBundleIdentity"]);
      // The log is the platform's own, and the analytics answers whether it may report at all.
      assert.equal(api.logs instanceof SlateStructuredLogTelemetry, true);
      assert.equal(typeof api.analytics.canRecordEvents(), "boolean");
      // Once it is up, what is written to the console is also written down.
      assert.notEqual(console.log, silentLog);
      // The phases are reported through that log, and a message being sent is counted without throwing.
      const progress = api.createHostLifecycleProgress(1);
      assert.doesNotThrow(() => progress.complete({ phase: "plugin_graph", pluginCount: 1 }));
      assert.doesNotThrow(() => api.reportMessageSent({ agentId: "agent-1", prompt: "hello", isGroupRoom: false }));
      assert.doesNotThrow(() => api.noteSlateModelExperimentActive());
      // Knowing which bundle the host is lets the log ship and starts watching for a marker a crashed host left.
      await assert.doesNotReject(() => api.setHostBundleIdentity({ hostBundleVersion: "1.2.3" }));
      await assert.doesNotReject(() => api.flushForFatalExit());
      assert.equal(teardowns.length, 1);
      // Taking it down puts the console back exactly as it was.
      await teardowns[0]!();
      assert.equal(console.log, silentLog);
    } finally {
      console.log = originalLog;
      console.warn = originalWarn;
      await tick();
    }
  });
});
