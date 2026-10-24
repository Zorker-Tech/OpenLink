/**
 * Reviewing what an agent did on the desktop: the pure action helpers and the preflight's decisions.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SLATE_COMPUTER_AUTO_REVIEW_CLASSIFIER_ERROR_REASON,
  SLATE_COMPUTER_AUTO_REVIEW_MAX_DESCRIPTION_CHARS,
  SLATE_COMPUTER_AUTO_REVIEW_MAX_KEY_CHARS,
  SLATE_COMPUTER_AUTO_REVIEW_MAX_PATH_POINTS,
  SLATE_COMPUTER_AUTO_REVIEW_MAX_TEXT_CHARS,
  SLATE_COMPUTER_CLASSIFIER_TARGET_ACTION,
  SlateComputerAutoReviewBlockedError,
  buildProjectPermissionsContext,
  buildSlateComputerAutoReviewCanonicalTarget,
  buildSlateComputerClassifierRiskTarget,
  computeSlateComputerPageStateIdentity,
  fingerprintSlateComputerAutoReviewTarget,
  isSlateComputerAutoReviewBypassAction,
  isSlateComputerAutoReviewMutatingAction,
  normalizeSlateComputerDescription,
  normalizeSlateComputerExactActionArgs,
  requiresSlateComputerDeclaredDescription,
  runSlateComputerAutoReviewPreflight,
  slateComputerDeclaredPurposeParameter,
  summarizeBlockedAction,
} from "../../source/host/runner/slate-computer-auto-review.ts";
import { createContext } from "../../source/packages/context/context.ts";
import { smartModeClassifierExecutorResource } from "../../source/packages/agent-exec/smart-mode-classifier-operation.ts";
import { SmartModeClassifierResult, SmartModeClassifierDecision } from "../../source/packages/proto/generated/agent/v1/smart_mode_classifier_exec_pb.ts";

const action = (fields: Record<string, unknown>) => ({ action: "click", x: 10, y: 20, ...fields }) as never;
const boxIdentity = { boxId: "box-1", windowGeneration: "gen-1" };

function accessor(decision: string, reason = "looks risky") {
  return {
    get(resource: unknown) {
      if (resource !== smartModeClassifierExecutorResource) return undefined;
      return { async execute() { return new SmartModeClassifierResult({ result: { case: "success", value: { decision: decision === "allow" ? SmartModeClassifierDecision.ALLOW : SmartModeClassifierDecision.BLOCK, blockReason: reason } } }); } };
    },
  } as never;
}

test("the public constants are the reviewed surface", () => {
  assert.equal(SLATE_COMPUTER_CLASSIFIER_TARGET_ACTION, "slate_computer");
  assert.deepEqual([SLATE_COMPUTER_AUTO_REVIEW_MAX_DESCRIPTION_CHARS, SLATE_COMPUTER_AUTO_REVIEW_MAX_TEXT_CHARS, SLATE_COMPUTER_AUTO_REVIEW_MAX_KEY_CHARS, SLATE_COMPUTER_AUTO_REVIEW_MAX_PATH_POINTS], [500, 2_000, 256, 64]);
  assert.equal(SLATE_COMPUTER_AUTO_REVIEW_CLASSIFIER_ERROR_REASON, "An error occurred while classifying this action. Please review manually.");
  assert.deepEqual(slateComputerDeclaredPurposeParameter, { type: "string", optional: true, description: "Concise model-facing intent for this action. Required for click and drag in Auto-review enforce mode; include for type/key when it clarifies purpose." });
});

test("the page-state identity hashes page targets and falls back to lines", () => {
  const pages = computeSlateComputerPageStateIdentity(JSON.stringify([{ type: "page", id: "b", url: " https://b " }, { type: "page", id: "a", url: "https://a" }, { type: "other", id: "c" }, { type: "page", id: 1 }]));
  const reordered = computeSlateComputerPageStateIdentity(JSON.stringify([{ type: "page", id: "a", url: "https://a" }, { type: "page", id: "b", url: "https://b" }]));
  assert.match(pages, /^[0-9a-f]{64}$/);
  assert.equal(pages, reordered);
  assert.notEqual(computeSlateComputerPageStateIdentity("not json"), computeSlateComputerPageStateIdentity("line one"));
});

test("actions are bypassed, reviewed and described as the rules say", () => {
  for (const kind of ["screenshot", "move", "wait", "scroll"]) {
    assert.equal(isSlateComputerAutoReviewBypassAction(kind), true);
    assert.equal(isSlateComputerAutoReviewMutatingAction(kind), false);
  }
  for (const kind of ["click", "drag", "type", "key"]) {
    assert.equal(isSlateComputerAutoReviewBypassAction(kind), false);
    assert.equal(isSlateComputerAutoReviewMutatingAction(kind), true);
  }
  assert.equal(requiresSlateComputerDeclaredDescription("click"), true);
  assert.equal(requiresSlateComputerDeclaredDescription("drag"), true);
  assert.equal(requiresSlateComputerDeclaredDescription("type"), false);
});

test("oversized arguments and descriptions are refused with their own messages", () => {
  assert.throws(() => normalizeSlateComputerExactActionArgs(action({ text: "x".repeat(2_001) })), (error: unknown) => error instanceof SlateComputerAutoReviewBlockedError && (error as Error).message === "Computer Auto-review rejected oversized text (max 2000 characters).");
  assert.throws(() => normalizeSlateComputerExactActionArgs(action({ key: "k".repeat(257) })), /oversized key \(max 256 characters\)/);
  assert.throws(() => normalizeSlateComputerExactActionArgs(action({ path: Array.from({ length: 65 }, () => ({})) })), /oversized path \(max 64 characters\)/);
  assert.equal((normalizeSlateComputerExactActionArgs(action({ text: "ok", key: "k", path: [{ x: 1 }] })) as { text?: string }).text, "ok");
  assert.equal(normalizeSlateComputerDescription(undefined), undefined);
  assert.equal(normalizeSlateComputerDescription("   "), undefined);
  assert.equal(normalizeSlateComputerDescription("  open settings  "), "open settings");
  assert.throws(() => normalizeSlateComputerDescription("d".repeat(501)), /oversized description \(max 500 characters\)/);
  assert.equal(normalizeSlateComputerDescription("d".repeat(500))?.length, 500);
});

test("the canonical target carries the description, and its fingerprint follows every field", () => {
  const canonical = buildSlateComputerAutoReviewCanonicalTarget({ exactAction: action({}), boxIdentity, displayStateIdentity: "state-1" });
  assert.equal(canonical.description, undefined);
  const described = buildSlateComputerAutoReviewCanonicalTarget({ exactAction: action({ text: "hello" }), description: "  open settings ", boxIdentity, displayStateIdentity: "state-1" });
  assert.equal(described.description, "open settings");
  assert.notEqual(fingerprintSlateComputerAutoReviewTarget(canonical), fingerprintSlateComputerAutoReviewTarget(described));
  assert.match(fingerprintSlateComputerAutoReviewTarget(canonical), /^[0-9a-f]{64}$/);
});

test("project permissions merge, trim and drop empties", () => {
  assert.equal(buildProjectPermissionsContext({}), undefined);
  assert.deepEqual(
    buildProjectPermissionsContext({ personalInstructions: { allowInstructions: [" a ", "b", "a"], blockInstructions: [" c "] }, userAutoRunInstructions: { allowInstructions: ["b", "d"] }, projectAutoRunInstructions: { blockInstructions: ["e", " "] } }),
    { auto_run: { allow_instructions: ["a", "b", "d"], block_instructions: ["c", "e"] } },
  );
});

test("the classifier risk target names the computer surface and carries the arguments", () => {
  const canonical = buildSlateComputerAutoReviewCanonicalTarget({ exactAction: action({ text: "hello", button: "left", count: 2 }), description: "open settings", boxIdentity, displayStateIdentity: "state-1" });
  const target = buildSlateComputerClassifierRiskTarget({ canonicalTarget: canonical, personalInstructions: { allowInstructions: ["ok"] } }) as { action: string; arguments?: { toJson(): Record<string, unknown> } };
  assert.equal(target.action, SLATE_COMPUTER_CLASSIFIER_TARGET_ACTION);
  const fields = target.arguments!.toJson() as Record<string, unknown>;
  assert.equal(fields.surface, "computer");
  assert.equal(fields.action_kind, "click");
  assert.deepEqual(fields.coordinates, { x: 10, y: 20 });
  assert.equal(fields.declared_purpose, "open settings");
  assert.deepEqual(fields.project_permissions, { auto_run: { allow_instructions: ["ok"], block_instructions: [] } });
});

test("blocked actions are summarized per action kind", () => {
  const canonical = buildSlateComputerAutoReviewCanonicalTarget({ exactAction: action({ action: "drag", x2: 30, y2: 40 }), boxIdentity, displayStateIdentity: "s" });
  assert.deepEqual(summarizeBlockedAction(canonical, "fp", "reason"), { surface: "computer", fingerprint: "fp", reason: "reason", summary: "Drag from (10, 20) to (30, 40) on Slate's computer" });
  assert.equal(summarizeBlockedAction(buildSlateComputerAutoReviewCanonicalTarget({ exactAction: action({ action: "type", text: "hello there" }), boxIdentity, displayStateIdentity: "s" }), "fp", "r").summary, "Type 11 characters (\u201chello there\u201d) on Slate's computer");
  assert.equal(summarizeBlockedAction(buildSlateComputerAutoReviewCanonicalTarget({ exactAction: action({ action: "key", key: "Meta+C" }), boxIdentity, displayStateIdentity: "s" }), "fp", "r").summary, "Press Meta+C on Slate's computer");
});

async function preflight(overrides: Record<string, unknown> = {}) {
  const approvals: unknown[] = [];
  const recheckFailures: string[] = [];
  let recheckCount = 0;
  let thrown: unknown;
  const options = {
    mode: (overrides.mode as string | undefined) ?? "enforce",
    agentId: "agent-1",
    boxIdentity,
    resolveDisplayNumber: async () => 1,
    captureDisplayStateIdentity: async () => (overrides.changed === true ? "state-" + ++recheckCount : "state-1"),
    ...(overrides.controller === false ? {} : { autoReviewController: { requestApproval: async (request: unknown) => { approvals.push(request); return (overrides.approved as { approved: boolean; reason?: string }) ?? { approved: true }; }, reportDisplayRecheckFailed: (agentId: string) => { recheckFailures.push(agentId); } } }),
    ...(overrides.devBlock === true ? { devBlockState: { consume: () => true } } : {}),
  };
  try {
    await runSlateComputerAutoReviewPreflight({
      ctx: createContext(),
      resourceAccessor: accessor((overrides.decision as string | undefined) ?? "block"),
      exactAction: (overrides.exactAction as never) ?? action({}),
      ...(overrides.noDescription === true ? {} : { description: (overrides.description as string | undefined) ?? "open settings" }),
      toolCallId: "call-1",
      ...(overrides.signal === "aborted" ? { signal: { aborted: true } as AbortSignal } : {}),
      options,
    } as never);
  } catch (error) { thrown = error; }
  return { thrown, approvals, recheckFailures };
}

test("the preflight bypasses, shadows and enforces as configured", async () => {
  assert.equal((await preflight({ mode: "off" })).thrown, undefined);
  assert.equal((await preflight({ exactAction: action({ action: "screenshot" }) })).thrown, undefined);
  assert.equal((await preflight({ exactAction: action({}), noDescription: true })).thrown instanceof SlateComputerAutoReviewBlockedError, true);
  assert.equal((await preflight({ mode: "shadow", decision: "allow" })).thrown, undefined);
  assert.equal((await preflight({ decision: "allow" })).thrown, undefined);
});

test("a changed display after review blocks the action and reports the recheck failure", async () => {
  const outcome = await preflight({ decision: "allow", changed: true });
  assert.equal((outcome.thrown as Error).message, "The page changed after review; inspect the latest screenshot and retry the action.");
  assert.deepEqual(outcome.recheckFailures, ["agent-1"]);
});

test("a blocked action asks for approval and respects the answer", async () => {
  const approved = await preflight({ decision: "block" });
  assert.equal(approved.thrown, undefined);
  assert.equal(approved.approvals.length, 1);
  assert.equal((approved.approvals[0] as { surface: string }).surface, "computer");
  const denied = await preflight({ decision: "block", approved: { approved: false, reason: "the user said no" } });
  assert.equal((denied.thrown as Error).message, "the user said no");
  const noController = await preflight({ decision: "block", controller: false });
  assert.equal((noController.thrown as Error).message, "looks risky");
  assert.equal((await preflight({ decision: "block", signal: "aborted" })).thrown instanceof SlateComputerAutoReviewBlockedError, true);
  assert.equal((await preflight({ decision: "allow", devBlock: true, controller: false })).thrown instanceof SlateComputerAutoReviewBlockedError, true);
});
