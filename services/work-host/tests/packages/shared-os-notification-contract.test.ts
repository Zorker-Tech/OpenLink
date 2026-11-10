import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildNotificationContent,
  diffAgentNotificationTransitions,
  MAX_NOTIFICATION_BODY_LENGTH,
  shouldNotify,
  SlateOsNotificationDecider,
  SLATE_OS_NOTIFICATION_THROTTLE_MS,
  toNotificationSnapshot,
  type NotificationSnapshot,
} from "../../source/shared/os-notification.ts";

function snapshot(overrides: Partial<NotificationSnapshot> = {}): NotificationSnapshot {
  return {
    id: "agent-a",
    name: "Ada",
    isRunning: true,
    awaitingReason: null,
    notifyEnabled: true,
    isHiddenFromSidebar: false,
    lastMessagePreview: null,
    ...overrides,
  };
}

function decide(decider: SlateOsNotificationDecider, agents: readonly NotificationSnapshot[], nowMs: number, isWindowFocused = false) {
  return decider.decide({ agents, nowMs, isWindowFocused });
}

test("notification snapshots keep Slate-owned fields and omit an absent message id", () => {
  const value = toNotificationSnapshot({
    id: "agent-a",
    name: "Ada",
    isRunning: false,
    awaitingUserResponse: { reason: "" },
    notifyOnUpdatesEnabled: true,
    lastMessagePreview: "",
  });
  assert.deepEqual(value, {
    id: "agent-a",
    name: "Ada",
    isRunning: false,
    awaitingReason: "",
    notifyEnabled: true,
    isHiddenFromSidebar: false,
    lastMessagePreview: "",
  });
  assert.equal("lastMessageId" in value, false);
});

test("notification snapshots preserve a present null message id and default missing hidden state", () => {
  const value = toNotificationSnapshot({
    id: "agent-a",
    name: "Ada",
    isRunning: true,
    awaitingUserResponse: null,
    notifyOnUpdatesEnabled: false,
    lastMessageId: null,
    lastMessagePreview: null,
  });
  assert.equal(value.isHiddenFromSidebar, false);
  assert.equal(value.awaitingReason, null);
  assert.equal(value.lastMessageId, null);
  assert.equal("lastMessageId" in value, true);
  assert.equal(value.lastMessagePreview, null);
});

test("notification snapshots only mark an agent hidden when the flag is true", () => {
  const value = toNotificationSnapshot({
    id: "agent-a",
    name: "Ada",
    isRunning: true,
    notifyOnUpdatesEnabled: true,
    isHiddenFromSidebar: true,
  });
  assert.equal(value.isHiddenFromSidebar, true);
});

test("transition detection ignores unseen agents and reacts to newly awaiting or completed agents", () => {
  const previous = new Map([
    ["agent-a", snapshot()],
    ["agent-b", snapshot({ id: "agent-b", awaitingReason: "old question" })],
    ["agent-c", snapshot({ id: "agent-c", isRunning: false })],
    ["agent-d", snapshot({ id: "agent-d", awaitingReason: "held" })],
  ]);
  const transitions = diffAgentNotificationTransitions(previous, [
    snapshot({ awaitingReason: "choose one" }),
    snapshot({ id: "agent-b", isRunning: false, awaitingReason: null, lastMessageId: "m2", lastMessagePreview: "completed" }),
    snapshot({ id: "agent-c", isRunning: false, lastMessageId: "new-but-still-stopped" }),
    snapshot({ id: "agent-d", isRunning: false, awaitingReason: "held" }),
    snapshot({ id: "new-agent", awaitingReason: "unseen" }),
  ]);
  assert.deepEqual(transitions.map(({ agentId, kind, reason }) => [agentId, kind, reason]), [
    ["agent-a", "agent-needs-input", "choose one"],
    ["agent-b", "agent-done", null],
  ]);
  assert.equal(transitions[1]?.lastMessagePreview, "completed");
});

test("a newly awaiting state takes precedence if an update also ends the run", () => {
  const previous = new Map([["agent-a", snapshot()]]);
  const [transition] = diffAgentNotificationTransitions(previous, [snapshot({ isRunning: false, awaitingReason: "confirm" })]);
  assert.equal(transition?.kind, "agent-needs-input");
  assert.equal(transition?.reason, "confirm");
});

test("transition rows omit an absent message id", () => {
  const previous = new Map([["agent-a", snapshot()]]);
  const [transition] = diffAgentNotificationTransitions(previous, [snapshot({ awaitingReason: "question" })]);
  assert.equal(transition !== undefined && "lastMessageId" in transition, false);
});

test("the notification policy blocks each disabled condition and admits the exact throttle boundary", () => {
  assert.equal(SLATE_OS_NOTIFICATION_THROTTLE_MS, 5_000);
  const base = {
    isHidden: false,
    notifyEnabled: true,
    isWindowFocused: false,
    lastNotifiedAtMs: 1_000,
    nowMs: 6_000,
    throttleWindowMs: SLATE_OS_NOTIFICATION_THROTTLE_MS,
  };
  assert.equal(shouldNotify(base), true);
  assert.equal(shouldNotify({ ...base, nowMs: 5_999 }), false);
  assert.equal(shouldNotify({ ...base, isHidden: true }), false);
  assert.equal(shouldNotify({ ...base, notifyEnabled: false }), false);
  assert.equal(shouldNotify({ ...base, isWindowFocused: true }), false);
  assert.equal(shouldNotify({ ...base, lastNotifiedAtMs: null }), true);
});

test("notification content trims names, collapses body whitespace and uses kind-specific fallbacks", () => {
  const waiting = buildNotificationContent({
    agentId: "agent-a",
    agentName: "  Ada  ",
    kind: "agent-needs-input",
    reason: "  pick\n  a path  ",
    notifyEnabled: true,
    isHiddenFromSidebar: false,
    lastMessagePreview: null,
  });
  assert.deepEqual(waiting, { title: "Ada needs you", body: "pick a path" });
  const noReason = buildNotificationContent({
    agentId: "agent-a",
    agentName: " \n ",
    kind: "agent-needs-input",
    reason: " \t ",
    notifyEnabled: true,
    isHiddenFromSidebar: false,
    lastMessagePreview: null,
  });
  assert.deepEqual(noReason, { title: "Your agent needs you", body: "Waiting for your input." });
  const noSummary = buildNotificationContent({
    agentId: "agent-a",
    agentName: "Ada",
    kind: "agent-done",
    reason: null,
    notifyEnabled: true,
    isHiddenFromSidebar: false,
    lastMessagePreview: " \n ",
  });
  assert.deepEqual(noSummary, { title: "Ada", body: "Open Slate to see what it did." });
});

test("notification bodies preserve the maximum length and truncate longer text with an ellipsis", () => {
  const build = (lastMessagePreview: string) => buildNotificationContent({
    agentId: "agent-a",
    agentName: "Ada",
    kind: "agent-done",
    reason: null,
    notifyEnabled: true,
    isHiddenFromSidebar: false,
    lastMessagePreview,
  }).body;
  assert.equal(build("x".repeat(MAX_NOTIFICATION_BODY_LENGTH)), "x".repeat(MAX_NOTIFICATION_BODY_LENGTH));
  assert.equal(build("x".repeat(MAX_NOTIFICATION_BODY_LENGTH + 1)), `${"x".repeat(MAX_NOTIFICATION_BODY_LENGTH - 1)}…`);
  assert.equal(build(`${"x".repeat(MAX_NOTIFICATION_BODY_LENGTH - 2)} yy`), `${"x".repeat(MAX_NOTIFICATION_BODY_LENGTH - 2)}…`);
  assert.equal(build(`${"x".repeat(MAX_NOTIFICATION_BODY_LENGTH - 1)}   y`), `${"x".repeat(MAX_NOTIFICATION_BODY_LENGTH - 1)}…`);
});

test("the decider seeds silently and does not invent a transition for a new agent", () => {
  const decider = new SlateOsNotificationDecider();
  assert.deepEqual(decide(decider, [snapshot({ isRunning: false, lastMessageId: "m1" })], 1_000), []);
  decider.seedBaseline([snapshot({ id: "agent-b", isRunning: false, lastMessageId: "m1" })]);
  assert.deepEqual(decide(decider, [snapshot({ id: "agent-b", isRunning: false, lastMessageId: "m1" })], 2_000), []);
});

test("the decider emits a new waiting edge once and throttles a later edge for that kind", () => {
  const decider = new SlateOsNotificationDecider(5_000);
  const running = snapshot();
  const waiting = snapshot({ awaitingReason: "choose a path" });
  assert.deepEqual(decide(decider, [running], 0), []);
  assert.deepEqual(decide(decider, [waiting], 100).map(({ kind }) => kind), ["agent-needs-input"]);
  assert.deepEqual(decide(decider, [snapshot({ awaitingReason: "a different reason" })], 200), []);
  assert.deepEqual(decide(decider, [running], 300), []);
  assert.deepEqual(decide(decider, [waiting], 5_099), []);
  assert.deepEqual(decide(decider, [running], 5_100), []);
  assert.deepEqual(decide(decider, [waiting], 5_100).map(({ kind }) => kind), ["agent-needs-input"]);
});

test("a completion needs a message id that has not already been accounted for", () => {
  const decider = new SlateOsNotificationDecider(0);
  const running = snapshot({ lastMessageId: "m1" });
  const finishedSame = snapshot({ isRunning: false, lastMessageId: "m1" });
  const finishedNew = snapshot({ isRunning: false, lastMessageId: "m2", lastMessagePreview: "finished" });
  assert.deepEqual(decide(decider, [running], 0), []);
  assert.deepEqual(decide(decider, [finishedSame], 1), []);
  assert.deepEqual(decide(decider, [running], 2), []);
  assert.deepEqual(decide(decider, [finishedNew], 3).map(({ lastMessageId }) => lastMessageId), ["m2"]);
  assert.deepEqual(decide(decider, [snapshot({ isRunning: true, lastMessageId: "m2" })], 4), []);
  assert.deepEqual(decide(decider, [finishedNew], 5), []);
  assert.deepEqual(decide(decider, [snapshot({ isRunning: true, lastMessageId: "m2" })], 6), []);
  assert.deepEqual(decide(decider, [snapshot({ isRunning: false, lastMessageId: null })], 7), []);
});

test("an agent first observed without a message id does not silently account a later id", () => {
  const decider = new SlateOsNotificationDecider(0);
  assert.deepEqual(decide(decider, [snapshot()], 0), []);
  assert.deepEqual(decide(decider, [snapshot({ lastMessageId: "m1" })], 1), []);
  assert.deepEqual(decide(decider, [snapshot({ isRunning: false, lastMessageId: "m1" })], 2).map(({ kind }) => kind), ["agent-done"]);
});

test("a focused or muted completion is accounted and is not sent later as stale news", () => {
  const decider = new SlateOsNotificationDecider(0);
  const running = snapshot({ lastMessageId: "m0" });
  const finished = snapshot({ isRunning: false, lastMessageId: "m1" });
  assert.deepEqual(decide(decider, [running], 0), []);
  assert.deepEqual(decide(decider, [finished], 1, true), []);
  assert.deepEqual(decide(decider, [running], 2, false), []);
  assert.deepEqual(decide(decider, [finished], 3, false), []);

  const muted = new SlateOsNotificationDecider(0);
  assert.deepEqual(decide(muted, [running], 0), []);
  assert.deepEqual(decide(muted, [snapshot({ isRunning: false, lastMessageId: "m2", notifyEnabled: false })], 1), []);
  assert.deepEqual(decide(muted, [running], 2), []);
  assert.deepEqual(decide(muted, [snapshot({ isRunning: false, lastMessageId: "m2", notifyEnabled: true })], 3), []);
});

test("waiting and completion throttles are independent for the same agent", () => {
  const decider = new SlateOsNotificationDecider(5_000);
  assert.deepEqual(decide(decider, [snapshot()], 0), []);
  assert.deepEqual(decide(decider, [snapshot({ awaitingReason: "question" })], 100).map(({ kind }) => kind), ["agent-needs-input"]);
  assert.deepEqual(decide(decider, [snapshot({ isRunning: false, awaitingReason: null, lastMessageId: "m1" })], 200).map(({ kind }) => kind), ["agent-done"]);
});

test("seeding a known agent happens only once and preserves the first baseline", () => {
  const decider = new SlateOsNotificationDecider(0);
  decider.seedBaseline([snapshot()]);
  decider.seedBaseline([snapshot({ isRunning: false, lastMessageId: "m1" })]);
  assert.deepEqual(decide(decider, [snapshot({ isRunning: false, lastMessageId: "m1" })], 1).map(({ kind }) => kind), ["agent-done"]);
});

test("single-agent updates leave other agents' baselines available", () => {
  const decider = new SlateOsNotificationDecider(0);
  decider.seedBaseline([snapshot(), snapshot({ id: "agent-b" })]);
  assert.deepEqual(decider.decideAgent(snapshot({ awaitingReason: "question" }), { nowMs: 1, isWindowFocused: false }).map(({ agentId }) => agentId), ["agent-a"]);
  assert.deepEqual(decide(decider, [snapshot({ id: "agent-b", isRunning: false, lastMessageId: "m1" })], 2).map(({ agentId }) => agentId), ["agent-b"]);
});

test("single-agent updates advance that agent's baseline for later completion decisions", () => {
  const decider = new SlateOsNotificationDecider(0);
  decider.seedBaseline([snapshot()]);
  assert.deepEqual(decider.decideAgent(snapshot({ awaitingReason: "question" }), { nowMs: 1, isWindowFocused: false }).map(({ kind }) => kind), ["agent-needs-input"]);
  assert.deepEqual(decider.decideAgent(snapshot(), { nowMs: 2, isWindowFocused: false }), []);
  assert.deepEqual(decider.decideAgent(snapshot({ isRunning: false, lastMessageId: "m1" }), { nowMs: 3, isWindowFocused: false }).map(({ kind }) => kind), ["agent-done"]);
});

test("a full snapshot drops missing agents from the next transition baseline", () => {
  const decider = new SlateOsNotificationDecider(0);
  assert.deepEqual(decide(decider, [snapshot()], 0), []);
  assert.deepEqual(decide(decider, [], 1), []);
  assert.deepEqual(decide(decider, [snapshot({ isRunning: false, lastMessageId: "m1" })], 2), []);
});

test("forgetting one agent leaves other agents' transition state intact", () => {
  const decider = new SlateOsNotificationDecider(0);
  decider.seedBaseline([snapshot(), snapshot({ id: "agent-b" })]);
  decider.forget("agent-a");
  assert.deepEqual(decide(decider, [snapshot({ id: "agent-b", isRunning: false, lastMessageId: "m1" })], 1).map(({ agentId }) => agentId), ["agent-b"]);
});

test("forgetting one agent keeps another agent's message accounting and throttle window", () => {
  const decider = new SlateOsNotificationDecider(60_000);
  decider.seedBaseline([snapshot(), snapshot({ id: "agent-b", lastMessageId: "m0" })]);
  assert.deepEqual(decide(decider, [snapshot({ id: "agent-b", awaitingReason: "question", lastMessageId: "m0" })], 1).length, 1);
  assert.deepEqual(decide(decider, [snapshot({ id: "agent-b", lastMessageId: "m0" })], 2), []);
  decider.forget("agent-a");
  assert.deepEqual(decide(decider, [snapshot({ id: "agent-b", awaitingReason: "another question", lastMessageId: "m0" })], 3), []);
  assert.deepEqual(decide(decider, [snapshot({ id: "agent-b", isRunning: false, lastMessageId: "m0" })], 4), []);
});

test("forgetting one agent does not make another agent's finished message look new", () => {
  const decider = new SlateOsNotificationDecider(0);
  decider.seedBaseline([snapshot({ lastMessageId: "m0" }), snapshot({ id: "agent-b", lastMessageId: "m0" })]);
  decider.forget("agent-a");
  assert.deepEqual(decide(decider, [snapshot({ id: "agent-b", isRunning: false, lastMessageId: "m0" })], 1), []);
});

test("forget clears previous state, accounted messages and both throttle kinds", () => {
  const decider = new SlateOsNotificationDecider(60_000);
  assert.deepEqual(decide(decider, [snapshot({ lastMessageId: "m0" })], 0), []);
  assert.deepEqual(decide(decider, [snapshot({ awaitingReason: "question", lastMessageId: "m0" })], 1).length, 1);
  assert.deepEqual(decide(decider, [snapshot({ lastMessageId: "m0" })], 2), []);
  assert.deepEqual(decide(decider, [snapshot({ isRunning: false, lastMessageId: "m1" })], 3).map(({ kind }) => kind), ["agent-done"]);
  decider.forget("agent-a");
  decider.seedBaseline([snapshot({ lastMessageId: "m0" })]);
  assert.deepEqual(decide(decider, [snapshot({ awaitingReason: "question", lastMessageId: "m0" })], 4).map(({ kind }) => kind), ["agent-needs-input"]);
  assert.deepEqual(decide(decider, [snapshot({ lastMessageId: "m0" })], 5), []);
  assert.deepEqual(decide(decider, [snapshot({ isRunning: false, lastMessageId: "m1" })], 6).map(({ kind }) => kind), ["agent-done"]);
});

test("forget lets the next baseline establish fresh transition and message state", () => {
  const decider = new SlateOsNotificationDecider(0);
  decider.seedBaseline([snapshot({ lastMessageId: "m0" })]);
  assert.deepEqual(decide(decider, [snapshot({ isRunning: false, lastMessageId: "m1" })], 1).map(({ kind }) => kind), ["agent-done"]);
  decider.forget("agent-a");
  decider.seedBaseline([snapshot({ lastMessageId: "m0" })]);
  assert.deepEqual(decide(decider, [snapshot({ isRunning: false, lastMessageId: "m1" })], 2).map(({ kind }) => kind), ["agent-done"]);
});

test("observing an agent updates its transition baseline without replacing its accounted message", () => {
  const decider = new SlateOsNotificationDecider(0);
  decider.observeAgent(snapshot({ isRunning: true, lastMessageId: "m1" }));
  decider.observeAgent(snapshot({ isRunning: true, lastMessageId: "m2" }));
  assert.deepEqual(decide(decider, [snapshot({ isRunning: false, lastMessageId: "m2" })], 1).map(({ kind }) => kind), ["agent-done"]);
  assert.deepEqual(decide(decider, [snapshot({ isRunning: true, lastMessageId: "m2" })], 2), []);
  assert.deepEqual(decide(decider, [snapshot({ isRunning: false, lastMessageId: "m2" })], 3), []);
});
