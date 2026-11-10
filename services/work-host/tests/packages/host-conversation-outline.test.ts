import assert from "node:assert/strict";
import { describe, it } from "node:test";

import * as outline from "../../source/host/runner/conversation-outline.ts";
import { DataClassification } from "../../source/packages/redaction/classification.ts";
import { createRedactedString } from "../../source/packages/redaction/create.ts";
import { PrivacyMode } from "../../source/packages/redaction/privacy-mode.ts";
import {
  createSlateAssistantMessageStep,
  createSlateThinkingMessageStep,
  createSlateToolCallStep,
} from "../../source/packages/agent/conversation-step-state.ts";
import {
  SLATE_HIDDEN_PROMPT_MARKER,
  SLATE_TRUSTED_AUTOMATION_PROMPT_MARKER,
} from "../../source/host/runner/slate-prompt-markers.ts";

const screenshotCall = { tool: { case: "computerUseToolCall", value: { args: { actions: [{ action: { case: "screenshot" } }] } } } };
const twoScreenshotCall = { tool: { case: "computerUseToolCall", value: { args: { actions: [{ action: { case: "screenshot" } }, { action: { case: "click" } }] } } } };

describe("the conversation outline", () => {
  it("names what it outlines and keeps the argument budget", () => {
    assert.deepEqual(Object.keys(outline).sort(), [
      "MAX_TOOL_ACTIVITY_ARGS_CHARS",
      "MCP_TOOL_CALL_OUTLINE_NAME",
      "SEND_MESSAGE_TOOL_CALL_OUTLINE_NAME",
      "deriveOutlineFromConversationState",
      "deriveOutlineFromSlateConversation",
      "deriveOutlineTurnsFromConversationState",
      "deriveOutlineTurnsFromSlateConversation",
      "getOutlineToolCallName",
      "getOutlineToolCallStatus",
      "getOutlineToolCallSummary",
      "getTaskSummary",
      "getToolCallActivityArgs",
      "isFailedTaskToolCall",
      "sendMessageFromToolCall",
      "stepToOutlineItem",
      "stripHiddenMarker",
    ]);
    assert.equal(outline.SEND_MESSAGE_TOOL_CALL_OUTLINE_NAME, "sendMessageToolCall");
    assert.equal(outline.MCP_TOOL_CALL_OUTLINE_NAME, "mcpToolCall");
    assert.equal(outline.MAX_TOOL_ACTIVITY_ARGS_CHARS, 20_000);
  });

  it("takes the platform's own markers off the front of a user text", () => {
    assert.equal(outline.stripHiddenMarker("plain"), "plain");
    assert.equal(outline.stripHiddenMarker(SLATE_HIDDEN_PROMPT_MARKER + "hidden rest"), "hidden rest");
    assert.equal(outline.stripHiddenMarker(SLATE_TRUSTED_AUTOMATION_PROMPT_MARKER + "automated"), "automated");
    assert.equal(
      outline.stripHiddenMarker(SLATE_HIDDEN_PROMPT_MARKER + SLATE_TRUSTED_AUTOMATION_PROMPT_MARKER + "both"),
      "both",
    );
    assert.equal(outline.stripHiddenMarker(" " + SLATE_HIDDEN_PROMPT_MARKER + "late"), " " + SLATE_HIDDEN_PROMPT_MARKER + "late");
  });

  it("names a tool call, summarizes a task call and tells a failed one", () => {
    assert.equal(outline.getOutlineToolCallName({ tool: { case: "taskToolCall", value: {} } } as never), "Task");
    assert.equal(outline.getOutlineToolCallName(screenshotCall as never), "Screenshot");
    assert.equal(outline.getOutlineToolCallName(twoScreenshotCall as never), "computerUseToolCall");
    assert.equal(outline.getOutlineToolCallName({ tool: { case: "mcpToolCall", value: {} } } as never), "mcpToolCall");
    assert.equal(outline.getOutlineToolCallName({ tool: {} } as never), "Tool");
    assert.equal(outline.getTaskSummary({ args: { description: "  do it  " } } as never), "do it");
    assert.equal(outline.getTaskSummary({ args: { description: "  ", prompt: " ask " } } as never), "ask");
    assert.equal(outline.getTaskSummary({ args: { description: " description ", prompt: "prompt" } } as never), "description");
    assert.equal(outline.getTaskSummary({} as never), undefined);
    const failed = { tool: { case: "taskToolCall", value: { result: { result: { case: "error", value: { error: "boom" } } } } } };
    // A send-message call without a message leaves no item rather than an item with nothing in it.
    assert.equal(outline.stepToOutlineItem({ message: { case: "toolCall", value: { tool: { case: "sendMessageToolCall", value: { args: {} } } } } } as never, "id"), null);
    assert.equal(outline.getTaskSummary(failed.tool.value as never), "boom");
    assert.equal(outline.isFailedTaskToolCall(failed as never), true);
    assert.equal(outline.isFailedTaskToolCall({ tool: { case: "taskToolCall", value: {} } } as never), false);
    assert.equal(outline.getOutlineToolCallStatus("toolCallStarted", failed as never), "pending");
    assert.equal(outline.getOutlineToolCallStatus("toolCallCompleted", failed as never), "failed");
    assert.equal(outline.getOutlineToolCallSummary(failed as never), "boom");
  });

  it("keeps activity arguments as JSON, cuts long ones without breaking utf8, and skips empty ones", () => {
    const withArgs = (toJson: () => unknown) => ({ tool: { case: "x", value: { args: { toJson } } } }) as never;
    assert.equal(outline.getToolCallActivityArgs({ tool: {} } as never), undefined);
    assert.equal(outline.getToolCallActivityArgs(withArgs(() => ({}))), undefined);
    assert.equal(outline.getToolCallActivityArgs(withArgs(() => "")), undefined);
    assert.equal(outline.getToolCallActivityArgs(withArgs(() => [])), undefined);
    assert.equal(outline.getToolCallActivityArgs(withArgs(() => null)), undefined);
    assert.equal(outline.getToolCallActivityArgs(withArgs(() => ({ a: 1 }))), '{"a":1}');
    const exact = "x".repeat(19_998);
    assert.equal(outline.getToolCallActivityArgs(withArgs(() => exact)), JSON.stringify(exact), "arguments exactly at the budget are kept whole");
    const long = "x".repeat(20_001);
    assert.equal(outline.getToolCallActivityArgs(withArgs(() => long)), JSON.stringify(long).slice(0, 20_000) + "\n… (truncated)");
    // A cut can fall inside a utf8 sequence; the kept prefix is still valid text.
    const emoji = "😀".repeat(10_000);
    const cut = outline.getToolCallActivityArgs(withArgs(() => emoji)) ?? "";
    assert.equal(cut.endsWith("\n… (truncated)"), true);
    assert.equal(Buffer.from(cut.slice(0, -"\n… (truncated)".length), "utf8").toString("utf8"), cut.slice(0, -"\n… (truncated)".length));
    assert.equal(outline.getToolCallActivityArgs(withArgs(() => { throw new Error("no json"); })), undefined);
  });

  it("keeps a send-message call's text or attachment, and only an attachment with a url", () => {
    const call = (message: unknown) => ({ args: { message } }) as never;
    assert.equal(outline.sendMessageFromToolCall({} as never), null);
    assert.deepEqual(outline.sendMessageFromToolCall(call({ case: "text", value: { content: "hello" } })), { type: "text", content: "hello" });
    assert.equal(outline.sendMessageFromToolCall(call({ case: "text", value: { content: 5 } })), null);
    assert.deepEqual(outline.sendMessageFromToolCall(call({ case: "attachment", value: { url: "u" } })), { type: "attachment", url: "u" });
    assert.deepEqual(outline.sendMessageFromToolCall(call({ case: "attachment", value: { url: "u", alt: "alt" } })), { type: "attachment", url: "u", alt: "alt" });
    assert.deepEqual(outline.sendMessageFromToolCall(call({ case: "attachment", value: { url: "u", alt: "" } })), { type: "attachment", url: "u" });
    assert.equal(outline.sendMessageFromToolCall(call({ case: "attachment", value: { alt: "alt" } })), null);
  });

  it("outlines a turn's steps, its user text and a shell command, leaving out what is empty", () => {
    assert.deepEqual(outline.stepToOutlineItem({ message: { case: "assistantMessage", value: { text: "hi" } } } as never, "a"), { kind: "assistant-text", id: "a", text: "hi" });
    assert.equal(outline.stepToOutlineItem({ message: { case: "assistantMessage", value: { text: "" } } } as never, "a"), null);
    assert.deepEqual(outline.stepToOutlineItem({ message: { case: "thinkingMessage", value: { text: "t", durationMs: 0 } } } as never, "a"), { kind: "thinking", id: "a", text: "t", durationMs: undefined });
    assert.deepEqual(outline.stepToOutlineItem({ message: { case: "thinkingMessage", value: { text: "t", durationMs: 7 } } } as never, "a"), { kind: "thinking", id: "a", text: "t", durationMs: 7 });
    assert.deepEqual(
      outline.stepToOutlineItem({ message: { case: "toolCall", value: { tool: { case: "sendMessageToolCall", value: { args: { message: { case: "text", value: { content: "sent" } } } } } } } } as never, "a"),
      { kind: "send-message", id: "a", message: { type: "text", content: "sent" } },
    );
    const conversation = {
      turns: [
        { turn: { case: "agentConversationTurn", value: { userMessage: { text: "hello", messageId: "m1" }, steps: [{ message: { case: "assistantMessage", value: { text: "hi" } } }] } } },
        { turn: { case: "agentConversationTurn", value: { userMessage: { text: "   " }, steps: [] } } },
        { turn: { case: "agentConversationTurn", value: { userMessage: { text: SLATE_HIDDEN_PROMPT_MARKER + "hidden" }, steps: [] } } },
        { turn: { case: "shellConversationTurn", value: { shellCommand: { command: "ls" } } } },
        { turn: { case: "shellConversationTurn", value: { shellCommand: { command: "" } } } },
        { turn: { case: "someOtherTurn", value: {} } },
      ],
    };
    const turns = outline.deriveOutlineTurnsFromConversationState(conversation as never);
    assert.equal(turns.length, 5, "an unknown turn leaves no turn, a whitespace-only one leaves an empty turn");
    assert.deepEqual(turns[0], { rawUserText: "hello", userMessageId: "m1", items: [{ kind: "user", id: "outline-user-0", text: "hello" }, { kind: "assistant-text", id: "outline-0-0", text: "hi" }] });
    assert.deepEqual(turns[1], { rawUserText: "   ", userMessageId: "", items: [] });
    assert.deepEqual(turns[2], { rawUserText: SLATE_HIDDEN_PROMPT_MARKER + "hidden", userMessageId: "", items: [{ kind: "user", id: "outline-user-2", text: "hidden", hidden: true }] });
    assert.deepEqual(turns[3]!.items[0], { kind: "tool-call", id: "outline-shell-3", name: "shellToolCall", status: "done", summary: "ls" });
    assert.deepEqual(turns[4]!.items[0], { kind: "tool-call", id: "outline-shell-4", name: "shellToolCall", status: "done", summary: undefined });
    const flattened = outline.deriveOutlineFromConversationState(conversation as never);
    assert.deepEqual(flattened, turns.flatMap((turn) => turn.items));
  });

  it("projects a hydrated Slate conversation with the same visible outline semantics", () => {
    const text = (value: string) => createRedactedString(value, DataClassification.CODE, "text", PrivacyMode.NO_STORAGE);
    const conversation = {
      turns: [
        {
          kind: "agent",
          userMessage: {
            text: text(SLATE_HIDDEN_PROMPT_MARKER + "hidden question"),
            messageId: "m-slate",
            mode: "chat",
            conversationStateBlobId: new Uint8Array(),
            hookContexts: [],
          },
          steps: [
            createSlateAssistantMessageStep(text("answer")),
            createSlateThinkingMessageStep({ text: text("reasoning"), durationMs: 7 }),
            createSlateToolCallStep({ tool: {
              case: "sendMessageToolCall",
              value: { args: { message: { case: "text", value: { content: "sent" } } } },
            } }),
            createSlateToolCallStep({ tool: {
              case: "taskToolCall",
              value: { args: { description: " inspect task " } },
            } }),
            createSlateToolCallStep({ tool: { kind: "shell", args: { command: "git status" } } }),
            createSlateToolCallStep({ tool: {
              kind: "task",
              args: {
                request: {
                  summary: text("child task"),
                  instructions: text("run the child task"),
                  attachments: [],
                },
                triggerMessageIds: [],
                execution: { mode: "agent", environment: "local" },
              },
              result: { kind: "error", message: text("task failed") },
            } }),
          ],
        },
        { kind: "shell", invocation: { commandText: text("ls -la") }, result: { standardOutput: "", standardError: "", exitCode: 0 } },
      ],
      todos: [],
    };

    assert.deepEqual(outline.deriveOutlineTurnsFromSlateConversation(conversation as never), [
      {
        rawUserText: SLATE_HIDDEN_PROMPT_MARKER + "hidden question",
        userMessageId: "m-slate",
        items: [
          { kind: "user", id: "outline-user-0", text: "hidden question", hidden: true },
          { kind: "assistant-text", id: "outline-0-0", text: "answer" },
          { kind: "thinking", id: "outline-0-1", text: "reasoning", durationMs: 7 },
          { kind: "send-message", id: "outline-0-2", message: { type: "text", content: "sent" } },
          { kind: "tool-call", id: "outline-0-3", name: "Task", status: "done", summary: "inspect task" },
          { kind: "tool-call", id: "outline-0-4", name: "shellToolCall", status: "done", summary: undefined },
          { kind: "tool-call", id: "outline-0-5", name: "Task", status: "failed", summary: "task failed" },
        ],
      },
      {
        rawUserText: "",
        userMessageId: "",
        items: [{ kind: "tool-call", id: "outline-shell-1", name: "shellToolCall", status: "done", summary: "ls -la" }],
      },
    ]);
  });
});
