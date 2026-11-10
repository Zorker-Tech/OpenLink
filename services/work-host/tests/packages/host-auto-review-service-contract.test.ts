import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AutoReviewService,
  parseLocalAutoReviewMode,
  SETTLED_APPROVAL_MEMORY,
} from "../../source/host/extensions/auto-review/auto-review-service.ts";
import {
  AUTO_REVIEW_AWAITING_TAB_ID,
  type ReviewAwaitingState,
} from "../../source/host/extensions/auto-review/slate-auto-review-awaiting.ts";
import type { SlateAutoReviewInstructions } from "../../source/shared/slate-auto-review-instructions.ts";
import { SLATE_AUTO_REVIEW_STALE, SLATE_AUTO_REVIEW_STALE_MESSAGE } from "../../source/shared/transcript.ts";
import type { SlateAutoReviewRequest } from "../../source/host/runner/slate-auto-review.ts";

function serviceWorld(options: {
  readonly enabled?: boolean;
  readonly featureGate?: boolean;
  readonly localMode?: "off" | "shadow" | "enforce";
  readonly settleStaleCard?: boolean;
} = {}) {
  const auth = { source: "session-auth" };
  let nowMs = 1_000;
  let featureGate = options.featureGate ?? false;
  let instructions: SlateAutoReviewInstructions = {
    isEnabled: options.enabled ?? true,
    allowInstructions: ["safe reads"],
    blockInstructions: ["secret export"],
  };
  let settleStaleCard = options.settleStaleCard ?? false;
  const featureGateReads: string[] = [];
  const classifierAuths: unknown[] = [];
  const approvalReports: Record<string, unknown>[] = [];
  const displayFailureReports: { conversationId: string }[] = [];
  const awaitingWrites: { agentId: string; state: ReviewAwaitingState }[] = [];
  const awaitingClears: { agentId: string; tabId: string; options?: { ifSinceBefore?: number } }[] = [];
  const staleCardCalls: { agentId: string; entryId: string; requestId: string }[] = [];

  const service = new AutoReviewService({
    auth,
    experiments: {
      checkFeatureGate: (name) => { featureGateReads.push(name); return featureGate; },
    },
    settings: { getAutoReviewInstructions: () => instructions },
    telemetry: {
      reportAutoReviewDisplayRecheckFailed: (report) => { displayFailureReports.push(report); },
      reportAutoReviewApproval: (report) => { approvalReports.push(report); },
    },
    awaitingSink: {
      trySetForTab: (agentId, state) => { awaitingWrites.push({ agentId, state }); },
      clearForTab: (agentId, tabId, clearOptions) => {
        awaitingClears.push({ agentId, tabId, ...(clearOptions === undefined ? {} : { options: clearOptions }) });
      },
    },
    transcript: {
      settleStaleAutoReviewCard: async (args) => { staleCardCalls.push(args); return settleStaleCard; },
    },
    hostGeneration: "host-generation-1",
    ...(options.localMode === undefined ? {} : { localMode: options.localMode }),
    createClassifierExecutor: (receivedAuth) => { classifierAuths.push(receivedAuth); return { auth: receivedAuth }; },
    now: () => nowMs,
  });

  return {
    service,
    auth,
    featureGateReads,
    classifierAuths,
    approvalReports,
    displayFailureReports,
    awaitingWrites,
    awaitingClears,
    staleCardCalls,
    setNow(value: number) { nowMs = value; },
    setFeatureGate(value: boolean) { featureGate = value; },
    setInstructions(value: SlateAutoReviewInstructions) { instructions = value; },
    setSettleStaleCard(value: boolean) { settleStaleCard = value; },
    bind(agentId = "agent-1", approvalsResolvable?: boolean) {
      const updates: unknown[] = [];
      const runner = service.bindRunner({
        agentId,
        ...(approvalsResolvable === undefined ? {} : { approvalsResolvable }),
        onUpdate: (update) => { updates.push(update); },
      });
      return { ...runner, updates };
    },
  };
}

function request(overrides: Partial<SlateAutoReviewRequest> = {}): SlateAutoReviewRequest {
  return {
    surface: "hostShell",
    fingerprint: "fingerprint-1",
    reason: "Review this command",
    summary: "Run a command",
    ...overrides,
  };
}

describe("the auto-review service contract", () => {
  it("accepts only the three named local modes", () => {
    assert.deepEqual(
      ["off", "shadow", "enforce", "OFF", "", "other", null, 1].map(parseLocalAutoReviewMode),
      ["off", "shadow", "enforce", undefined, undefined, undefined, undefined, undefined],
    );
    assert.equal(SETTLED_APPROVAL_MEMORY, 256);
  });

  it("binds the classifier to host auth and reads current mode settings on demand", () => {
    const world = serviceWorld();
    const runner = world.bind("agent-a");
    assert.deepEqual(runner.autoReviewModes, {
      hostShell: "shadow", boxShell: "shadow", mcp: "shadow", computer: "shadow",
      automationWrite: "off", cloudAgent: "shadow", subagentLaunch: "shadow",
    });
    assert.deepEqual(runner.autoReviewClassifierExecutor, { auth: world.auth });
    assert.deepEqual(world.classifierAuths, [world.auth]);
    assert.deepEqual(runner.getAutoReviewInstructions(), {
      isEnabled: true, allowInstructions: ["safe reads"], blockInstructions: ["secret export"],
    });

    world.setFeatureGate(true);
    assert.equal(runner.getAutoReviewModes().hostShell, "enforce");
    world.setInstructions({ isEnabled: false, allowInstructions: [], blockInstructions: [] });
    assert.equal(runner.getAutoReviewModes().hostShell, "off");
    assert.deepEqual(world.featureGateReads, ["slate_auto_review", "slate_auto_review", "slate_auto_review"]);
  });

  it("uses the local mode override only while auto-review is enabled in settings", () => {
    const overridden = serviceWorld({ featureGate: true, localMode: "off" }).bind();
    assert.equal(overridden.getAutoReviewModes().hostShell, "off");
    const disabled = serviceWorld({ enabled: false, featureGate: true, localMode: "enforce" }).bind();
    assert.equal(disabled.getAutoReviewModes().hostShell, "off");
  });

  it("turns a created approval into a message, telemetry, and an awaiting badge", async () => {
    const world = serviceWorld();
    const runner = world.bind("agent-a");
    const pending = runner.autoReviewController.requestApproval(request({
      reason: "  Check this change  ",
      summary: "  Review the patch  ",
      command: "  git push origin main  ",
      proposedRule: "  always   check\n protected branches  ",
    }));
    const [approval] = runner.autoReviewController.getPendingApprovals();
    assert.ok(approval);
    assert.deepEqual(runner.updates, [{
      type: "send-message",
      message: {
        type: "auto-review-approval",
        approval: {
          requestId: approval.id,
          surface: "hostShell",
          summary: "Review the patch",
          reason: "Check this change",
          status: "pending",
          command: "git push origin main",
          proposedRule: "always check protected branches",
        },
      },
      timestampMs: 1_000,
    }]);
    assert.deepEqual(world.approvalReports, [{
      eventType: "created", conversationId: "agent-a", approvalId: approval.id,
      surface: "hostShell", status: "pending", ageMs: 0, ttlMs: 600_000,
    }]);
    assert.deepEqual(world.awaitingWrites, [{
      agentId: "agent-a",
      state: { tabId: AUTO_REVIEW_AWAITING_TAB_ID, reason: "Approval needed: Review the patch", since: 1_000 },
    }]);
    assert.deepEqual(world.service.pendingAwaitingState("agent-a"), {
      tabId: AUTO_REVIEW_AWAITING_TAB_ID, reason: "Approval needed: Review the patch", since: 1_000,
    });

    runner.autoReviewController.resolveApproval(approval.id, "approved");
    assert.deepEqual(await pending, { approved: true });
  });

  it("reports a decision once, removes its awaiting badge, and ignores duplicate resolution", async () => {
    const world = serviceWorld();
    const runner = world.bind("agent-a");
    const pending = runner.autoReviewController.requestApproval(request());
    const [approval] = runner.autoReviewController.getPendingApprovals();
    assert.ok(approval);
    world.setNow(1_450);

    await world.service.resolveApproval({ requestId: approval.id, resolution: "approved", agentId: "agent-a", entryId: "entry-a" });
    assert.deepEqual(await pending, { approved: true });
    await world.service.resolveApproval({ requestId: approval.id, resolution: "denied", agentId: "agent-a", entryId: "entry-a" });

    assert.deepEqual(runner.updates.slice(1), [{ type: "auto-review-status", requestId: approval.id, status: "approved" }]);
    assert.deepEqual(world.approvalReports[1], {
      eventType: "resolved", conversationId: "agent-a", approvalId: approval.id,
      surface: "hostShell", status: "approved", ageMs: 450, ttlMs: 600_000,
    });
    assert.deepEqual(world.awaitingClears, [{ agentId: "agent-a", tabId: AUTO_REVIEW_AWAITING_TAB_ID }]);
    assert.equal(world.service.pendingAwaitingState("agent-a"), null);
    assert.deepEqual(world.staleCardCalls, []);
  });

  it("forwards a denial as a status and resolves the waiting action with its refusal reason", async () => {
    const world = serviceWorld();
    const runner = world.bind();
    const pending = runner.autoReviewController.requestApproval(request({ reason: "network access" }));
    const [approval] = runner.autoReviewController.getPendingApprovals();
    assert.ok(approval);

    await world.service.resolveApproval({ requestId: approval.id, resolution: "denied", agentId: "agent-1", entryId: "entry-1" });
    const decision = await pending;
    assert.equal(decision.approved, false);
    if (!decision.approved) assert.match(decision.reason, /network access/);
    assert.deepEqual(runner.updates.at(-1), { type: "auto-review-status", requestId: approval.id, status: "denied" });
  });

  it("does not put parked approvals on a TTL and omits absent card fields", async () => {
    const world = serviceWorld();
    const runner = world.bind();
    const pending = runner.autoReviewController.requestApproval(request({ expiryPolicy: "park" }));
    const [approval] = runner.autoReviewController.getPendingApprovals();
    assert.ok(approval);
    assert.equal(approval.expiresAtMs, undefined);
    assert.deepEqual((runner.updates[0] as { message: { approval: Record<string, unknown> } }).message.approval, {
      requestId: approval.id, surface: "hostShell", summary: "Run a command", reason: "Review this command", status: "pending",
    });
    assert.equal("ttlMs" in world.approvalReports[0]!, false);
    await world.service.resolveApproval({ requestId: approval.id, resolution: "approved", agentId: "agent-1", entryId: "entry-1" });
    assert.deepEqual(await pending, { approved: true });
  });

  it("settles stale cards through the transcript store when it still owns the entry", async () => {
    const world = serviceWorld({ settleStaleCard: true });
    await world.service.resolveApproval({ requestId: "old-request", resolution: "approved", agentId: "agent-a", entryId: "entry-a" });
    assert.deepEqual(world.staleCardCalls, [{ agentId: "agent-a", entryId: "entry-a", requestId: "old-request" }]);
  });

  it("refuses a stale card that the transcript store cannot settle", async () => {
    const world = serviceWorld();
    await assert.rejects(
      () => world.service.resolveApproval({ requestId: "missing", resolution: "approved", agentId: "agent-a", entryId: "entry-a" }),
      (error: unknown) => error instanceof Error && error.message === `${SLATE_AUTO_REVIEW_STALE}: ${SLATE_AUTO_REVIEW_STALE_MESSAGE}`,
    );
    assert.deepEqual(world.staleCardCalls, [{ agentId: "agent-a", entryId: "entry-a", requestId: "missing" }]);
  });

  it("counts pending approvals by unique runner and requesting agent ids", async () => {
    const world = serviceWorld();
    const first = world.bind("runner-a");
    const second = world.bind("runner-b");
    const pendingFirst = first.autoReviewController.requestApproval(request({ agentId: "child-a" }));
    const pendingSecond = second.autoReviewController.requestApproval(request());
    const firstApprovalId = first.autoReviewController.getPendingApprovals()[0]!.id;
    assert.deepEqual(world.service.agentIdsWithPendingApprovals(), ["runner-a", "child-a", "runner-b"]);

    world.service.expirePendingApprovals();
    assert.equal((await pendingFirst).approved, false);
    assert.equal((await pendingSecond).approved, false);
    assert.deepEqual(world.service.agentIdsWithPendingApprovals(), []);
    assert.deepEqual(world.awaitingClears.map(({ agentId }) => agentId), ["child-a", "runner-b"]);
    assert.equal(world.approvalReports[2]?.cause, "session_end");
    assert.equal(world.approvalReports[3]?.cause, "session_end");
    assert.deepEqual(first.updates.at(-1), {
      type: "auto-review-status",
      requestId: firstApprovalId,
      status: "expired",
    });
  });

  it("stop expires active approvals and detaches their update subscriptions", async () => {
    const world = serviceWorld();
    const runner = world.bind();
    const pending = runner.autoReviewController.requestApproval(request());
    const [approval] = runner.autoReviewController.getPendingApprovals();
    assert.ok(approval);

    world.service.stop();
    assert.equal((await pending).approved, false);
    assert.deepEqual(runner.updates.at(-1), { type: "auto-review-status", requestId: approval.id, status: "expired" });
    assert.deepEqual(world.service.agentIdsWithPendingApprovals(), []);

    const before = runner.updates.length;
    const later = runner.autoReviewController.requestApproval(request({ fingerprint: "after-stop" }));
    const [laterApproval] = runner.autoReviewController.getPendingApprovals();
    assert.ok(laterApproval);
    assert.equal(runner.updates.length, before);
    runner.autoReviewController.resolveApproval(laterApproval.id, "approved");
    assert.deepEqual(await later, { approved: true });
  });

  it("maps display recheck failures to conversation telemetry", () => {
    const world = serviceWorld();
    const runner = world.bind("runner-a");
    runner.autoReviewController.reportDisplayRecheckFailed("conversation-b");
    assert.deepEqual(world.displayFailureReports, [{ conversationId: "conversation-b" }]);
  });

  it("sweeps stale awaiting badges using the supplied age boundary", async () => {
    const world = serviceWorld();
    await world.service.sweepStaleAwaitingBadges(async () => ["agent-a", "agent-b"], 4_200);
    assert.deepEqual(world.awaitingClears, [
      { agentId: "agent-a", tabId: AUTO_REVIEW_AWAITING_TAB_ID, options: { ifSinceBefore: 4_200 } },
      { agentId: "agent-b", tabId: AUTO_REVIEW_AWAITING_TAB_ID, options: { ifSinceBefore: 4_200 } },
    ]);
  });

  it("swallows badge sweep failures so startup cleanup remains best effort", async () => {
    const world = serviceWorld();
    await assert.doesNotReject(() => world.service.sweepStaleAwaitingBadges(async () => { throw new Error("transcript offline"); }, 4_200));
    assert.deepEqual(world.awaitingClears, []);
  });

  it("forgets only the oldest settled approval after reaching its bounded memory", async () => {
    const world = serviceWorld();
    let firstId: string | undefined;
    for (let index = 0; index <= SETTLED_APPROVAL_MEMORY; index += 1) {
      const runner = world.bind(`agent-${index}`);
      const pending = runner.autoReviewController.requestApproval(request());
      const [approval] = runner.autoReviewController.getPendingApprovals();
      assert.ok(approval);
      firstId ??= approval.id;
      await world.service.resolveApproval({ requestId: approval.id, resolution: "approved", agentId: `agent-${index}`, entryId: `entry-${index}` });
      assert.deepEqual(await pending, { approved: true });
      if (index === SETTLED_APPROVAL_MEMORY - 1) {
        await world.service.resolveApproval({ requestId: firstId, resolution: "denied", agentId: "agent-0", entryId: "entry-0" });
        assert.deepEqual(world.staleCardCalls, []);
      }
    }

    await assert.rejects(() => world.service.resolveApproval({ requestId: firstId!, resolution: "approved", agentId: "agent-0", entryId: "entry-0" }));
    assert.deepEqual(world.staleCardCalls, [{ agentId: "agent-0", entryId: "entry-0", requestId: firstId }]);
  });
});
