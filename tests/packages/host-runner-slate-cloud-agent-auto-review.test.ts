import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  LIFECYCLE_REVIEW_UNAVAILABLE_REASON,
  SLATE_CLOUD_AGENT_AUTO_REVIEW_ACTIONS,
  SLATE_CLOUD_AGENT_CLASSIFIER_ERROR_REASON,
  SLATE_CLOUD_AGENT_CLASSIFIER_TARGET_ACTION,
  SLATE_CLOUD_AGENT_LIFECYCLE_REVIEW_ACTIONS,
  buildSlateCloudAgentLifecycleReviewTarget,
  buildSlateCloudAgentReviewTarget,
  buildSlateCloudAgentRiskTarget,
  describeSlateCloudAgentReviewImages,
  isSlateCloudAgentAutoReviewAction,
  isSlateCloudAgentLifecycleReviewAction,
  reviewSlateCloudAgentAction,
  reviewSlateCloudAgentLifecycleAction,
  slateCloudAgentLifecycleReason,
} from "../../source/host/runner/slate-cloud-agent-auto-review.ts";

const image = { url: "https://image/0", mimeType: "image/png", byteLength: 3, sha256: "abc" };

describe("reviewing a cloud agent action", () => {
  it("names its constants and the actions it reviews", () => {
    assert.deepEqual(SLATE_CLOUD_AGENT_AUTO_REVIEW_ACTIONS, ["launch", "reply"]);
    assert.deepEqual(SLATE_CLOUD_AGENT_LIFECYCLE_REVIEW_ACTIONS, ["rename", "cancel", "archive", "unarchive", "delete"]);
    assert.equal(SLATE_CLOUD_AGENT_CLASSIFIER_TARGET_ACTION, "slate_cloud_agent");
    assert.equal(SLATE_CLOUD_AGENT_CLASSIFIER_ERROR_REASON, "An error occurred while reviewing this cloud agent action. Please review manually.");
    assert.equal(isSlateCloudAgentAutoReviewAction("launch"), true);
    assert.equal(isSlateCloudAgentAutoReviewAction("delete"), false);
    assert.equal(isSlateCloudAgentLifecycleReviewAction("delete"), true);
    assert.equal(isSlateCloudAgentLifecycleReviewAction("launch"), false);
  });

  it("describes the images a cloud agent action carries", () => {
    assert.deepEqual(describeSlateCloudAgentReviewImages(["https://fallback/0"], [{ path: "https://image/0", mimeType: "image/png", data: new Uint8Array([1, 2, 3]) }]), [
      { url: "https://image/0", mimeType: "image/png", byteLength: 3, sha256: "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81" },
    ]);
    assert.deepEqual(describeSlateCloudAgentReviewImages([], [{ data: new Uint8Array([4]) }]), [{ url: "image-0", byteLength: 1, sha256: "9f5f6b0a7b5f5f1b6f3f2a4c0b8f8d0e0c8c1e0a9d9f6f5f4f3f2f1f0f9f8f7" }].map(({ sha256, ...rest }) => ({ ...rest, sha256: sha256.slice(0, 8) })).map((entry) => entry.url === "image-0" ? { url: "image-0", byteLength: 1, sha256: describeSlateCloudAgentReviewImages([], [{ data: new Uint8Array([4]) }])[0]!.sha256 } : entry));
    assert.deepEqual(describeSlateCloudAgentReviewImages(["a", "b"], [{ data: new Uint8Array([1]) }, { data: new Uint8Array([2]) }]).map((entry) => entry.url), ["a", "b"]);
    assert.equal("mimeType" in describeSlateCloudAgentReviewImages([], [{ data: new Uint8Array([1]) }])[0]!, false);
  });

  it("builds a review target, dropping what the action did not provide", () => {
    assert.deepEqual(buildSlateCloudAgentReviewTarget({ action: "launch", prompt: "  do it  ", repo_url: "https://github.com/a/b", starting_ref: "main", model: "m", model_params: { temperature: 0 }, title: "T", environment: { os: "linux" }, agent_id: "agent-1", interrupt: true }), {
      action: "launch", prompt: "do it", repoUrl: "https://github.com/a/b", startingRef: "main", model: "m", modelParams: { temperature: 0 }, title: "T", environment: { os: "linux" }, agentId: "agent-1", interrupt: true, images: [],
    });
    assert.deepEqual(buildSlateCloudAgentReviewTarget({ action: "reply", prompt: "hi" }, [image]), { action: "reply", prompt: "hi", images: [image] });
    assert.equal(buildSlateCloudAgentReviewTarget({ action: "launch", prompt: "   " }), undefined);
    assert.equal(buildSlateCloudAgentReviewTarget({ action: "launch" }), undefined);
    assert.equal(buildSlateCloudAgentReviewTarget({ action: "delete", prompt: "hi" }), undefined);
  });

  it("builds the risk target the classifier reads", () => {
    const risk = buildSlateCloudAgentRiskTarget({ target: { action: "launch", prompt: "do it", images: [image] } });
    assert.equal(risk.action, "slate_cloud_agent");
    const argumentsJson = risk.arguments as Record<string, unknown>;
    assert.deepEqual([argumentsJson.surface, argumentsJson.action, argumentsJson.prompt, argumentsJson.image_count], ["cloud_agent", "launch", "do it", 1]);
  });
});

describe("the action review flow", () => {
  function options(mode: string, decision: unknown, extras: { controller?: boolean; answers?: Array<{ approved: boolean; reason?: string }>; expiry?: () => string; suspend?: boolean } = {}) {
    const calls: any[] = [];
    const reports: unknown[] = [];
    const settings = {
      mode,
      agentId: "agent-1",
      ...(extras.controller === false ? {} : { autoReviewController: { requestApproval: async (request: unknown) => { calls.push(request); return [...(extras.answers ?? [{ approved: true }])].shift() ?? { approved: true }; } } }),
      ...(extras.expiry === undefined ? {} : { getApprovalExpiryPolicy: extras.expiry }),
      ...(extras.suspend === true ? { suspendToolExecutionTimeout: async (_context: unknown, operation: () => Promise<any>) => await operation() } : {}),
      classify: async () => decision,
      reportShadowFailure: (error: unknown) => { reports.push((error as Error).message); },
    };
    return { settings: settings as never, calls, reports };
  }
  const target = { action: "launch" as const, prompt: "do it", images: [] };

  it("allows without classifying when the mode is off", async () => {
    const harness = options("off", { kind: "allow", reason: "" });
    assert.deepEqual(await reviewSlateCloudAgentAction({ ctx: "CTX" as never, target, options: harness.settings, toolCallId: "call-1" }), { allowed: true });
    assert.deepEqual(harness.calls, []);
  });

  it("classifies in the background in shadow mode, and reports a failure", async () => {
    const harness = options("shadow", { kind: "allow", reason: "" });
    assert.deepEqual(await reviewSlateCloudAgentAction({ ctx: "CTX" as never, target, options: harness.settings, toolCallId: "call-1" }), { allowed: true });
    const failing = options("shadow", { kind: "allow", reason: "" });
    failing.settings = { ...(failing.settings as object), classify: async () => { throw new Error("classify failed"); } } as never;
    assert.deepEqual(await reviewSlateCloudAgentAction({ ctx: "CTX" as never, target, options: failing.settings, toolCallId: "call-1" }), { allowed: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(failing.reports, ["classify failed"]);
  });

  it("allows an allowed action and blocks what the classifier blocks", async () => {
    const allowed = options("enforce", { kind: "allow", reason: "" });
    assert.deepEqual(await reviewSlateCloudAgentAction({ ctx: "CTX" as never, target, options: allowed.settings, toolCallId: "call-1" }), { allowed: true });
    const other = options("enforce", { kind: "other", reason: "no idea" });
    assert.deepEqual(await reviewSlateCloudAgentAction({ ctx: "CTX" as never, target, options: other.settings, toolCallId: "call-1" }), { allowed: false, reason: "no idea" });
    const noController = options("enforce", { kind: "block", reason: "needs approval" }, { controller: false });
    assert.deepEqual(await reviewSlateCloudAgentAction({ ctx: "CTX" as never, target, options: noController.settings, toolCallId: "call-1" }), { allowed: false, reason: "needs approval" });
  });

  it("asks for approval of a blocked action and reports the answer", async () => {
    const approved = options("enforce", { kind: "block", reason: "needs approval", proposedRule: { rule: "x" } }, { answers: [{ approved: true }], expiry: () => "1h" });
    assert.deepEqual(await reviewSlateCloudAgentAction({ ctx: "CTX" as never, target, options: approved.settings, toolCallId: "call-1" }), { allowed: true });
    assert.deepEqual(Object.keys(approved.calls[0] as object).sort(), ["agentId", "expiryPolicy", "fingerprint", "proposedRule", "reason", "summary", "surface"]);
    assert.deepEqual([(approved.calls[0] as any).expiryPolicy, (approved.calls[0] as any).surface, (approved.calls[0] as any).summary], ["1h", "cloud_agent", "Start a cloud agent: “do it”"]);
    const denied = options("enforce", { kind: "block", reason: "needs approval" }, { answers: [{ approved: false, reason: "no" }] });
    assert.deepEqual(await reviewSlateCloudAgentAction({ ctx: "CTX" as never, target, options: denied.settings, toolCallId: "call-1" }), { allowed: false, reason: "no" });
    const deniedNoReason = options("enforce", { kind: "block", reason: "needs approval" }, { answers: [{ approved: false }] });
    assert.deepEqual(await reviewSlateCloudAgentAction({ ctx: "CTX" as never, target, options: deniedNoReason.settings, toolCallId: "call-1" }), { allowed: false, reason: "needs approval" });
  });

  it("answers cancelled when the caller has gone away", async () => {
    const harness = options("enforce", { kind: "allow", reason: "" });
    const signal = AbortSignal.abort();
    assert.deepEqual(await reviewSlateCloudAgentAction({ ctx: "CTX" as never, target, options: harness.settings, toolCallId: "call-1", signal }), { allowed: false, reason: "The cloud agent action was cancelled." });
  });
});

describe("reviewing a lifecycle action", () => {
  it("builds its target and knows why each action needs approval", () => {
    assert.deepEqual(buildSlateCloudAgentLifecycleReviewTarget({ action: "rename", agent_id: " agent-1 ", title: " New " }), { action: "rename", agentId: "agent-1", title: "New" });
    assert.deepEqual(buildSlateCloudAgentLifecycleReviewTarget({ action: "delete", agent_id: "agent-1" }), { action: "delete", agentId: "agent-1" });
    assert.equal(buildSlateCloudAgentLifecycleReviewTarget({ action: "rename", agent_id: "  " }), undefined);
    assert.equal(buildSlateCloudAgentLifecycleReviewTarget({ action: "launch", agent_id: "agent-1" }), undefined);
    assert.equal(slateCloudAgentLifecycleReason("delete"), "Deleting a cloud agent is permanent and cannot be undone, so it needs your approval.");
    assert.equal(slateCloudAgentLifecycleReason("rename"), "Renaming a cloud agent changes how it appears everywhere, so it needs your approval.");
    assert.equal(LIFECYCLE_REVIEW_UNAVAILABLE_REASON, "This action needs Auto-review approval, which isn't available in this conversation. Run it from a direct chat with the assistant.");
  });

  it("asks for approval in enforce mode, and answers what the approval says", async () => {
    const target = { action: "delete" as const, agentId: "agent-2" };
    const calls: any[] = [];
    const settings = (answers: Array<{ approved: boolean; reason?: string }>) => ({
      mode: "enforce",
      agentId: "agent-1",
      autoReviewController: { requestApproval: async (request: unknown) => { calls.push(request); return [...answers].shift() ?? { approved: true }; } },
    });
    assert.deepEqual(await reviewSlateCloudAgentLifecycleAction({ ctx: "CTX" as never, target, options: settings([{ approved: true }]) as never }), { allowed: true });
    assert.deepEqual((calls[0] as any).reason, "Deleting a cloud agent is permanent and cannot be undone, so it needs your approval.");
    assert.deepEqual(await reviewSlateCloudAgentLifecycleAction({ ctx: "CTX" as never, target, options: settings([{ approved: false }]) as never }), { allowed: false, reason: "Deleting a cloud agent is permanent and cannot be undone, so it needs your approval." });
    assert.deepEqual(await reviewSlateCloudAgentLifecycleAction({ ctx: "CTX" as never, target, options: { mode: "off", agentId: "agent-1" } as never }), { allowed: true });
    assert.deepEqual(await reviewSlateCloudAgentLifecycleAction({ ctx: "CTX" as never, target, options: { mode: "enforce", agentId: "agent-1" } as never }), { allowed: false, reason: LIFECYCLE_REVIEW_UNAVAILABLE_REASON });
  });
});
