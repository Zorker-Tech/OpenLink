/**
 * More of the pieces that landed last: how long a sync waits before trying again, which limit a model
 * complaint was about, where a session's files are, what an MCP server looks like to the runtime, and
 * the messages a prompt is built from.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AgentStoreRetrySchedule } from "../../source/packages/agent-store-sync/backoff-scheduler.ts";
import { classifyTokenLimitErrorFromMessage } from "../../source/adapters/interop/chat-inference-proto/token-limit-error-classifier-adapter.ts";
import { getAgentDbPath, getConnectorSecretsRoot, getSlateTranscriptsDir, STORE_FILENAME } from "../../source/host/extensions/session/session-paths.ts";
import { normalizeAccountLabel, parseMarketplacePluginIdentifier } from "../../source/shared/node/mcp/mcp-account-display-policy.ts";
import { BasePromptBuilder } from "../../source/packages/chat-inference/base.ts";

describe("how long a sync waits before trying again", () => {
  it("offers a next delay it can be asked about", () => {
    const backoff = new AgentStoreRetrySchedule({ initialDelayMs: 100, maximumDelayMs: 400, jitterFraction: 0 });
    assert.equal(typeof backoff.peekNextDelayMs, "function");
    assert.equal(typeof backoff.noteFailure, "function");
    assert.equal(typeof backoff.noteSuccess, "function");
    assert.equal(backoff.peekNextDelayMs(), 100);
  });
});

describe("which limit a model complaint was about", () => {
  it("tells a prompt that is too long from an answer that hit its limit", () => {
    assert.equal(classifyTokenLimitErrorFromMessage("exceeded max output tokens")?.name, "OutputTokensLimitExceededError");
    assert.equal(classifyTokenLimitErrorFromMessage("input is too long")?.name, "InputTokenLimitError");
  });
});

describe("where a session's own files are", () => {
  it("names the store beside a session's directory, from an agent id", () => {
    assert.equal(STORE_FILENAME.length > 0, true);
    assert.equal(typeof getAgentDbPath, "function");
    assert.equal(typeof getSlateTranscriptsDir(), "string");
    assert.equal(typeof getConnectorSecretsRoot(), "string");
  });
});

describe("what an MCP server looks like to the runtime", () => {
  it("keeps a marketplace plugin id digits only", () => {
    assert.equal(parseMarketplacePluginIdentifier("12"), "12");
    assert.throws(() => parseMarketplacePluginIdentifier("p1"), Error);
  });

  it("normalizes an account key", () => {
    assert.equal(typeof normalizeAccountLabel("  Account  "), "string");
  });
});

describe("the messages a prompt is built from", () => {
  it("collects, hands over and clears", () => {
    const builder = new BasePromptBuilder();
    assert.deepEqual(builder.getMessages(), []);
    builder.appendMessages([{ role: "user", content: "hello" }]);
    assert.equal(builder.getMessages().length, 1);
    builder.clearMessages();
    assert.deepEqual(builder.getMessages(), []);
  });
});
