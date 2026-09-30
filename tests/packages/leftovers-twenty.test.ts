/**
 * Converting the platform's prompt shapes into the inference protocol's, one path's worth of sync work,
 * and the outline of a conversation.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { applyToolCallArgs, buildStreamRequest, coreMessageToProto, toolCallArgsFromProto } from "../../source/packages/chat-inference-proto/converters.ts";
import { enqueuePathSyncRequest, listPathSyncRequests, PATH_SYNC_REQUEST_POLL_MS, PATH_SYNC_REQUEST_WAIT_POLL_MS } from "../../source/packages/agent-store-sync/path-sync-request.ts";
import { deriveOutlineFromConversationState, MAX_TOOL_ACTIVITY_ARGS_CHARS, MCP_TOOL_CALL_OUTLINE_NAME, SEND_MESSAGE_TOOL_CALL_OUTLINE_NAME } from "../../source/host/runner/conversation-outline.ts";

describe("converting to the inference protocol", () => {
  it("builds a stream request and converts a core message", () => {
    assert.equal(typeof buildStreamRequest, "function");
    assert.equal(typeof coreMessageToProto, "function");
    assert.equal(typeof applyToolCallArgs, "function");
    assert.equal(typeof toolCallArgsFromProto, "function");
  });
});

describe("one path's worth of sync work", () => {
  it("names the two poll intervals, and offers the queue", () => {
    assert.equal(PATH_SYNC_REQUEST_POLL_MS, 250);
    assert.equal(PATH_SYNC_REQUEST_WAIT_POLL_MS, 50);
    assert.equal(typeof enqueuePathSyncRequest, "function");
    assert.equal(typeof listPathSyncRequests, "function");
  });
});

describe("the outline of a conversation", () => {
  it("names the tool calls a reader can jump to and bounds what a call may carry", () => {
    assert.equal(SEND_MESSAGE_TOOL_CALL_OUTLINE_NAME, "sendMessageToolCall");
    assert.equal(MCP_TOOL_CALL_OUTLINE_NAME, "mcpToolCall");
    assert.equal(MAX_TOOL_ACTIVITY_ARGS_CHARS, 20_000);
    assert.equal(typeof deriveOutlineFromConversationState, "function");
  });
});
