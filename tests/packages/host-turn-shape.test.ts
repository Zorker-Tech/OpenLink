import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DELIVERY_TOOL_NAMES,
  asCoreMessage,
  hasDeliveryToolCall,
  isBlankAssistantMessage,
  toolCallNames,
  turnEndedOnSilentToolCalls,
} from "../../source/host/runner/turn-shape.ts";
import { SLATE_REACT_TO_MESSAGE_TOOL_NAME } from "../../source/host/runner/tools/slate-reaction-tool.ts";
import { SLATE_SEND_MESSAGE_TOOL_NAME } from "../../source/host/runner/tools/send-message-tool.ts";

const assistant = (...parts: any[]) => ({ role: "assistant", content: parts });
const call = (toolName: string, toolCallId: string) => ({ type: "tool-call", toolName, toolCallId });
const text = (value: string) => ({ type: "text", text: value });
const user = (value: string) => ({ role: "user", content: value });
const toolResult = (toolCallId: string, isError = false) => ({
  role: "tool",
  content: [{ type: "tool-result", toolCallId }],
  providerOptions: { slate: { highLevelToolCallResult: { isError } } },
});
const reminder = () => ({ role: "assistant", content: [text("")], providerOptions: { slate: { slateStartOfTurnAckReminder: true } } });

describe("reading transcript messages", () => {
  it("accepts only objects with a role and content", () => {
    assert.equal(asCoreMessage(null), undefined);
    assert.equal(asCoreMessage("x"), undefined);
    assert.equal(asCoreMessage({}), undefined);
    assert.equal(asCoreMessage({ role: 1, content: "x" }), undefined);
    assert.equal(asCoreMessage({ role: "user" }), undefined);
    assert.deepEqual(asCoreMessage({ role: "user", content: "hi" }), { role: "user", content: "hi" });
    assert.equal(asCoreMessage({ role: "user", content: [] }) !== undefined, true);
  });

  it("lists the tool calls an assistant message made", () => {
    assert.deepEqual(toolCallNames(assistant(call("Shell", "c1"), text("x"), call("Read", "c2"), { type: "tool-call" })), ["Shell", "Read"]);
    assert.deepEqual(toolCallNames({ role: "user", content: "x" } as never), []);
    assert.deepEqual(toolCallNames({ role: "assistant", content: "x" } as never), []);
    assert.equal(hasDeliveryToolCall([SLATE_SEND_MESSAGE_TOOL_NAME]), true);
    assert.equal(hasDeliveryToolCall([SLATE_REACT_TO_MESSAGE_TOOL_NAME]), true);
    assert.equal(hasDeliveryToolCall(["Shell"]), false);
    assert.equal(DELIVERY_TOOL_NAMES.size, 2);
  });

  it("recognizes a blank assistant message", () => {
    assert.equal(isBlankAssistantMessage({ role: "user", content: "" } as never), false);
    assert.equal(isBlankAssistantMessage({ role: "assistant", content: "   " } as never), true);
    assert.equal(isBlankAssistantMessage({ role: "assistant", content: "hi" } as never), false);
    assert.equal(isBlankAssistantMessage(assistant(text(" "), { type: "text" })), true);
    assert.equal(isBlankAssistantMessage(assistant(text("hi"))), false);
    assert.equal(isBlankAssistantMessage(assistant(text(" "), text("hi"))), false);
    assert.equal(isBlankAssistantMessage(assistant(call("Shell", "c1"))), false);
  });
});

describe("detecting a turn that ended on silent tool calls", () => {
  it("needs an assistant tail with non-delivery tool calls", () => {
    assert.equal(turnEndedOnSilentToolCalls([]), false);
    assert.equal(turnEndedOnSilentToolCalls([user("hi")]), false);
    assert.equal(turnEndedOnSilentToolCalls([user("hi"), assistant(call("Shell", "c1"))]), false);
    assert.equal(turnEndedOnSilentToolCalls([user("hi"), assistant(call(SLATE_SEND_MESSAGE_TOOL_NAME, "c1"))]), false);
  });

  it("accepts a turn that acknowledged before the silent calls", () => {
    const messages = [
      user("hi"),
      assistant(call(SLATE_SEND_MESSAGE_TOOL_NAME, "delivery-1")),
      toolResult("delivery-1"),
      assistant(call("Shell", "shell-1")),
    ];
    assert.equal(turnEndedOnSilentToolCalls(messages), true);
  });

  it("rejects a turn with a later successful delivery and keeps an errored one silent", () => {
    const delivered = [
      user("hi"),
      assistant(call(SLATE_SEND_MESSAGE_TOOL_NAME, "delivery-1")),
      toolResult("delivery-1"),
      assistant(call(SLATE_SEND_MESSAGE_TOOL_NAME, "delivery-2")),
      toolResult("delivery-2"),
      assistant(call("Shell", "shell-1")),
    ];
    assert.equal(turnEndedOnSilentToolCalls(delivered), false);
    const errored = [
      user("hi"),
      assistant(call(SLATE_SEND_MESSAGE_TOOL_NAME, "delivery-1")),
      toolResult("delivery-1", true),
      assistant(call("Shell", "shell-1")),
      toolResult("shell-1"),
    ];
    assert.equal(turnEndedOnSilentToolCalls(errored), true);
  });

  it("skips trailing tool, blank and reminder messages", () => {
    const messages = [
      user("hi"),
      assistant(call(SLATE_SEND_MESSAGE_TOOL_NAME, "delivery-1")),
      toolResult("delivery-1"),
      assistant(call("Shell", "shell-1")),
      toolResult("shell-1"),
      { role: "assistant", content: "" },
      reminder(),
    ];
    assert.equal(turnEndedOnSilentToolCalls(messages), true);
  });

  it("treats a missing or user tail as no turn", () => {
    assert.equal(turnEndedOnSilentToolCalls([assistant(call("Shell", "c1")), "not a message"]), false);
    assert.equal(turnEndedOnSilentToolCalls([assistant(call(SLATE_SEND_MESSAGE_TOOL_NAME, "d")), user("next")]), false);
  });
});
