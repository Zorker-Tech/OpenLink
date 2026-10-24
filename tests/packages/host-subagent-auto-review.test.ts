/**
 * Reviewing a subagent action: the launch/steer targets, the risk target, and the review flow's decisions.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SLATE_SUBAGENT_CLASSIFIER_ERROR_REASON,
  SLATE_SUBAGENT_CLASSIFIER_TARGET_ACTION,
  buildSlateSubagentLaunchReviewTarget,
  buildSlateSubagentRiskTarget,
  buildSlateSubagentSteerReviewTarget,
  reviewSlateSubagentAction,
} from "../../source/host/runner/slate-subagent-auto-review.ts";

const launch = (fields: Record<string, unknown>) => buildSlateSubagentLaunchReviewTarget(fields as never);
const steer = (fields: Record<string, unknown>) => buildSlateSubagentSteerReviewTarget(fields as never);

test("the public constants are the reviewed surface", () => {
  assert.equal(SLATE_SUBAGENT_CLASSIFIER_TARGET_ACTION, "slate_subagent");
  assert.equal(SLATE_SUBAGENT_CLASSIFIER_ERROR_REASON, "An error occurred while reviewing this task. Please review manually.");
});

test("a launch target trims its prompt and keeps the optional flags it was given", () => {
  assert.deepEqual(launch({ prompt: "  do it  " }), { action: "launch", prompt: "do it" });
  assert.deepEqual(launch({ prompt: "do it", subagentType: "researcher", readonly: true, resume: false }), { action: "launch", prompt: "do it", subagentType: "researcher", readonly: true, resume: false });
  assert.deepEqual(launch({ prompt: "do it", subagentType: "" }), { action: "launch", prompt: "do it" });
  assert.equal(launch({ prompt: "   " }), undefined);
  assert.deepEqual(launch({ prompt: "x", readonly: false }), { action: "launch", prompt: "x", readonly: false });
});

test("a steer target trims its message and needs an agent id", () => {
  assert.deepEqual(steer({ message: "  steer left  ", subagentAgentId: "a1" }), { action: "steer", prompt: "steer left", subagentAgentId: "a1" });
  assert.deepEqual(steer({ message: "go", subagentAgentId: "a1", subagentType: "t" }), { action: "steer", prompt: "go", subagentAgentId: "a1", subagentType: "t" });
  assert.equal(steer({ message: " ", subagentAgentId: "a1" }), undefined);
});

test("the risk target names the subagent surface and mirrors the target fields", () => {
  const target = launch({ prompt: "do it", subagentType: "researcher", readonly: true, resume: true })!;
  const risk = buildSlateSubagentRiskTarget({ target });
  assert.equal(risk.action, SLATE_SUBAGENT_CLASSIFIER_TARGET_ACTION);
  const fields = risk.arguments!.toJson() as unknown as Record<string, unknown>;
  assert.equal(fields.surface, "subagent");
  assert.equal(fields.action, "launch");
  assert.equal(fields.prompt, "do it");
  assert.equal(fields.subagent_type, "researcher");
  assert.equal(fields.readonly, true);
  assert.equal(fields.resume, true);
});

test("the risk target merges project permissions", () => {
  const target = steer({ message: "go", subagentAgentId: "a1" })!;
  const risk = buildSlateSubagentRiskTarget({ target, personalInstructions: { allowInstructions: [" a ", "a"], blockInstructions: ["b"] }, projectAutoRunInstructions: { blockInstructions: ["c"] } });
  const fields = risk.arguments!.toJson() as unknown as { project_permissions?: { auto_run?: { allow_instructions?: string[]; block_instructions?: string[] } } };
  assert.deepEqual(fields.project_permissions?.auto_run?.allow_instructions, ["a"]);
  assert.deepEqual(fields.project_permissions?.auto_run?.block_instructions, ["b", "c"]);
  const emptyRisk = buildSlateSubagentRiskTarget({ target, personalInstructions: { allowInstructions: [" "] } });
  const emptyFields = (emptyRisk.arguments ?? { toJson: () => ({}) }).toJson() as unknown as Record<string, unknown>;
  assert.equal(emptyFields.project_permissions, undefined);
});

const target = launch({ prompt: "do it" })!;
function harness(overrides: Record<string, unknown> = {}) {
  const calls: unknown[] = [];
  const options = {
    mode: (overrides.mode as string | undefined) ?? "enforce",
    agentId: "agent-1",
    ...(overrides.controller === false ? {} : { autoReviewController: { async requestApproval(request: unknown) { calls.push(["requestApproval", request]); return (overrides.approval as { approved: boolean; reason?: string } | undefined) ?? { approved: true }; } } }),
    ...(overrides.expiry === undefined ? {} : { getApprovalExpiryPolicy: overrides.expiry as () => unknown }),
    classify: async (_ctx: unknown, classifiedTarget: unknown, mode: string, toolCallId: string) => {
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
  const signal = overrides.signalAborted === true ? { aborted: true } : undefined;
  const outcome = await reviewSlateSubagentAction({ ctx: {} as never, target, options: built.options as never, toolCallId: "call-1", ...(signal === undefined ? {} : { signal: signal as AbortSignal }) });
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

test("an already-cancelled review is refused without classifying", async () => {
  const result = await review({ signalAborted: true });
  assert.deepEqual(result.outcome, { allowed: false, reason: "The task was cancelled." });
  assert.deepEqual(result.calls, []);
});

test("an allowed or rejected decision is returned directly", async () => {
  assert.deepEqual((await review({ decision: "allow" })).outcome, { allowed: true });
  const rejected = await review({ decision: "reject" });
  assert.deepEqual(rejected.outcome, { allowed: false, reason: "not now" });
});

test("a block without a controller is returned with the classifier's reason", async () => {
  assert.deepEqual((await review({ controller: false })).outcome, { allowed: false, reason: "looks risky" });
});

test("a blocked review asks for approval with its fingerprint and follows the answer", async () => {
  const approved = await review({});
  assert.deepEqual(approved.outcome, { allowed: true });
  const request = (approved.calls.find((call) => (call as unknown[])[0] === "requestApproval") as unknown[])[1] as Record<string, unknown>;
  assert.equal(request.surface, "subagent");
  assert.equal(request.reason, "looks risky");
  assert.equal(typeof request.fingerprint, "string");
  assert.match(String(request.summary), /do it/);
  const denied = await review({ approval: { approved: false, reason: "user said no" } });
  assert.deepEqual(denied.outcome, { allowed: false, reason: "user said no" });
  const deniedNoReason = await review({ approval: { approved: false } });
  assert.deepEqual(deniedNoReason.outcome, { allowed: false, reason: "looks risky" });
});

test("the expiry policy, proposed rule and timeout suspension are applied when provided", async () => {
  const result = await review({ expiry: () => "park", proposedRule: "rule", suspend: true });
  assert.deepEqual(result.outcome, { allowed: true });
  const request = (result.calls.find((call) => (call as unknown[])[0] === "requestApproval") as unknown[])[1] as Record<string, unknown>;
  assert.equal(request.expiryPolicy, "park");
  assert.equal(request.proposedRule, "rule");
  assert.equal(result.calls.some((call) => (call as unknown[])[0] === "suspend"), true);
});

test("a classifier error propagates", async () => {
  await assert.rejects(() => review({ classifyThrows: true }), /classifier failed/);
});
