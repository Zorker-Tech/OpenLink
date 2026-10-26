/** The browser Auto-review's normalized target, classifier handoff, and approval gate. */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildSlateBrowserAutoReviewCanonicalTarget,
  buildSlateBrowserClassifierRiskTarget,
  fingerprintSlateBrowserAutoReviewTarget,
  isSlateBrowserAutoReviewMutatingAction,
  normalizeSlateBrowserElement,
  normalizeSlateBrowserExactActionArgs,
  runSlateBrowserAutoReviewPreflight,
  SlateBrowserAutoReviewBlockedError,
  SLATE_BROWSER_AUTO_REVIEW_MAX_CDP_PARAMS_CHARS,
  SLATE_BROWSER_AUTO_REVIEW_MAX_ELEMENT_CHARS,
  SLATE_BROWSER_AUTO_REVIEW_MAX_KEY_CHARS,
  SLATE_BROWSER_AUTO_REVIEW_MAX_TEXT_CHARS,
  SLATE_BROWSER_AUTO_REVIEW_MAX_URL_CHARS,
} from "../../source/host/runner/slate-browser-auto-review.ts";
import type { BoxIdentity } from "../../source/host/runner/slate-computer-auto-review.ts";
import { SLATE_COMPUTER_CLASSIFIER_TARGET_ACTION } from "../../source/host/runner/slate-computer-auto-review.ts";
import { createContext } from "../../source/packages/context/context.ts";
import { smartModeClassifierExecutorResource } from "../../source/packages/agent-exec/smart-mode-classifier-operation.ts";
import {
  SmartModeClassifierDecision,
  SmartModeClassifierResult,
  type SmartModeClassifierConversationMessage,
} from "../../source/packages/proto/generated/agent/v1/smart_mode_classifier_exec_pb.ts";

type BrowserActionInput = { readonly op: string; readonly [key: string]: unknown };
const boxIdentity: BoxIdentity = { boxId: "box-1", windowGeneration: "gen-1" };
const action = (fields: Record<string, unknown> = {}): BrowserActionInput => ({ op: "click", element: "button", x: 10, y: 20, ...fields });

function classifierAccessor(decision: "allow" | "block" | "reject", reason = "looks risky") {
  return {
    get(resource: unknown) {
      if (resource !== smartModeClassifierExecutorResource) return undefined;
      return {
        async execute() {
          const classification = decision === "allow"
            ? SmartModeClassifierDecision.ALLOW
            : decision === "block"
              ? SmartModeClassifierDecision.BLOCK
              : SmartModeClassifierDecision.UNSPECIFIED;
          return new SmartModeClassifierResult({
            result: {
              case: "success",
              value: { decision: classification, blockReason: reason },
            },
          });
        },
      };
    },
  } as never;
}

async function preflight(overrides: Record<string, unknown> = {}) {
  const approvals: unknown[] = [];
  const reportedFailures: string[] = [];
  const captures: string[] = [];
  let captureIndex = 0;
  let thrown: unknown;
  const stateChanges = overrides.changed === true;
  const options = {
    mode: (overrides.mode as string | undefined) ?? "enforce",
    agentId: "agent-1",
    boxIdentity,
    resolveDisplayNumber: async () => 1,
    captureReviewState: async () => {
      captureIndex += 1;
      const displayStateIdentity = stateChanges && captureIndex > 1 ? "state-changed" : "state-1";
      captures.push(displayStateIdentity);
      return { displayStateIdentity, targetPageUrl: "https://example.test/page" };
    },
    ...(overrides.controller === false ? {} : {
      autoReviewController: {
        requestApproval: async (request: unknown) => {
          approvals.push(request);
          return (overrides.approval as { approved: boolean; reason?: string }) ?? { approved: true };
        },
        reportDisplayRecheckFailed: (agentId: string) => { reportedFailures.push(agentId); },
      },
      getApprovalExpiryPolicy: () => "ttl" as const,
    }),
  };

  try {
    await runSlateBrowserAutoReviewPreflight({
      ctx: createContext(),
      resourceAccessor: classifierAccessor((overrides.decision as "allow" | "block" | "reject" | undefined) ?? "block", (overrides.reason as string | undefined) ?? "looks risky"),
      exactAction: (overrides.exactAction as never) ?? action(),
      toolCallId: "call-1",
      ...(overrides.aborted === true ? { signal: { aborted: true } as AbortSignal } : {}),
      ...(overrides.workspacePaths === undefined ? {} : { workspacePaths: overrides.workspacePaths as string[] }),
      options,
    } as never);
  } catch (error) {
    thrown = error;
  }

  return { thrown, approvals, reportedFailures, captures };
}

test("browser actions bypass review, classify mutations, and keep the stated bounds", () => {
  assert.deepEqual([
    SLATE_BROWSER_AUTO_REVIEW_MAX_ELEMENT_CHARS,
    SLATE_BROWSER_AUTO_REVIEW_MAX_TEXT_CHARS,
    SLATE_BROWSER_AUTO_REVIEW_MAX_KEY_CHARS,
    SLATE_BROWSER_AUTO_REVIEW_MAX_CDP_PARAMS_CHARS,
    SLATE_BROWSER_AUTO_REVIEW_MAX_URL_CHARS,
  ], [500, 2_000, 256, 2_000, 2_000]);

  for (const op of ["snapshot", "screenshot", "get_bounding_box", "highlight", "scroll"]) {
    assert.equal(isSlateBrowserAutoReviewMutatingAction(action({ op })), false, op);
  }
  assert.equal(isSlateBrowserAutoReviewMutatingAction(action({ op: "tabs", tabsAction: "new" })), true);
  assert.equal(isSlateBrowserAutoReviewMutatingAction(action({ op: "tabs", tabsAction: "close" })), true);
  assert.equal(isSlateBrowserAutoReviewMutatingAction(action({ op: "tabs", tabsAction: "activate" })), false);
  assert.equal(isSlateBrowserAutoReviewMutatingAction(action({ op: "click" })), true);
});

test("browser action and element inputs are bounded and normalized", () => {
  const original = action({ url: "https://example.test", element: "  submit button  " });
  assert.equal(normalizeSlateBrowserExactActionArgs(original), original);
  assert.equal(normalizeSlateBrowserElement(undefined), undefined);
  assert.equal(normalizeSlateBrowserElement("  "), undefined);
  assert.equal(normalizeSlateBrowserElement("  submit button  "), "submit button");
  assert.equal(normalizeSlateBrowserElement("e".repeat(500))?.length, 500);
  assert.doesNotThrow(() => normalizeSlateBrowserExactActionArgs(action({
    url: "u".repeat(2_000),
    text: "t".repeat(2_000),
    value: "v".repeat(2_000),
    key: "k".repeat(256),
    cdpParams: "p".repeat(2_000),
    values: ["x".repeat(2_000)],
  })));

  for (const [field, value] of [
    ["url", "u".repeat(2_001)],
    ["text", "t".repeat(2_001)],
    ["value", "v".repeat(2_001)],
    ["key", "k".repeat(257)],
    ["cdpParams", "p".repeat(2_001)],
  ] as const) {
    assert.throws(
      () => normalizeSlateBrowserExactActionArgs(action({ [field]: value })),
      (error: unknown) => error instanceof SlateBrowserAutoReviewBlockedError && error.message.includes("oversized"),
      field,
    );
  }
  assert.throws(() => normalizeSlateBrowserElement("e".repeat(501)), /oversized element \(max 500 characters\)/);
  assert.throws(() => normalizeSlateBrowserExactActionArgs(action({ values: ["v".repeat(2_001)] })), /oversized values/);
});

test("the canonical target trims the purpose and fingerprints the reviewed state", () => {
  const canonical = buildSlateBrowserAutoReviewCanonicalTarget({
    exactAction: action({ element: "  submit button  " }),
    boxIdentity,
    reviewState: { displayStateIdentity: "display-1", targetPageUrl: "https://example.test/page" },
  });
  assert.equal(canonical.exactAction.element, "submit button");
  assert.equal(canonical.displayStateIdentity, "display-1");
  assert.equal(canonical.targetPageUrl, "https://example.test/page");
  assert.match(fingerprintSlateBrowserAutoReviewTarget(canonical), /^[0-9a-f]{64}$/);

  const anotherPage = buildSlateBrowserAutoReviewCanonicalTarget({
    exactAction: action({ element: "submit button" }),
    boxIdentity,
    reviewState: { displayStateIdentity: "display-2", targetPageUrl: "https://example.test/page" },
  });
  assert.notEqual(fingerprintSlateBrowserAutoReviewTarget(canonical), fingerprintSlateBrowserAutoReviewTarget(anotherPage));
  const anotherUrl = buildSlateBrowserAutoReviewCanonicalTarget({
    exactAction: action({ element: "submit button" }),
    boxIdentity,
    reviewState: { displayStateIdentity: "display-1", targetPageUrl: "https://example.test/other" },
  });
  assert.notEqual(fingerprintSlateBrowserAutoReviewTarget(canonical), fingerprintSlateBrowserAutoReviewTarget(anotherUrl));
});

test("the classifier target names the browser action and carries box and permission context", () => {
  const canonicalTarget = buildSlateBrowserAutoReviewCanonicalTarget({
    exactAction: action({ cdpMethod: "Page.navigate", url: "https://example.test/page" }),
    boxIdentity,
    reviewState: { displayStateIdentity: "display-1", targetPageUrl: "https://example.test/page" },
  });
  const target = buildSlateBrowserClassifierRiskTarget({
    canonicalTarget,
    personalInstructions: { allowInstructions: ["trusted site"] },
    projectAutoRunInstructions: { blockInstructions: ["do not submit"] },
  }) as { action: string; arguments?: { toJson(): Record<string, unknown> } };

  assert.equal(target.action, SLATE_COMPUTER_CLASSIFIER_TARGET_ACTION);
  const args = target.arguments?.toJson() as Record<string, any>;
  assert.equal(args.surface, "browser");
  assert.equal(args.action_kind, "browser_click");
  assert.equal(args.cdp_method, "Page.navigate");
  assert.equal(args.target_page_url, "https://example.test/page");
  assert.equal(args.declared_purpose, "button");
  assert.deepEqual(args.box, {
    box_id: "box-1",
    window_generation: "gen-1",
    display_state_identity: "display-1",
  });
  assert.deepEqual(args.project_permissions, {
    auto_run: { allow_instructions: ["trusted site"], block_instructions: ["do not submit"] },
  });
});

test("the preflight skips nonmutations and enforces a stated target for clicks", async () => {
  const disabled = await preflight({ mode: "off" });
  assert.equal(disabled.thrown, undefined);
  assert.deepEqual(disabled.captures, []);
  const observation = await preflight({ exactAction: action({ op: "snapshot" }) });
  assert.equal(observation.thrown, undefined);
  assert.deepEqual(observation.captures, []);

  const missingPurpose = await preflight({ exactAction: action({ op: "click", element: undefined }) });
  assert.equal(missingPurpose.thrown instanceof SlateBrowserAutoReviewBlockedError, true);
  assert.equal((missingPurpose.thrown as Error).message, "Browser click and drag actions require an element field: a concise description of the intended target and purpose.");
  assert.deepEqual(missingPurpose.captures, []);
});

test("an allowed classifier decision is rechecked against the current display", async () => {
  const allowed = await preflight({ decision: "allow" });
  assert.equal(allowed.thrown, undefined);
  assert.deepEqual(allowed.captures, ["state-1", "state-1"]);

  const changed = await preflight({ decision: "allow", changed: true });
  assert.equal((changed.thrown as Error).message, "The page changed after review; take a fresh browser_snapshot and retry the action.");
  assert.deepEqual(changed.reportedFailures, ["agent-1"]);
});

test("a blocked decision asks for approval and respects allow, deny, missing-controller, and cancellation outcomes", async () => {
  const allowed = await preflight({ decision: "block" });
  assert.equal(allowed.thrown, undefined);
  assert.equal(allowed.approvals.length, 1);
  assert.equal((allowed.approvals[0] as { surface: string }).surface, "computer");
  assert.equal((allowed.approvals[0] as { expiryPolicy: string }).expiryPolicy, "ttl");

  const denied = await preflight({ decision: "block", approval: { approved: false, reason: "the user said no" } });
  assert.equal((denied.thrown as Error).message, "the user said no");
  const noController = await preflight({ decision: "block", controller: false });
  assert.equal((noController.thrown as Error).message, "looks risky");
  const cancelled = await preflight({ decision: "block", aborted: true });
  assert.equal((cancelled.thrown as Error).message, "The browser action was cancelled.");
});

test("classifier rejection blocks, while shadow mode returns without approval", async () => {
  const rejected = await preflight({ decision: "reject" });
  assert.equal((rejected.thrown as Error).message, "An error occurred while classifying this action. Please review manually.");

  const shadow = await preflight({ mode: "shadow", decision: "block" });
  assert.equal(shadow.thrown, undefined);
  assert.equal(shadow.approvals.length, 0);
});
