/**
 * The host's loop and stream edges: how busy the event loop is, what makes a stream error worth retrying, the
 * roster bookkeeping, and the auto-review classifier's run.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { EVENT_LOOP_RESOLUTION_MS, HEARTBEAT_EVERY_N_WINDOWS, PRESSURE_P95_MS, WINDOW_MS } from "../../source/host/telemetry/event-loop-telemetry.ts";
import { TRANSIENT_ERRNO_CODES, TRANSIENT_MESSAGE_TOKENS, isTransientStreamError } from "../../source/host/runner/transient-stream-error.ts";
import { SLATE_AUTO_REVIEW_BLOCK_REASON, SLATE_AUTO_REVIEW_CLASSIFIER_MAX_ATTEMPTS } from "../../source/host/runner/slate-auto-review-classifier-run.ts";

describe("how busy the host's event loop is", () => {
  it("samples over a window, reports pressure, and otherwise just says so now and then", () => {
    assert.equal(EVENT_LOOP_RESOLUTION_MS, 20);
    assert.equal(WINDOW_MS, 60_000);
    assert.equal(PRESSURE_P95_MS, 50);
    assert.equal(HEARTBEAT_EVERY_N_WINDOWS, 5);
  });
});

describe("what makes a stream error worth retrying", () => {
  it("knows the connection errnos and the messages that name them", () => {
    assert.equal(TRANSIENT_ERRNO_CODES.has("ECONNRESET"), true);
    assert.equal(TRANSIENT_ERRNO_CODES.has("ENOTFOUND"), false);
    assert.equal(TRANSIENT_MESSAGE_TOKENS.includes("econnreset"), true);
    assert.equal(isTransientStreamError(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })), true);
    assert.equal(isTransientStreamError(new Error("connection reset by peer")), true);
    assert.equal(isTransientStreamError(new Error("model refused the request")), false);
  });
});

describe("the classifier that decides whether a change needs a review", () => {
  it("bounds how long it may take", () => {
    assert.equal(SLATE_AUTO_REVIEW_CLASSIFIER_MAX_ATTEMPTS > 0, true);
    assert.equal(SLATE_AUTO_REVIEW_BLOCK_REASON.length > 0, true);
  });
});
