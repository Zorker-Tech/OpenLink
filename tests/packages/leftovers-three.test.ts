/**
 * The session store's own pieces and the chat-inference middlewares: size limits, the session roster,
 * where a conversation's blobs live, what a server may be called, and the two middlewares that tidy a
 * prompt before it is sent.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { conversationHardLimitBytes, conversationSoftLimitBytes, blobDbPathFor, HARD_LIMIT_DEFAULT_BYTES, SOFT_LIMIT_DEFAULT_BYTES, SlateConversationTooLargeError } from "../../source/host/extensions/session/conversation-size-limits.ts";
import { listAgents, summarizeAgentById } from "../../source/host/extensions/session/session-roster.ts";
import { conversationBlobsPath } from "../../source/host/extensions/session/conversation-blobs-path.ts";
import { validateServerName } from "../../source/shared/node/mcp/mcp-validation.ts";
import { isEmptyAssistantMessage, trailingEmptyAssistantRemovalMiddleware } from "../../source/packages/chat-inference/middleware/trailing-empty-assistant-removal-middleware.ts";
import { CONTINUATION_MESSAGE, needsContinuationMessage } from "../../source/packages/chat-inference/middleware/continuation-injector-middleware.ts";

describe("how large a conversation may get", () => {
  it("has a soft limit below its hard one, both of them named here", () => {
    assert.equal(HARD_LIMIT_DEFAULT_BYTES > SOFT_LIMIT_DEFAULT_BYTES, true);
    assert.equal(conversationHardLimitBytes() >= conversationSoftLimitBytes(), true);
    assert.equal(typeof blobDbPathFor, "function");
    // The error writes its own message from the sizes it was built with.
    const error = new SlateConversationTooLargeError(2_000, 1_000);
    assert.equal(error instanceof Error, true);
    assert.match(error.message, /over the .* limit/);
  });
});

describe("the sessions this host knows about", () => {
  it("offers a listing and a summary, and says what a session is by its id", () => {
    assert.equal(typeof listAgents, "function");
    assert.equal(typeof summarizeAgentById, "function");
  });

  it("builds a conversation's blob path beside its store", () => {
    assert.equal(typeof conversationBlobsPath, "function");
  });
});

describe("what a server may be called", () => {
  it("refuses a name that would reach into the object it is stored in", () => {
    assert.throws(() => validateServerName("__proto__"), Error);
    assert.throws(() => validateServerName("constructor"), Error);
    assert.equal(typeof validateServerName("linear"), "string");
  });
});

describe("tidying a prompt before it is sent", () => {
  it("knows an assistant turn that said nothing", () => {
    assert.equal(isEmptyAssistantMessage({ role: "assistant", content: "" } as never), true);
    assert.equal(isEmptyAssistantMessage({ role: "assistant", content: "an answer" } as never), false);
    assert.equal(isEmptyAssistantMessage({ role: "user", content: "" } as never), false);
    assert.equal(typeof trailingEmptyAssistantRemovalMiddleware, "function");
  });

  it("knows when a turn has to be continued rather than restarted", () => {
    assert.equal(CONTINUATION_MESSAGE.length > 0, true);
    assert.equal(typeof needsContinuationMessage, "function");
  });
});
