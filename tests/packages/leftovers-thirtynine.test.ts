/**
 * The crash reporter, the session as a production host assembles it, and the tool an agent drives a
 * computer with.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MAX_SPOOL_PURGE_SHIFTS, SENTRY_EVENT_ID_PATTERN, SLATE_SENTRY_CONVERSATION_TAG, SLATE_SENTRY_DSN, SlateSentryAccountPrivacySync } from "../../source/shared/observability/sentry.ts";
import { createSessionProductionExtras } from "../../source/host/extensions/session/production.ts";
import { COMPUTER_ACTIONS, MOUSE_BUTTONS, SCROLL_DIRECTIONS, SLATE_COMPUTER_MAX_FOLLOW_UP_ACTIONS, SLATE_COMPUTER_MAX_WAIT_MS } from "../../source/host/runner/tools/slate-computer-tool.ts";

describe("the crash reporter", () => {
  it("reports under our own address and tag, and bounds what it spools", () => {
    // No reporting address of ours is carried: the reporter stays off until one is given.
    assert.equal(SLATE_SENTRY_DSN, "");
    assert.equal(SLATE_SENTRY_CONVERSATION_TAG, "slate.conversation_id");
    assert.equal(MAX_SPOOL_PURGE_SHIFTS, 64);
    assert.equal(SENTRY_EVENT_ID_PATTERN.test("abc123"), false);
    assert.equal(typeof SlateSentryAccountPrivacySync, "function");
  });
});

describe("the session as a production host assembles it", () => {
  it("brings its stores, transcript and maintenance together in one place", () => {
    assert.equal(typeof createSessionProductionExtras, "function");
  });
});

describe("the tool an agent drives a computer with", () => {
  it("names the actions, the buttons and the directions it accepts, and bounds a follow-up", () => {
    assert.equal(COMPUTER_ACTIONS.length, 8);
    assert.deepEqual(MOUSE_BUTTONS, { left: "LEFT", right: "RIGHT", middle: "MIDDLE" });
    assert.deepEqual(SCROLL_DIRECTIONS, { up: "UP", down: "DOWN", left: "LEFT", right: "RIGHT" });
    assert.equal(SLATE_COMPUTER_MAX_FOLLOW_UP_ACTIONS, 9);
    assert.equal(SLATE_COMPUTER_MAX_WAIT_MS, 30_000);
  });
});
