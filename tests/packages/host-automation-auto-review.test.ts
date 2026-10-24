/**
 * Reviewing an automation write: the risk target, its permission merge, and the review flow's decisions.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SLATE_AUTOMATION_WRITE_CLASSIFIER_ERROR_REASON,
  SLATE_AUTOMATION_WRITE_CLASSIFIER_TARGET_ACTION,
  buildSlateAutomationWriteRiskTarget,
  reviewSlateAutomationWrite,
} from "../../source/host/runner/slate-automation-auto-review.ts";

const target = {
  operation: "update",
  id: "auto-1",
  spec: {
    name: "Morning digest",
    prompt: "Summarize the inbox",
    trigger: { type: "cron", schedule: "0 9 * * *" },
    isEnabled: true,
  },
  referencedWorkflows: [{ id: "w1", name: "Digest", body: "steps", prompt: "p" }],
  referencingRoutines: [{ id: "r1", name: "Weekly", prompt: "do it" }],
} as never;

test("the exported constants name the reviewed surface and its failure text", () => {
  assert.equal(SLATE_AUTOMATION_WRITE_CLASSIFIER_TARGET_ACTION, "slate_automation_write");
  assert.equal(SLATE_AUTOMATION_WRITE_CLASSIFIER_ERROR_REASON, "An error occurred while reviewing this routine. Please review manually.");
});

test("the risk target describes the routine and its references", () => {
  const risk = buildSlateAutomationWriteRiskTarget({ target });
  assert.equal(risk.action, SLATE_AUTOMATION_WRITE_CLASSIFIER_TARGET_ACTION);
  const fields = risk.arguments!.toJson() as unknown as Record<string, unknown>;
  assert.equal(fields.surface, "automation_write");
  assert.equal(fields.operation, "update");
  assert.equal(fields.automation_id, "auto-1");
  assert.equal(fields.name, "Morning digest");
  assert.equal(fields.prompt, "Summarize the inbox");
  assert.equal(fields.enabled, true);
  assert.equal(typeof fields.trigger, "object");
  assert.deepEqual(fields.referenced_workflows, [{ id: "w1", name: "Digest", body: "steps" }]);
  assert.deepEqual(fields.referencing_routines, [{ id: "r1", name: "Weekly", prompt: "do it" }]);
});

test("the risk target defaults missing references to empty lists and merges permissions", () => {
  const bare = buildSlateAutomationWriteRiskTarget({ target: { ...(target as Record<string, unknown>), referencedWorkflows: undefined, referencingRoutines: undefined } as never });
  const bareFields = bare.arguments!.toJson() as unknown as Record<string, unknown>;
  assert.deepEqual(bareFields.referenced_workflows, []);
  assert.deepEqual(bareFields.referencing_routines, []);
  const permitted = buildSlateAutomationWriteRiskTarget({ target, personalInstructions: { allowInstructions: [" a ", "a"], blockInstructions: ["b"] }, projectAutoRunInstructions: { blockInstructions: ["c"] } });
  const autoRun = (permitted.arguments!.toJson() as unknown as { project_permissions?: { auto_run?: { allow_instructions?: string[]; block_instructions?: string[] } } }).project_permissions?.auto_run;
  assert.deepEqual(autoRun?.allow_instructions, ["a"]);
  assert.deepEqual(autoRun?.block_instructions, ["b", "c"]);
});

function harness(overrides: Record<string, unknown> = {}) {
  const calls: unknown[] = [];
  const options = {
    mode: (overrides.mode as string | undefined) ?? "enforce",
    agentId: "agent-1",
    ...(overrides.controller === false ? {} : { autoReviewController: { async requestApproval(request: unknown) { calls.push(["requestApproval", request]); return (overrides.approval as { approved: boolean; reason?: string } | undefined) ?? { approved: true }; } } }),
    ...(overrides.expiry === undefined ? {} : { getApprovalExpiryPolicy: overrides.expiry as () => unknown }),
    classify: async (_ctx: unknown, _target: unknown, mode: string, toolCallId: string) => {
      calls.push(["classify", mode, toolCallId]);
      if (overrides.classifyThrows === true) throw new Error("classifier failed");
      const decision = (overrides.decision as string | undefined) ?? "block";
      return decision === "allow" ? { kind: "allow" } : decision === "reject" ? { kind: "reject", reason: "not now" } : { kind: "block", reason: "looks risky", ...(overrides.proposedRule === undefined ? {} : { proposedRule: overrides.proposedRule }) };
    },
    ...(overrides.suspend === true ? { suspendToolExecutionTimeout: async (_ctx: unknown, operation: () => Promise<unknown>) => { calls.push(["suspend"]); return await operation(); } } : {}),
    ...(overrides.reportShadow === undefined ? {} : { reportShadowFailure: overrides.reportShadow as (error: unknown) => void }),
  };
  return { calls, options };
}
async function review(overrides: Record<string, unknown> = {}) {
  const built = harness(overrides);
  const signal = overrides.signal === true ? new AbortController().signal : undefined;
  const outcome = await reviewSlateAutomationWrite({ ctx: {} as never, target, options: built.options as never, toolCallId: "call-1", ...(signal === undefined ? {} : { signal }) });
  return { outcome, calls: built.calls };
}

test("an off or shadow review allows without enforcing", async () => {
  assert.deepEqual((await review({ mode: "off" })).outcome, { allowed: true });
  const shadow = await review({ mode: "shadow", decision: "allow" });
  assert.deepEqual(shadow.outcome, { allowed: true });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(shadow.calls, [["classify", "shadow", "call-1"]]);
});

test("a shadow failure is reported to the caller's reporter", async () => {
  let reported: unknown;
  await review({ mode: "shadow", classifyThrows: true, reportShadow: (error: unknown) => { reported = error; } });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(String(reported), "Error: classifier failed");
});

test("an allowed or rejected decision is returned directly", async () => {
  assert.deepEqual((await review({ decision: "allow" })).outcome, { allowed: true });
  assert.deepEqual((await review({ decision: "reject" })).outcome, { allowed: false, reason: "not now" });
});

test("a block without a controller is returned with the classifier's reason", async () => {
  assert.deepEqual((await review({ controller: false })).outcome, { allowed: false, reason: "looks risky" });
});

test("a blocked review asks for approval with its fingerprint and summary and follows the answer", async () => {
  const approved = await review({});
  assert.deepEqual(approved.outcome, { allowed: true });
  const request = (approved.calls.find((call) => (call as unknown[])[0] === "requestApproval") as unknown[])[1] as Record<string, unknown>;
  assert.equal(request.surface, "automation_write");
  assert.equal(request.reason, "looks risky");
  assert.equal(typeof request.fingerprint, "string");
  assert.match(String(request.summary), /Morning digest/);
  const denied = await review({ approval: { approved: false, reason: "user said no" } });
  assert.deepEqual(denied.outcome, { allowed: false, reason: "user said no" });
  const deniedNoReason = await review({ approval: { approved: false } });
  assert.deepEqual(deniedNoReason.outcome, { allowed: false, reason: "looks risky" });
});

test("the expiry policy, proposed rule, signal and timeout suspension are applied when provided", async () => {
  const result = await review({ expiry: () => "park", proposedRule: "rule", suspend: true, signal: true });
  assert.deepEqual(result.outcome, { allowed: true });
  const request = (result.calls.find((call) => (call as unknown[])[0] === "requestApproval") as unknown[])[1] as Record<string, unknown>;
  assert.equal(request.expiryPolicy, "park");
  assert.equal(request.proposedRule, "rule");
  assert.equal(request.signal instanceof AbortSignal, true);
  assert.equal(result.calls.some((call) => (call as unknown[])[0] === "suspend"), true);
});

test("a classifier error propagates", async () => {
  await assert.rejects(() => review({ classifyThrows: true }), /classifier failed/);
});
