/**
 * The reaction tool, the file mirror, the auto-review service, the box-help tool and the subagent
 * management tools.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createReactToMessageTool, SLATE_REACT_TO_MESSAGE_TOOL_NAME } from "../../source/host/runner/tools/slate-reaction-tool.ts";
import { FileTranscriptMirror } from "../../source/host/transcript/mirror/transcript-mirror.ts";
import { AutoReviewService, parseLocalAutoReviewMode, SETTLED_APPROVAL_MEMORY } from "../../source/host/extensions/auto-review/auto-review-service.ts";
import { createRequestBoxHelpTool, normalizeBoxHelpDomain } from "../../source/host/runner/tools/box-help-tool.ts";
import { createSubagentManagementTools, elapsedLabel } from "../../source/host/runner/tools/slate-subagent-management-tools.ts";

describe("the tool an agent reacts with", () => {
  it("is named after what it does, and is created from its spec", () => {
    assert.equal(SLATE_REACT_TO_MESSAGE_TOOL_NAME, "ReactToMessage");
    assert.equal(typeof createReactToMessageTool, "function");
  });
});

describe("the mirror a transcript is written through", () => {
  it("is a file mirror the host can build", () => {
    assert.equal(typeof FileTranscriptMirror, "function");
  });
});

describe("the service that decides whether a change needs a review", () => {
  it("reads a local mode, and forgets a settled approval", () => {
    assert.equal(parseLocalAutoReviewMode("off"), "off");
    assert.equal(parseLocalAutoReviewMode("nonsense"), undefined);
    assert.equal(typeof AutoReviewService, "function");
    assert.equal(SETTLED_APPROVAL_MEMORY > 0, true);
  });
});

describe("the tool a box's agent asks its host for help with", () => {
  it("normalizes what it was asked about, taking a host out of a URL", () => {
    assert.equal(normalizeBoxHelpDomain("  https://example.com/x  "), "example.com");
    assert.equal(normalizeBoxHelpDomain("example.com"), "example.com");
    assert.equal(typeof createRequestBoxHelpTool, "function");
  });
});

describe("the tools an agent manages its subagents with", () => {
  it("says how long one has been running", () => {
    assert.equal(elapsedLabel(65_000), "65s");
    assert.equal(typeof createSubagentManagementTools, "function");
  });
});
