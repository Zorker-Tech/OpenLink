/**
 * The automation spend guard: answer sentinels, the evaluation matrix, run counting, widgets, acknowledgements and the
 * reminder the agent receives.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SPEND_GUARD_ANSWER_ACKS,
  SPEND_GUARD_ANSWER_VALUES,
  SPEND_GUARD_IDLE_TTL_MS,
  SPEND_GUARD_MIN_FIRES_SINCE_VIEWED,
  SPEND_GUARD_MIN_UNREAD_COUNT,
  SPEND_GUARD_PAUSE_DELAY_MS,
  SPEND_GUARD_SNOOZE_MS,
  SPEND_GUARD_VALUE_PREFIX,
  buildSpendGuardNudgeWidget,
  buildSpendGuardPausedWidget,
  countAutomationRunsSince,
  evaluateAutomationSpendGuard,
  interpretSpendGuardAnswer,
  isSpendGuardCard,
  renderSpendGuardAnswerAck,
  renderSpendGuardNudgeReminder,
} from "../../source/host/transcript/slate-automation-spend-guard.ts";

test("the guard constants and answer sentinels are fixed", () => {
  assert.equal(SPEND_GUARD_IDLE_TTL_MS, 259_200_000);
  assert.equal(SPEND_GUARD_MIN_UNREAD_COUNT, 15);
  assert.equal(SPEND_GUARD_MIN_FIRES_SINCE_VIEWED, 20);
  assert.equal(SPEND_GUARD_PAUSE_DELAY_MS, 259_200_000);
  assert.equal(SPEND_GUARD_SNOOZE_MS, 2_592_000_000);
  assert.equal(SPEND_GUARD_VALUE_PREFIX, "spend-guard:");
  assert.deepEqual(SPEND_GUARD_ANSWER_VALUES, {
    keep: "spend-guard:keep",
    pause: "spend-guard:pause",
    optOut: "spend-guard:never-ask",
    resume: "spend-guard:resume",
    stayPaused: "spend-guard:stay-paused",
  });
});

test("only an exact sentinel is interpreted, and every sentinel maps back", () => {
  assert.equal(interpretSpendGuardAnswer("spend-guard:keep"), "keep");
  assert.equal(interpretSpendGuardAnswer("spend-guard:pause"), "pause");
  assert.equal(interpretSpendGuardAnswer("spend-guard:never-ask"), "optOut");
  assert.equal(interpretSpendGuardAnswer("spend-guard:resume"), "resume");
  assert.equal(interpretSpendGuardAnswer("spend-guard:stay-paused"), "stayPaused");
  for (const value of ["keep", "", "spend-guard:", "spend-guard:unknown", "keep ", "SPEND-GUARD:keep"]) assert.equal(interpretSpendGuardAnswer(value), null, value);
});

const base = { nowMs: 100_000_000, lastViewedAtMs: 100_000_000 - 10_000, unreadCount: 0, firesSinceViewedCount: 0, nudgedAtMs: null, snoozedUntilMs: null, optedOut: false };

test("the evaluation matrix follows option, activity, snooze, nudge and threshold order", () => {
  assert.equal(evaluateAutomationSpendGuard({ ...base, optedOut: true }), "opted-out");
  assert.equal(evaluateAutomationSpendGuard(base), "user-active");
  assert.equal(evaluateAutomationSpendGuard({ ...base, lastViewedAtMs: base.nowMs - SPEND_GUARD_IDLE_TTL_MS + 1 }), "user-active");
  assert.equal(evaluateAutomationSpendGuard({ ...base, lastViewedAtMs: base.nowMs - SPEND_GUARD_IDLE_TTL_MS }), "below-thresholds");
  assert.equal(evaluateAutomationSpendGuard({ ...base, lastViewedAtMs: base.nowMs - SPEND_GUARD_IDLE_TTL_MS, snoozedUntilMs: base.nowMs + 1_000 }), "snoozed");
  assert.equal(evaluateAutomationSpendGuard({ ...base, lastViewedAtMs: base.nowMs - SPEND_GUARD_IDLE_TTL_MS, snoozedUntilMs: base.nowMs - 1 }), "below-thresholds");
  assert.equal(evaluateAutomationSpendGuard({ ...base, lastViewedAtMs: base.nowMs - SPEND_GUARD_IDLE_TTL_MS, snoozedUntilMs: base.nowMs }), "below-thresholds");
  assert.equal(evaluateAutomationSpendGuard({ ...base, lastViewedAtMs: base.nowMs - SPEND_GUARD_IDLE_TTL_MS, nudgedAtMs: base.nowMs - 1_000 }), "awaiting-ack");
  assert.equal(evaluateAutomationSpendGuard({ ...base, lastViewedAtMs: base.nowMs - SPEND_GUARD_IDLE_TTL_MS - 1_000, nudgedAtMs: base.nowMs - SPEND_GUARD_PAUSE_DELAY_MS }), "pause");
  assert.equal(evaluateAutomationSpendGuard({ ...base, lastViewedAtMs: base.nowMs - SPEND_GUARD_IDLE_TTL_MS - 1_000, nudgedAtMs: base.nowMs - SPEND_GUARD_PAUSE_DELAY_MS - 1 }), "pause");
  assert.equal(evaluateAutomationSpendGuard({ ...base, lastViewedAtMs: base.nowMs - SPEND_GUARD_IDLE_TTL_MS, unreadCount: 15 }), "nudge");
  assert.equal(evaluateAutomationSpendGuard({ ...base, lastViewedAtMs: base.nowMs - SPEND_GUARD_IDLE_TTL_MS, unreadCount: 14 }), "below-thresholds");
  assert.equal(evaluateAutomationSpendGuard({ ...base, lastViewedAtMs: base.nowMs - SPEND_GUARD_IDLE_TTL_MS, firesSinceViewedCount: 20 }), "nudge");
  assert.equal(evaluateAutomationSpendGuard({ ...base, lastViewedAtMs: base.nowMs - SPEND_GUARD_IDLE_TTL_MS, firesSinceViewedCount: 19 }), "below-thresholds");
  assert.equal(evaluateAutomationSpendGuard({ ...base, lastViewedAtMs: base.nowMs - SPEND_GUARD_IDLE_TTL_MS, nudgedAtMs: base.nowMs - SPEND_GUARD_IDLE_TTL_MS, unreadCount: 14 }), "below-thresholds");
});

test("runs are counted only when they started strictly after the cutoff", () => {
  assert.equal(countAutomationRunsSince([], 0), 0);
  assert.equal(countAutomationRunsSince([{ runs: [{ startedAt: 5 }, { startedAt: 10 }, { startedAt: 10 }] }, { runs: [{ startedAt: 11 }] }], 10), 1);
  assert.equal(countAutomationRunsSince([{ runs: [{ startedAt: 0 }, { startedAt: -1 }] }], 0), 0);
  assert.equal(countAutomationRunsSince([{ runs: [] }, { runs: [{ startedAt: 100 }] }], 99), 1);
});

test("the two widgets carry the exact prompts, options and styles", () => {
  assert.deepEqual(buildSpendGuardNudgeWidget(), {
    prompt: "You've been away for a bit — keep my routines running?",
    options: [
      { label: "Keep them running", value: "spend-guard:keep", style: "primary" },
      { label: "Pause them all", value: "spend-guard:pause" },
      { label: "Keep running, don't ask again", value: "spend-guard:never-ask" },
    ],
  });
  assert.deepEqual(buildSpendGuardPausedWidget(), {
    prompt: "I paused all your routines while you were away to avoid wasted spend. Want me to start them back up?",
    options: [
      { label: "Resume routines", value: "spend-guard:resume", style: "primary" },
      { label: "Keep them paused", value: "spend-guard:stay-paused" },
    ],
  });
  assert.deepEqual(Object.keys(SPEND_GUARD_ANSWER_ACKS).sort(), ["keep", "optOut", "pause", "resume", "stayPaused"]);
});

test("an answer acknowledgement names the choice and forbids asking again", () => {
  assert.equal(SPEND_GUARD_ANSWER_ACKS.keep, "keep your routines running, and not to be asked again for a month");
  assert.equal(SPEND_GUARD_ANSWER_ACKS.resume, "start the paused routines back up");
  assert.equal(SPEND_GUARD_ANSWER_ACKS.optOut, "keep your routines running and never be asked about this again");
  assert.equal(SPEND_GUARD_ANSWER_ACKS.pause, "pause every one of your routines");
  assert.equal(SPEND_GUARD_ANSWER_ACKS.stayPaused, "leave your routines paused");
  const rendered = renderSpendGuardAnswerAck("pause");
  const lines = rendered.split("\n");
  assert.equal(lines[0], "<system_reminder>");
  assert.match(lines[1]!, /They chose to pause every one of your routines, and the app has ALREADY applied that itself\./);
  assert.equal(lines[2], "Acknowledge their choice in one short line. Do NOT edit any automation.json and do NOT ask again.");
  assert.equal(lines[3], "</system_reminder>");
});

test("a guard card is recognised only by its prompt and one of its option values", () => {
  assert.equal(isSpendGuardCard(buildSpendGuardNudgeWidget(), "spend-guard:keep"), true);
  assert.equal(isSpendGuardCard(buildSpendGuardNudgeWidget(), "spend-guard:pause"), true);
  assert.equal(isSpendGuardCard(buildSpendGuardNudgeWidget(), "spend-guard:resume"), false);
  assert.equal(isSpendGuardCard(buildSpendGuardNudgeWidget(), ""), false);
  assert.equal(isSpendGuardCard({ prompt: "other", options: [{ label: "x", value: "spend-guard:keep" }] }, "spend-guard:keep"), false);
  assert.equal(isSpendGuardCard({ prompt: buildSpendGuardNudgeWidget().prompt, options: [{ label: "x", value: "nope" }] }, "spend-guard:keep"), false);
});

test("the nudge reminder names the absence, the thresholds and the deadline", () => {
  const seen = renderSpendGuardNudgeReminder({ nowMs: 1_700_000_000_000, lastViewedAtMs: 1_600_000_000_000, unreadCount: 16, firesSinceViewedCount: 21, timeZone: "UTC" });
  assert.match(seen, /^<system_reminder>/);
  assert.match(seen, /The user hasn't opened this chat since .+ — 16 of your messages are unread and your routines have run 21 times since then\. They may be spending money on work nobody is reading\./);
  assert.match(seen, /If they neither answer nor return by .+, the app will pause ALL of this agent's routines and tell them so\./);
  assert.equal(seen.split("\n").at(-1), "</system_reminder>");
  assert.equal(seen.split("\n")[2], "The app has already asked them directly whether to keep your routines running, and applies their answer itself. Do NOT ask again yourself and do NOT edit any automation.json; just acknowledge their choice if it comes back as their reply.");
  const never = renderSpendGuardNudgeReminder({ nowMs: 1_700_000_000_000, lastViewedAtMs: 0, unreadCount: 15, firesSinceViewedCount: 20, timeZone: "UTC" });
  assert.match(never, /The user has never opened this chat — 15 of your messages are unread/);
});
