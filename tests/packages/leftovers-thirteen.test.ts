/**
 * The runner's stream attempts and system prompts, the MCP meta tools and the reminder an agent gets at
 * the start of a turn.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createStreamAttempt } from "../../source/host/runner/stream-attempt.ts";
import { DEFAULT_SLATE_SYSTEM_PROMPT, USER_MESSAGE_REPLY_REMINDER } from "../../source/host/runner/system-prompt.ts";
import { SlateToolCallExecutionTimeoutError, slateToolCallExecutionTimeoutMs } from "../../source/host/runner/tools/mcp-meta-tools.ts";
import { DEFAULT_START_OF_TURN_ACK_THRESHOLD, START_OF_TURN_ACK_REMINDER_MESSAGE } from "../../source/host/runner/start-of-turn-ack-reminder-middleware.ts";

describe("one attempt at a streamed turn", () => {
  it("is created rather than imported for effect", () => {
    assert.equal(typeof createStreamAttempt, "function");
  });
});

describe("the system prompt the runner gives a model", () => {
  it("says who the model is, with our own name", () => {
    assert.match(DEFAULT_SLATE_SYSTEM_PROMPT, /^You are Slate, /);
    assert.equal(DEFAULT_SLATE_SYSTEM_PROMPT.includes("Grok"), false);
    assert.equal(USER_MESSAGE_REPLY_REMINDER.startsWith("<system_reminder>"), true);
  });
});

describe("the MCP meta tools", () => {
  it("names the error a tool call that ran too long raises", () => {
    assert.equal(typeof slateToolCallExecutionTimeoutMs, "function");
    assert.equal(typeof SlateToolCallExecutionTimeoutError, "function");
  });
});

describe("the reminder an agent gets at the start of a turn", () => {
  it("waits for a call before reminding, and marks the reminder as hidden", () => {
    assert.equal(DEFAULT_START_OF_TURN_ACK_THRESHOLD, 1);
    assert.equal(START_OF_TURN_ACK_REMINDER_MESSAGE.startsWith("<system_reminder>"), true);
    assert.match(START_OF_TURN_ACK_REMINDER_MESSAGE, /opened this turn/);
  });
});
