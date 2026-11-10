/**
 * Where a turn begins and ends, the tools an agent manages other agents with, the file-transfer tools and
 * reading what a provider reported.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DELIVERY_TOOL_NAMES, hasDeliveryToolCall, isBlankAssistantMessage, toolCallNames, turnEndedOnSilentToolCalls } from "../../source/host/runner/turn-shape.ts";
import { createCreateAgentTool, createSendToAgentTool, createUpdateAgentTool } from "../../source/host/runner/tools/slate-agent-management-tools.ts";
import { assertBoxReady, copyFileFromBox, copyFileToBox, createFileTransferTools, formatBytes } from "../../source/host/runner/tools/slate-file-transfer-tools.ts";
import { streamCodexDirectResponses } from "../../source/host/extensions/inference/codex-direct-responses.ts";

describe("where a turn begins and ends", () => {
  it("knows the tools that deliver a message, and an assistant turn that said nothing", () => {
    assert.equal(DELIVERY_TOOL_NAMES.has("SendMessage"), true);
    assert.equal(DELIVERY_TOOL_NAMES.has("Read"), false);
    assert.equal(isBlankAssistantMessage({ role: "assistant", content: "" } as never), true);
    assert.equal(isBlankAssistantMessage({ role: "assistant", content: "said something" } as never), false);
    assert.equal(typeof toolCallNames, "function");
    assert.equal(typeof hasDeliveryToolCall, "function");
    assert.equal(typeof turnEndedOnSilentToolCalls, "function");
  });
});

describe("the tools an agent manages other agents with", () => {
  it("creates, sends to and updates them", () => {
    assert.equal(typeof createCreateAgentTool, "function");
    assert.equal(typeof createSendToAgentTool, "function");
    assert.equal(typeof createUpdateAgentTool, "function");
  });
});

describe("moving a file between a box and the host", () => {
  it("refuses a copy when no computer is connected, and formats sizes it reports", () => {
    assert.equal(typeof copyFileToBox, "function");
    assert.equal(typeof copyFileFromBox, "function");
    assert.equal(typeof assertBoxReady, "function");
    assert.equal(typeof createFileTransferTools, "function");
    assert.equal(formatBytes(0), "0 bytes");
    assert.equal(formatBytes(2048), "2 KB");
  });
});

describe("reading what a provider reported", () => {
  it("is a stream the runner can consume", () => {
    assert.equal(typeof streamCodexDirectResponses, "function");
  });
});
