/**
 * The auto-review controller: what a card carries, how a decision is taken, and the four ways a card ends without one.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SLATE_AUTO_REVIEW_MODES_ENFORCE,
  SLATE_AUTO_REVIEW_MODES_OFF,
  SLATE_AUTO_REVIEW_MODES_SHADOW,
  SlateAutoReviewController,
  fingerprintSlateAutoReviewTarget,
  formatSlateAutoReviewDeniedReason,
  formatSlateAutoReviewInterruptedForUpdateReason,
  resolveSlateAutoReviewModes,
  slateAutoReviewApprovalExpiryPolicy,
  type SlateAutoReviewEvent,
  type SlateAutoReviewRequest,
} from "../../source/host/runner/slate-auto-review.ts";

const request = (overrides: Partial<SlateAutoReviewRequest> = {}): SlateAutoReviewRequest => ({
  surface: "hostShell",
  fingerprint: "fp-1",
  reason: "the command touches the network",
  summary: "A shell command",
  ...overrides,
});

function controller(options: { approvalTtlMs?: number; maxPendingPerAgent?: number; approvalsResolvable?: boolean; now?: () => number } = {}) {
  let nextId = 1;
  const events: SlateAutoReviewEvent[] = [];
  const instance = new SlateAutoReviewController({
    agentId: "agent-1",
    hostGeneration: "gen-1",
    approvalTtlMs: options.approvalTtlMs ?? 10_000,
    ...(options.maxPendingPerAgent === undefined ? {} : { maxPendingPerAgent: options.maxPendingPerAgent }),
    ...(options.approvalsResolvable === undefined ? {} : { approvalsResolvable: options.approvalsResolvable }),
    ...(options.now === undefined ? {} : { now: options.now }),
    randomId: () => `approval-${nextId++}`,
  });
  const unsubscribe = instance.subscribe((event) => events.push(event));
  return { instance, events, unsubscribe };
}

const settle = async <T>(promise: Promise<T>) => promise;

describe("what a card carries", () => {
  it("is trimmed, bounded, stamped with this host's moment, and expired only when its policy says so", async () => {
    const { instance, events } = controller({ now: () => 1_000 });
    const decision = instance.requestApproval(request({ id: undefined } as never));
    const approval = instance.getPendingApprovals()[0]!;
    assert.deepEqual(
      [approval.id, approval.agentId, approval.userMessageEpoch, approval.hostGeneration, approval.createdAtMs, approval.expiresAtMs, approval.status],
      ["approval-1", "agent-1", 0, "gen-1", 1_000, 11_000, "pending"],
    );
    assert.equal(events[0]!.type, "created");
    instance.resolveApproval("approval-1", "approved");
    await decision;
  });

  it("takes the caller's text as shown, with fallbacks and with the whitespace of a proposed rule collapsed", async () => {
    const { instance } = controller();
    const pending = instance.requestApproval(request({ reason: "   ", summary: "", command: "x".repeat(5_000), proposedRule: "  a\n\n  rule  " }));
    const [approval] = instance.getPendingApprovals();
    assert.equal(approval!.reason, "This action requires your approval.");
    assert.equal(approval!.summary, "Sensitive action");
    assert.equal(approval!.command!.length, 4_000);
    assert.equal(approval!.proposedRule, "a rule");
    instance.resolveApproval(approval!.id, "approved");
    await pending;
  });

  it("leaves the expiry off for a parked card", async () => {
    const { instance } = controller();
    const pending = instance.requestApproval(request({ expiryPolicy: "park" }));
    assert.equal("expiresAtMs" in instance.getPendingApprovals()[0]!, false);
    assert.equal(slateAutoReviewApprovalExpiryPolicy("turn"), "park");
    assert.equal(slateAutoReviewApprovalExpiryPolicy("handoff-resume"), "park");
    assert.equal(slateAutoReviewApprovalExpiryPolicy("tool"), "ttl");
    instance.resolveApproval("approval-1", "approved");
    await pending;
  });
});

describe("when a request is refused instead of queued", () => {
  it("refuses a cancelled action, a winding-down host, a conversation that cannot ask, and an agent at its ceiling", async () => {
    const aborted = new AbortController();
    aborted.abort();
    const cancelled = controller();
    assert.deepEqual(await cancelled.instance.requestApproval(request({ signal: aborted.signal })), { approved: false, reason: "The action was cancelled." });
    assert.equal(cancelled.events.length, 0, "a refused request raises no card");

    const quiesced = controller();
    quiesced.instance.expireForQuiesce();
    const interrupted = await quiesced.instance.requestApproval(request());
    assert.equal(interrupted.approved, false);
    assert.match(interrupted.approved ? "" : interrupted.reason, /host update interrupted this approval request/);
    quiesced.instance.cancelQuiesce();
    const allowed = quiesced.instance.requestApproval(request());
    assert.equal(quiesced.instance.getPendingApprovals().length, 1);
    quiesced.instance.resolveApproval("approval-1", "approved");
    await allowed;

    const unresolvable = controller({ approvalsResolvable: false });
    const refused = await unresolvable.instance.requestApproval(request());
    assert.match(refused.approved ? "" : refused.reason, /isn't available in this conversation/);

    // The ceiling is per agent: one waiting card blocks a second for the same agent, and not for another.
    const ceiling = controller({ maxPendingPerAgent: 1 });
    const first = ceiling.instance.requestApproval(request());
    const tooMany = await ceiling.instance.requestApproval(request());
    assert.match(tooMany.approved ? "" : tooMany.reason, /Too many actions are already waiting/);
    const otherAgent = ceiling.instance.requestApproval(request({ agentId: "agent-2" }));
    assert.equal(ceiling.instance.getPendingApprovals().length, 2);
    ceiling.instance.resolveApproval("approval-1", "approved");
    ceiling.instance.resolveApproval("approval-2", "approved");
    await Promise.all([first, otherAgent]);
  });
});

describe("how a card is decided", () => {
  it("answers the asker once, with the denied reason spelled out when it was denied", async () => {
    const { instance, events } = controller();
    const approved = instance.requestApproval(request());
    assert.equal(instance.resolveApproval("approval-1", "approved")!.status, "approved");
    assert.deepEqual(await approved, { approved: true });
    // A card is decided once: the second answer has nothing to answer.
    assert.equal(instance.resolveApproval("approval-1", "denied"), undefined);
    assert.deepEqual(events.map((event) => event.type), ["created", "resolved"]);

    const denied = instance.requestApproval(request());
    instance.resolveApproval("approval-2", "denied");
    const decision = await denied;
    assert.equal(decision.approved, false);
    assert.equal(decision.approved ? "" : decision.reason, formatSlateAutoReviewDeniedReason("the command touches the network"));
  });

  it("ignores a decision for another host, another moment, or a card that has expired", async () => {
    let now = 1_000;
    const { instance } = controller({ now: () => now });
    const parked = instance.requestApproval(request({ expiryPolicy: "park" }));
    // The epoch moves on: the old card cannot be answered any more.
    const epochEvents: SlateAutoReviewEvent[] = [];
    instance.subscribe((event) => epochEvents.push(event));
    instance.beginUserMessageEpoch();
    assert.equal(instance.resolveApproval("approval-1", "approved"), undefined);
    assert.equal(epochEvents.filter((event) => event.type === "expired").length, 1);
    await parked;

    const expiring = controller({ now: () => now });
    const card = expiring.instance.requestApproval(request());
    now += 10_000;
    // Past its expiry the decision is refused, and the card is still the one the timer will end.
    assert.equal(expiring.instance.resolveApproval("approval-1", "approved"), undefined);
    expiring.instance.expire("session_end");
    await card;
    assert.equal(instance.epoch, 1);
  });
});

describe("the ways a card ends without a decision", () => {
  it("expires on its own lifetime, and the asker is told it was not answered", async () => {
    const { instance, events } = controller({ approvalTtlMs: 5 });
    const decision = instance.requestApproval(request());
    const resolved = await decision;
    assert.equal(resolved.approved, false);
    assert.equal(events.at(-1)!.type, "expired");
    const expired = events.at(-1)!;
    assert.equal(expired.type === "expired" ? expired.cause : "", "ttl");
    assert.equal(instance.getPendingApprovals().length, 0);
  });

  it("ends on the caller's cancellation, on a settings change for its surface, and on a quiesce", async () => {
    const cancelled = controller();
    const controllerAbort = new AbortController();
    const cancelledCard = cancelled.instance.requestApproval(request({ signal: controllerAbort.signal }));
    controllerAbort.abort();
    assert.deepEqual(await cancelledCard, { approved: false, reason: "The action was cancelled." });
    const cancelledEvent = cancelled.events.at(-1)!;
    assert.equal(cancelledEvent.type === "expired" ? cancelledEvent.cause : "", "cancelled");

    const surfaces = controller();
    const shell = surfaces.instance.requestApproval(request({ surface: "hostShell" }));
    const mcp = surfaces.instance.requestApproval(request({ surface: "mcp" }));
    surfaces.instance.expireSurfaces(new Set(["hostShell"]));
    const shellDecision = await shell;
    assert.match(shellDecision.approved ? "" : shellDecision.reason, /Auto-review settings changed/);
    assert.equal(surfaces.instance.getPendingApprovals().length, 1, "the other surface is left alone");
    surfaces.instance.resolveApproval("approval-2", "approved");
    await mcp;

    const quiesced = controller();
    const interrupted = quiesced.instance.requestApproval(request());
    quiesced.instance.expireForQuiesce();
    const decision = await interrupted;
    assert.equal(decision.approved ? "" : decision.reason, formatSlateAutoReviewInterruptedForUpdateReason("the command touches the network"));
  });
});

describe("the modes and the fingerprint", () => {
  it("is off without the setting, the override when there is one, and the gate otherwise", () => {
    assert.equal(resolveSlateAutoReviewModes({ settingsEnabled: false, enforceEnabled: true }), SLATE_AUTO_REVIEW_MODES_OFF);
    assert.equal(resolveSlateAutoReviewModes({ settingsEnabled: true, enforceEnabled: false }), SLATE_AUTO_REVIEW_MODES_SHADOW);
    assert.equal(resolveSlateAutoReviewModes({ settingsEnabled: true, enforceEnabled: true }), SLATE_AUTO_REVIEW_MODES_ENFORCE);
    const overridden = resolveSlateAutoReviewModes({ settingsEnabled: true, enforceEnabled: true, localOverride: "off" });
    assert.deepEqual([overridden.hostShell, overridden.automationWrite], ["off", "off"]);
    // The automation-write surface has no mode of its own: it is never enforced by these sets.
    assert.equal(SLATE_AUTO_REVIEW_MODES_ENFORCE.automationWrite, "off");
    assert.equal(Object.isFrozen(SLATE_AUTO_REVIEW_MODES_SHADOW), true);
  });

  it("is the same target, and a different fingerprint for a different one", () => {
    assert.equal(fingerprintSlateAutoReviewTarget({ a: 1, b: [2] }), fingerprintSlateAutoReviewTarget({ a: 1, b: [2] }));
    assert.notEqual(fingerprintSlateAutoReviewTarget({ a: 1 }), fingerprintSlateAutoReviewTarget({ a: 2 }));
    assert.match(fingerprintSlateAutoReviewTarget({}), /^[0-9a-f]{64}$/);
  });
});
