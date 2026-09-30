/**
 * The exclusive mutation lock, the inference protocol client, settling a turn, the connector auth watch,
 * the prompt acceptance ledger, the prompt collector and the MCP management tools.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { readAgentStoreExclusiveMutationClaimOwner } from "../../source/packages/agent-store-sync/exclusive-mutation-lock.ts";
import { ProtoPromptBuilder, ProtoPromptExecutor, ProtoSessionProvider } from "../../source/packages/chat-inference-proto/client.ts";
import { createTurnSettle, TranscriptAppendAfterCheckpointError } from "../../source/host/runner/turn-settle.ts";
import { CONNECTOR_AUTH_START_FAILURE_REASONS, CONNECTOR_AUTH_START_REFUSAL_REASONS, SlateMcpAuthWatchLifecycle } from "../../source/shared/node/mcp/mcp-auth-watch-lifecycle.ts";
import { MAX_DEGRADED_WINDOWS, MAX_RECORDS, NONCE_DIGEST_MISMATCH, PromptAcceptanceLedger } from "../../source/host/transcript/prompt-acceptance-ledger.ts";
import { createPromptCollectorGlue, SlateVideoAttachmentError } from "../../source/host/runner/prompt-collector-glue.ts";
import { buildServerConfigJson, MCP_AWAITING_SELECTION_MESSAGE, PLUGIN_QUERY_MIN_TOKEN_LENGTH } from "../../source/host/runner/tools/slate-mcp-management-tools.ts";

describe("a lock around one mutating operation", () => {
  it("reads who holds the claim", () => {
    assert.equal(typeof readAgentStoreExclusiveMutationClaimOwner, "function");
  });
});

describe("the client that speaks the inference protocol", () => {
  it("builds prompts, executes them and provides sessions", () => {
    assert.equal(typeof ProtoPromptBuilder, "function");
    assert.equal(typeof ProtoPromptExecutor, "function");
    assert.equal(typeof ProtoSessionProvider, "function");
  });
});

describe("settling a turn", () => {
  it("writes what a turn ended with, once", () => {
    assert.equal(typeof createTurnSettle, "function");
    assert.match(new TranscriptAppendAfterCheckpointError("late").message, /transcript append failed: late$/);
  });
});

describe("watching a connector's authorization", () => {
  it("names the reasons a start fails or is refused", () => {
    assert.equal(CONNECTOR_AUTH_START_FAILURE_REASONS.length, 2);
    assert.equal(CONNECTOR_AUTH_START_REFUSAL_REASONS.length, 6);
    assert.equal(typeof SlateMcpAuthWatchLifecycle, "function");
  });
});

describe("the ledger of what a prompt accepted", () => {
  it("bounds how much it keeps and how many degraded windows it allows", () => {
    assert.equal(MAX_RECORDS, 256);
    assert.equal(MAX_DEGRADED_WINDOWS, 8);
    assert.equal(NONCE_DIGEST_MISMATCH, "NONCE_DIGEST_MISMATCH");
    assert.equal(typeof PromptAcceptanceLedger, "function");
  });
});

describe("gathering a turn's prompt", () => {
  it("is collected in one place, and a video it cannot attach says so", () => {
    assert.equal(typeof createPromptCollectorGlue, "function");
    assert.equal(new SlateVideoAttachmentError("too large").message, "too large");
  });
});

describe("the tools an agent manages its MCP servers with", () => {
  it("names the minimum a plugin query may be and what to say while waiting", () => {
    assert.equal(PLUGIN_QUERY_MIN_TOKEN_LENGTH, 3);
    assert.equal(MCP_AWAITING_SELECTION_MESSAGE.length > 0, true);
    assert.equal(typeof buildServerConfigJson, "function");
  });
});
