/**
 * The security-key proxy entry, tool escalations, the computer and shell reviews, the agent session, the
 * state tool and the connector authorization's loopback server.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { webauthnProxyExtension } from "../../source/host/extensions/webauthn-proxy/extension.ts";
import { createSlateMcpApprovalProvider, createSlateShellApprovalProvider } from "../../source/host/runner/slate-auto-review-tool-escalations.ts";
import { SLATE_COMPUTER_AUTO_REVIEW_BYPASS_ACTIONS, SLATE_COMPUTER_AUTO_REVIEW_CLASSIFIER_ERROR_REASON } from "../../source/host/runner/slate-computer-auto-review.ts";
import { resolveProfileName, SlateAgentSessionStore } from "../../source/host/extensions/session/agent-session.ts";
import { SLATE_SHELL_APPROVAL_HASH_CHUNK_LINES, SLATE_SHELL_APPROVAL_HASH_MAX_LINES, SLATE_SHELL_APPROVAL_PARSE_MAX_CHARS } from "../../source/host/runner/slate-shell-auto-review-enrichment.ts";
import { ACTIONS, OPERATIONS, SLATE_UPDATE_STATE_TOOL_NAME, TARGETS } from "../../source/host/runner/tools/slate-state-tool.ts";
import { CONNECTOR_OAUTH_CALLBACK_FAILURE_REASONS, MCP_OAUTH_LOOPBACK_CALLBACK_URL } from "../../source/shared/node/mcp/mcp-oauth-loopback.ts";

describe("the security-key proxy entry", () => {
  it("is an extension the host starts", () => {
    assert.equal(typeof webauthnProxyExtension, "object");
  });
});

describe("asking a user about what a review would not decide", () => {
  it("offers a provider per kind of call", () => {
    assert.equal(typeof createSlateMcpApprovalProvider, "function");
    assert.equal(typeof createSlateShellApprovalProvider, "function");
  });
});

describe("reviewing what an agent did on the desktop", () => {
  it("names the actions it does not review and the reason a classifier failed", () => {
    assert.equal(Array.isArray(SLATE_COMPUTER_AUTO_REVIEW_BYPASS_ACTIONS), true);
    assert.equal(SLATE_COMPUTER_AUTO_REVIEW_CLASSIFIER_ERROR_REASON.length > 0, true);
  });
});

describe("a session, as the host holds it", () => {
  it("owns its database and transcript, and knows the name to show", () => {
    assert.equal(typeof SlateAgentSessionStore, "function");
    assert.equal(typeof resolveProfileName, "function");
    // A name that says nothing falls back to the one the platform uses for a new agent.
    assert.equal(resolveProfileName("Ada", null), "Ada");
    assert.equal(resolveProfileName("", { name: "  " }), "New Bot");
  });
});

describe("adding what a shell review needs", () => {
  it("bounds how much of a command it hashes and parses", () => {
    assert.equal(SLATE_SHELL_APPROVAL_HASH_MAX_LINES, 20_000);
    assert.equal(SLATE_SHELL_APPROVAL_HASH_CHUNK_LINES, 50);
    assert.equal(SLATE_SHELL_APPROVAL_PARSE_MAX_CHARS, 1_000_000);
  });
});

describe("the tool that reads the host's own state", () => {
  it("names what it can target, and what it can do to it", () => {
    assert.equal(SLATE_UPDATE_STATE_TOOL_NAME, "update_state");
    assert.equal(TARGETS.length, 8);
    assert.equal(ACTIONS.length, 12);
    assert.equal(Object.keys(OPERATIONS).length > 0, true);
  });
});

describe("the connector authorization's loopback server", () => {
  it("names the address it answers on and the reasons a callback fails", () => {
    assert.equal(MCP_OAUTH_LOOPBACK_CALLBACK_URL, "http://localhost:8787/callback");
    assert.equal(CONNECTOR_OAUTH_CALLBACK_FAILURE_REASONS.length, 4);
  });
});
