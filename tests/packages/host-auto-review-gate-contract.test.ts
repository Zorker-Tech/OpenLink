import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AutoReviewApprovalWaitError,
  createAutoReviewGate,
  type AutoReviewModes,
} from "../../source/host/runner/auto-review-gate.ts";

function modes(mode: "off" | "shadow" | "enforce" = "enforce"): AutoReviewModes {
  return {
    hostShell: mode,
    boxShell: mode,
    mcp: mode,
    computer: mode,
    automationWrite: mode,
    cloudAgent: mode,
    subagentLaunch: mode,
  };
}

test("live mode changes expire only surfaces that no longer enforce review", () => {
  let live = modes();
  const expired: Set<string>[] = [];
  const gate = createAutoReviewGate({
    baseModes: modes("off"),
    getModes: () => live,
    controller: () => ({ expireSurfaces: (surfaces: Set<string>) => expired.push(surfaces) }) as never,
    resolveBoxId: () => "box-a",
  });

  assert.deepEqual(gate.currentModes(), modes());
  assert.deepEqual([...expired[0]!], []);
  live = { ...modes("off"), hostShell: "enforce" };
  assert.deepEqual(gate.currentModes(), live);
  assert.deepEqual([...expired[1]!].sort(), [
    "automation_write",
    "box_shell",
    "cloud_agent",
    "computer",
    "mcp",
    "subagent",
  ]);
});

test("a pending review blocks a new side effect until the decision is settled", () => {
  let pending = [{ id: "approval-a" }];
  const gate = createAutoReviewGate({
    baseModes: modes(),
    controller: () => ({ getPendingApprovals: () => pending }) as never,
    resolveBoxId: () => "box-a",
  });

  assert.throws(gate.assertNoPendingApproval, AutoReviewApprovalWaitError);
  pending = [];
  assert.doesNotThrow(gate.assertNoPendingApproval);
});

test("review instructions are copied for each prompt and empty guidance is omitted", () => {
  const allowInstructions = ["Use the project rules"];
  const blockInstructions = ["Never change the deployment" ];
  const gate = createAutoReviewGate({
    baseModes: modes(),
    controller: () => undefined,
    resolveBoxId: () => "box-a",
    getInstructions: () => ({ allowInstructions, blockInstructions }),
  });
  const first = gate.userInstructions();
  assert.ok(first);
  assert.notEqual(first.allowInstructions, allowInstructions);
  assert.notEqual(first.blockInstructions, blockInstructions);
  (first.allowInstructions as string[]).push("additional");
  assert.deepEqual(allowInstructions, ["Use the project rules"]);

  const empty = createAutoReviewGate({
    baseModes: modes(),
    controller: () => undefined,
    resolveBoxId: () => "box-a",
    getInstructions: () => ({ allowInstructions: [], blockInstructions: [] }),
  });
  assert.equal(empty.userInstructions(), undefined);
});

test("shell approval identities advance on side effects and use the current box id", () => {
  let boxId = "box-a";
  const gate = createAutoReviewGate({
    baseModes: modes(),
    controller: () => undefined,
    resolveBoxId: () => boxId,
  });
  const boxState = gate.shellApprovalState("box_shell");
  const hostState = gate.shellApprovalState("host_shell");
  assert.equal(boxState.getIdentity(), "box_shell:box-a:0");
  assert.equal(hostState.getIdentity(), "host_shell:0");
  boxId = "box-b";
  assert.equal(boxState.getIdentity(), "box_shell:box-b:0");
  boxState.markSideEffectStart();
  hostState.markSideEffectStart();
  assert.equal(boxState.getIdentity(), "box_shell:box-b:1");
  assert.equal(hostState.getIdentity(), "host_shell:1");
});
