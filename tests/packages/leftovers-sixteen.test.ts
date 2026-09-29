/**
 * An agent awaiting a review, the gate a reviewed turn waits at, the tool an agent speaks with, the errors
 * a reader is shown and the router that picks a transcript's mirror.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildSlateAutoReviewAwaitingReason, SLATE_AUTO_REVIEW_AWAITING_TAB_ID } from "../../source/host/extensions/auto-review/slate-auto-review-awaiting.ts";
import { createAutoReviewGate, SlateAutoReviewPendingApprovalError } from "../../source/host/runner/auto-review-gate.ts";
import { defineCommunicateTool, SLATE_TOOL_MARKER } from "../../source/host/runner/tools/communicate-tool.ts";
import { MAX_TRAY_ACTIONS, PROVIDER_OVERLOAD_ERROR_TITLE, SLATE_WEBSITE_ORIGIN } from "../../source/host/transcript/agent-run-error.ts";
import { RoutedTranscriptMirror } from "../../source/host/transcript/mirror/transcript-mirror-router.ts";

describe("an agent whose review is waiting", () => {
  it("is shown in the tab the platform keeps for it", () => {
    assert.equal(SLATE_AUTO_REVIEW_AWAITING_TAB_ID, "auto-review");
    assert.equal(typeof buildSlateAutoReviewAwaitingReason, "function");
  });
});

describe("the gate a reviewed turn waits at", () => {
  it("names the error a pending approval raises", () => {
    assert.equal(typeof createAutoReviewGate, "function");
    assert.equal(typeof SlateAutoReviewPendingApprovalError, "function");
  });
});

describe("the tool an agent speaks with", () => {
  it("is defined rather than imported for effect, and marks its own calls", () => {
    assert.equal(typeof defineCommunicateTool, "function");
    assert.equal(typeof SLATE_TOOL_MARKER, "string");
  });
});

describe("the errors a reader is shown", () => {
  it("names an overloaded provider, bounds the tray actions and points at our own site", () => {
    assert.equal(PROVIDER_OVERLOAD_ERROR_TITLE, "Model provider is overloaded");
    assert.equal(MAX_TRAY_ACTIONS, 3);
    assert.equal(SLATE_WEBSITE_ORIGIN, "https://slate.invalid");
    assert.equal(SLATE_WEBSITE_ORIGIN.includes("cursor"), false);
  });
});

describe("which mirror a transcript is written through", () => {
  it("is a router the host can build", () => {
    assert.equal(typeof RoutedTranscriptMirror, "function");
  });
});
