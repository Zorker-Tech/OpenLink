/**
 * Driving a box's desktop: window allocation, remote-box preparation (including the browser prewarm), audit counts,
 * turn/model usage and the navigation probe.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { createComputerUseCoordination } from "../../source/host/runner/computer-use.ts";
import { computerUseExecutorResource } from "../../source/packages/agent-exec/computer-use.ts";
import { shellExecutorResource } from "../../source/packages/agent-exec/shell.ts";
import { noMonitorComputerUseExecutor } from "../../source/host/ports/box.ts";

const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

function world(options: Record<string, unknown> = {}) {
  const diagnostics: unknown[] = [];
  const shellCalls: unknown[] = [];
  const auditRecords: unknown[] = [];
  const connection = {
    remoteAccessor: {
      get(resource: unknown) {
        if (resource === computerUseExecutorResource) return options.noMonitor === true ? noMonitorComputerUseExecutor : { async execute() { return "computer"; } };
        if (resource === shellExecutorResource) return { async execute(_ctx: unknown, args: unknown) { shellCalls.push(args); if (options.shellFails === true) throw new Error("prepare failed"); return "shell"; } };
        return undefined;
      },
    },
  };
  const coordination = createComputerUseCoordination({
    ctx: {} as never,
    remoteBox: { async ensureReady() { if (options.ensureFails === true) throw new Error("box not ready"); return options.badAccessor === true ? { remoteAccessor: {} as never } : connection as never; } },
    getConversationId: () => "conv-1",
    resolveBoxId: () => "box-1",
    actionAuditor: () => options.auditor === false ? undefined : { record: (record: unknown) => auditRecords.push(record) },
    ...(options.diagnostics === false ? {} : { reportDiagnostic: (diagnostic: unknown) => diagnostics.push(diagnostic) }),
    ...(options.classify === undefined ? {} : { classifyError: options.classify as (error: unknown) => string }),
  });
  return { coordination, diagnostics, shellCalls, auditRecords };
}

test("a window is claimed once and refused while the primary one is busy", () => {
  const w = world();
  assert.equal(w.coordination.allocateWindow("sub-1"), 1);
  assert.equal(w.coordination.allocateWindow("sub-1"), 1);
  assert.equal(w.coordination.allocateWindow("sub-2"), null);
  w.coordination.freeWindow("sub-1");
  assert.equal(w.coordination.allocateWindow("sub-2"), 1);
});

test("preparing a remote box prewarms the browser and records the shell call", async () => {
  const w = world();
  const connection = await w.coordination.prepareRemoteBox({ agentId: "agent-1", boxId: "box-1" });
  assert.equal(typeof connection!.remoteAccessor, "object");
  await w.coordination.preparationFor("agent-1");
  assert.equal(w.shellCalls.length, 1);
  const shellArgs = w.shellCalls[0] as { command: string; name: string; workingDirectory: string; toolCallId: string; skipApproval: boolean };
  assert.equal(shellArgs.command, "box-chrome --slate-prepare");
  assert.equal(shellArgs.workingDirectory, "/workspace");
  assert.equal(shellArgs.toolCallId, "slate-cua-browser-prepare-agent-1");
  assert.equal(shellArgs.skipApproval, true);
});

test("a box without a monitor needs no browser prewarm", async () => {
  const w = world({ noMonitor: true });
  await w.coordination.prepareRemoteBox({ agentId: "agent-2", boxId: "box-1" });
  await flush();
  assert.equal(w.shellCalls.length, 0);
  assert.equal(w.diagnostics.length, 0);
});

test("a box that is not ready reports a box diagnostic and prepares nothing", async () => {
  const w = world({ ensureFails: true });
  w.coordination.prepareRemoteBox({ agentId: "agent-3", boxId: "box-1" });
  await flush();
  assert.deepEqual(w.diagnostics, [{ kind: "computer_use_prewarm_skipped", stage: "box", errorClass: "Error" }]);
  assert.equal(await w.coordination.preparationFor("agent-3"), undefined);
});

test("a broken accessor and a failed browser prewarm each report a browser diagnostic", async () => {
  const bad = world({ badAccessor: true });
  bad.coordination.prepareRemoteBox({ agentId: "agent-4", boxId: "box-1" });
  await flush();
  assert.deepEqual(bad.diagnostics, [{ kind: "computer_use_prewarm_skipped", stage: "browser", errorClass: "TypeError" }]);
  const failing = world({ shellFails: true });
  failing.coordination.prepareRemoteBox({ agentId: "agent-5", boxId: "box-1" });
  await flush();
  assert.deepEqual(failing.diagnostics, [{ kind: "computer_use_prewarm_skipped", stage: "browser", errorClass: "Error" }]);
});

test("an injected classifier names the diagnostic error class", async () => {
  const w = world({ ensureFails: true, classify: () => "classified-kind" });
  w.coordination.prepareRemoteBox({ agentId: "agent-6", boxId: "box-1" });
  await flush();
  assert.deepEqual(w.diagnostics, [{ kind: "computer_use_prewarm_skipped", stage: "box", errorClass: "classified-kind" }]);
});

test("audit intents are counted by kind, and only when an auditor exists", () => {
  const w = world();
  w.coordination.recordAuditIntent("screenshot");
  w.coordination.recordAuditIntent("click");
  w.coordination.recordAuditIntent("screenshot");
  w.coordination.recordAuditIntent("unknownAction");
  assert.deepEqual([...w.coordination.auditActionCounts().entries()].sort(), [["click", 1], ["screenshot", 2]]);
  assert.equal(w.auditRecords.length, 0);
  const noAuditor = world({ auditor: false });
  noAuditor.coordination.recordAuditIntent("click");
  assert.equal(noAuditor.coordination.auditActionCounts().size, 0);
});

test("the usage snapshot names no model, one model or a mixed set", () => {
  const w = world();
  assert.deepEqual(w.coordination.usageSnapshot(), { modelId: undefined, turnEndedCount: 0, usage: undefined });
  w.coordination.recordModelId("model-a");
  assert.equal(w.coordination.usageSnapshot().modelId, "model-a");
  w.coordination.recordTurnEnded({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 });
  w.coordination.recordTurnEnded(undefined);
  w.coordination.recordModelId("model-b");
  const snapshot = w.coordination.usageSnapshot();
  assert.equal(snapshot.modelId, "mixed");
  assert.equal(snapshot.turnEndedCount, 2);
  assert.deepEqual(snapshot.usage, { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 });
});

test("the navigation probe is only created with an auditor, and is cached", () => {
  const withoutAuditor = world({ auditor: false });
  assert.equal(withoutAuditor.coordination.getOrCreateNavigationProbe(), undefined);
  const w = world();
  const first = w.coordination.getOrCreateNavigationProbe();
  const second = w.coordination.getOrCreateNavigationProbe();
  assert.notEqual(first, undefined);
  assert.equal(first, second);
});
