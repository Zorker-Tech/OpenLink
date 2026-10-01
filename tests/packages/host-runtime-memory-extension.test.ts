/**
 * What an agent remembers, as a host extension: the gate that decides whether remembering is reviewed, the service the
 * rest of the host talks to, and the per-agent state a tool writes through.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { memoryExtension } from "../../source/host/memory/extension.ts";
import { HostExtensions } from "../../source/host/extensions/extension-ids.generated.ts";

/** The host around the extension: the platform's own gate, the inference port, the telemetry and what it stops. */
function harness() {
  const reports: unknown[] = [];
  const syntheses: Array<{ started: number; disposed: number; recorded: string[] }> = [];
  const stops: Array<() => void> = [];
  const pinnedNames: string[] = [];
  let gateListener: ((enabled: boolean) => void) | undefined;
  const context = {
    slateRoot: mkdtempSync(join(tmpdir(), "slate-memory-extension-")),
    agentsRootDir: mkdtempSync(join(tmpdir(), "slate-memory-agents-")),
    debounce: { name: "memory", wrap: <T extends (...args: never[]) => unknown>(fn: T) => Object.assign(fn, { dispose() {} }) },
    deps: {
      experiments: { pinGateOnAuthenticatedBootstrap: (name: string, listener: (enabled: boolean) => void) => { pinnedNames.push(name); gateListener = listener; } },
      inference: { port: { createSession: () => ({ getExecutor: () => ({}) }) } },
      telemetry: { logs: { reportMemorySynthesis: (report: unknown) => { reports.push(report); } } },
    },
    createSynthesis: () => {
      const entry = { started: 0, disposed: 0, recorded: [] as string[] };
      syntheses.push(entry);
      return { start: () => { entry.started += 1; }, dispose: () => { entry.disposed += 1; }, recordTurn: (agentId: string) => { entry.recorded.push(agentId); } };
    },
    onStop: (teardown: () => void) => { stops.push(teardown); },
  };
  return { context, reports, syntheses, stops, pinnedNames, gate: (enabled: boolean) => gateListener?.(enabled), pinned: () => gateListener !== undefined };
}

describe("memory as a host extension", () => {
  it("registers under its own id with what it depends on", () => {
    assert.equal(memoryExtension.id, HostExtensions.Memory);
    assert.equal(memoryExtension.id, "memory");
    assert.deepEqual(memoryExtension.dependencies, ["experiments", "inference", "telemetry"]);
  });

  it("holds back the review of what is remembered while the platform's gate is off", () => {
    const { context, reports, syntheses, stops, gate, pinned, pinnedNames } = harness();
    const api = memoryExtension.start(context as never);
    // The gate is asked for by name before anything is reviewed.
    assert.equal(pinned(), true);
    assert.deepEqual(pinnedNames, ["slate_memory_dreaming"]);
    assert.deepEqual(syntheses, []);
    gate(false);
    // A gate that is off is reported as such rather than passed over in silence.
    assert.deepEqual(reports, [{ outcome: "skipped_gate" }]);
    assert.deepEqual(syntheses, []);
    // The service is still the platform's; only the review is held back.
    assert.equal(typeof api.list, "function");
    assert.equal(typeof api.createAgentState, "function");
    // Stopping the host disposes of the service.
    assert.equal(stops.length, 1);
    stops[0]?.();
  });

  it("reviews what is remembered through the platform's own session once the gate is on", () => {
    const { context, reports, syntheses, stops, gate } = harness();
    const api = memoryExtension.start(context as never);
    gate(true);
    assert.deepEqual(reports, []);
    assert.equal(syntheses.length, 1);
    assert.equal(syntheses[0]?.started, 1);
    // A turn is recorded through the review the platform started.
    assert.equal(typeof api.synthesisTargetForAgent, "function");
    assert.equal(stops.length, 1);
    stops[0]?.();
    assert.equal(syntheses[0]?.disposed, 1);
  });

  it("creates the state a tool writes an agent's own facts through", async () => {
    const { context, stops, gate } = harness();
    const api = memoryExtension.start(context as never);
    gate(false);
    const agentDir = join(context.agentsRootDir, "agent-1");
    const state = api.createAgentState({ agentId: "agent-1", agentDir, memory: { addMemory: () => null, removeMemoryByContent: () => false }, membership: undefined, channels: { remove: () => false }, automations: { upsert: () => null, update: () => null, setEnabled: () => null, get: () => null, remove: () => false }, workflows: { create: () => null, update: () => null, remove: () => false }, readProfile: () => null, writeProfile: () => {}, writeSettings: () => {} } as never);
    // The state knows which agent it is and where it lives, and it is created against the root the host runs under.
    assert.equal(typeof state.writeMemory, "function");
    assert.equal((await state.updateProfile({ name: "Notes" })).ok, true);
    stops[0]?.();
  });
});
