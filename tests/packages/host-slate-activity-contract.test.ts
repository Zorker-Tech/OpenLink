import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createGroupMemberActivityTracker,
  deriveActivityFromUpdate,
  deriveToolCallActivity,
  extractShellEditTarget,
  fileBasename,
  INITIAL_NAMED_ACTIVITY_HOLD_STATE,
  MAX_ACTIVITY_DETAIL_CHARS,
  NAMED_ACTIVITY_MAX_HOLD_MS,
  parseArgsJson,
  resolveNamedActivityHold,
  SLATE_BOX_AWAIT_SHELL_TOOL_NAME,
  SLATE_BOX_READ_TOOL_NAME,
  SLATE_BOX_SHELL_TOOL_NAME,
  SLATE_EXTERNAL_AWAIT_SHELL_TOOL_NAME,
  SLATE_EXTERNAL_READ_TOOL_NAME,
  SLATE_EXTERNAL_SHELL_TOOL_NAME,
  THINKING_ACTIVITY,
  urlHostname,
  type AgentActivity,
  type ActivityUpdate,
} from "../../source/host/slate-activity.ts";

function toolCall(overrides: Partial<Extract<ActivityUpdate, { type: "tool-call" }>> = {}): ActivityUpdate {
  return {
    type: "tool-call",
    id: "call-1",
    name: "Task",
    status: "pending",
    ...overrides,
  } as ActivityUpdate;
}

function toolActivity(update: ActivityUpdate): Extract<AgentActivity, { kind: "tool" }> {
  const activity = deriveToolCallActivity(update as never);
  assert.equal(activity.kind, "tool");
  if (activity.kind !== "tool") throw new Error("expected a tool activity");
  return activity;
}

describe("activity updates as transitions", () => {
  it("shows thinking while the agent writes, clears on a completed user-facing action, and keeps unknown updates", () => {
    assert.deepEqual(deriveActivityFromUpdate({ type: "thinking-delta" }), { type: "set", activity: THINKING_ACTIVITY });
    assert.deepEqual(deriveActivityFromUpdate({ type: "text-delta", text: "working" }), { type: "set", activity: THINKING_ACTIVITY });
    assert.deepEqual(deriveActivityFromUpdate({ type: "send-message" }), { type: "clear" });
    assert.deepEqual(deriveActivityFromUpdate({ type: "turn-ended" }), { type: "clear" });
    assert.deepEqual(deriveActivityFromUpdate({ type: "new-server-event", value: 1 }), { type: "keep" });
  });

  it("waits to name tools whose activity surface may not have resolved yet", () => {
    for (const name of ["shellToolCall", "readToolCall", "awaitToolCall"]) {
      assert.deepEqual(deriveActivityFromUpdate(toolCall({ name })), { type: "keep" });
    }
    assert.deepEqual(deriveActivityFromUpdate(toolCall({ name: "SendMessage" })), { type: "keep" });
    assert.deepEqual(deriveActivityFromUpdate(toolCall({ status: "completed" })), { type: "keep" });
    assert.deepEqual(deriveActivityFromUpdate(toolCall({ name: "Task", summary: "inspect files" })), {
      type: "set",
      activity: { kind: "tool", tool: "Task", detail: "inspect files", callId: "call-1" },
    });
  });
});

describe("named activity holding", () => {
  it("holds a named tool through fast text and expires exactly at the time boundary", () => {
    assert.equal(MAX_ACTIVITY_DETAIL_CHARS, 80);
    assert.equal(NAMED_ACTIVITY_MAX_HOLD_MS, 2_500);
    const named = resolveNamedActivityHold(toolCall({ summary: "checking" }), INITIAL_NAMED_ACTIVITY_HOLD_STATE, 100);
    assert.deepEqual(named.transition, { type: "set", activity: { kind: "tool", tool: "Task", detail: "checking", callId: "call-1" } });
    assert.deepEqual(named.state, { heldActivity: named.transition.type === "set" ? named.transition.activity : undefined, heldSinceMs: 100 });

    const fastText = resolveNamedActivityHold({ type: "text-delta", text: "still here" }, named.state, 100 + NAMED_ACTIVITY_MAX_HOLD_MS - 1);
    assert.deepEqual(fastText.transition, { type: "keep" });
    assert.equal(fastText.state, named.state);
    const boundary = resolveNamedActivityHold({ type: "thinking-delta" }, named.state, 100 + NAMED_ACTIVITY_MAX_HOLD_MS);
    assert.deepEqual(boundary.transition, { type: "set", activity: THINKING_ACTIVITY });
  });

  it("refreshes a held name when another tool update arrives and resets after a clear", () => {
    const named = resolveNamedActivityHold(toolCall(), INITIAL_NAMED_ACTIVITY_HOLD_STATE, 10);
    const unresolved = resolveNamedActivityHold(toolCall({ name: "shellToolCall" }), named.state, 200);
    assert.deepEqual(unresolved.transition, { type: "keep" });
    assert.deepEqual(unresolved.state, { heldActivity: named.state.heldActivity, heldSinceMs: 200 });
    assert.deepEqual(resolveNamedActivityHold({ type: "thinking-delta" }, unresolved.state, 2_699).transition, { type: "keep" });
    assert.deepEqual(resolveNamedActivityHold({ type: "turn-ended" }, unresolved.state, 2_700), {
      transition: { type: "clear" },
      state: INITIAL_NAMED_ACTIVITY_HOLD_STATE,
    });
  });
});

describe("group member activity", () => {
  it("clears on visible text, suppresses thinking while text streams, then resumes activity", () => {
    const track = createGroupMemberActivityTracker();
    assert.deepEqual(track({ type: "thinking-delta" }), { type: "set", activity: THINKING_ACTIVITY });
    assert.deepEqual(track({ type: "text-delta", text: "" }), { type: "keep" });
    assert.deepEqual(track({ type: "text-delta", text: "hello" }), { type: "clear" });
    assert.deepEqual(track({ type: "thinking-delta" }), { type: "keep" });
    assert.deepEqual(track(toolCall({ name: "Task" })), { type: "set", activity: { kind: "tool", tool: "Task", callId: "call-1" } });
    assert.deepEqual(track({ type: "thinking-delta" }), { type: "set", activity: THINKING_ACTIVITY });
    assert.deepEqual(track({ type: "send-message" }), { type: "clear" });
    assert.deepEqual(track({ type: "thinking-delta" }), { type: "set", activity: THINKING_ACTIVITY });
  });

  it("clears a pending SendMessage call and resets text-stream suppression at turn end", () => {
    const track = createGroupMemberActivityTracker();
    assert.deepEqual(track({ type: "text-delta", text: "hello" }), { type: "clear" });
    assert.deepEqual(track(toolCall({ name: "SendMessage" })), { type: "clear" });
    assert.deepEqual(track({ type: "thinking-delta" }), { type: "set", activity: THINKING_ACTIVITY });
    assert.deepEqual(track({ type: "text-delta", text: "again" }), { type: "clear" });
    assert.deepEqual(track({ type: "turn-ended" }), { type: "clear" });
    assert.deepEqual(track({ type: "thinking-delta" }), { type: "set", activity: THINKING_ACTIVITY });
  });
});

describe("activity arguments and shell paths", () => {
  it("accepts object JSON arguments and leaves other JSON shapes out", () => {
    assert.deepEqual(parseArgsJson('{"path":" /work/a.ts "}'), { path: " /work/a.ts " });
    for (const input of [undefined, "", " ", "not-json", "null", "true", "7", "\"text\"", "[]"]) {
      assert.equal(parseArgsJson(input), null);
    }
  });

  it("takes a basename from either path separator and drops trailing separators", () => {
    assert.equal(fileBasename("/workspace/reports/summary.md"), "summary.md");
    assert.equal(fileBasename("C:\\workspace\\reports\\summary.md"), "summary.md");
    assert.equal(fileBasename("/workspace/reports///"), "reports");
    assert.equal(fileBasename("/"), undefined);
    assert.equal(fileBasename(undefined), undefined);
  });

  it("uses a URL's hostname without its credentials, port, or path", () => {
    assert.equal(urlHostname("https://reader:secret@WWW.example.com:8443/a/b"), "www.example.com");
    assert.equal(urlHostname("not a URL"), undefined);
    assert.equal(urlHostname(undefined), undefined);
  });

  it("finds shell output and tee targets, skips device redirects, and recognizes in-place sed paths", () => {
    assert.equal(extractShellEditTarget('printf x > "/workspace/review.md"'), "review.md");
    assert.equal(extractShellEditTarget("printf x > /workspace/review.md"), "review.md");
    assert.equal(extractShellEditTarget("printf x >> /dev/null"), undefined);
    assert.equal(extractShellEditTarget("printf x 2> errors.log"), undefined);
    assert.equal(extractShellEditTarget("printf x | tee -a /workspace/logs/out.txt"), "out.txt");
    assert.equal(extractShellEditTarget("sed -i 's/old/new/' /workspace/source.ts"), "source.ts");
  });
});

describe("tool activity details", () => {
  it("maps box and external shell/read/await tools to their own names", () => {
    assert.equal(SLATE_BOX_SHELL_TOOL_NAME, "Shell");
    assert.equal(SLATE_EXTERNAL_SHELL_TOOL_NAME, "ExternalShell");
    assert.equal(SLATE_BOX_READ_TOOL_NAME, "Read");
    assert.equal(SLATE_EXTERNAL_READ_TOOL_NAME, "ExternalRead");
    assert.equal(SLATE_BOX_AWAIT_SHELL_TOOL_NAME, "AwaitShell");
    assert.equal(SLATE_EXTERNAL_AWAIT_SHELL_TOOL_NAME, "ExternalAwaitShell");
    assert.deepEqual(deriveToolCallActivity(toolCall({ name: "shellToolCall", args: '{"command":"cat > /workspace/file.ts"}' }) as never), {
      kind: "tool", tool: "Shell", detail: "file.ts", callId: "call-1",
    });
    assert.deepEqual(deriveToolCallActivity(toolCall({ name: "ExternalShell", args: '{"command":"tee /workspace/out.log"}' }) as never), {
      kind: "tool", tool: "ExternalShell", detail: "out.log", callId: "call-1",
    });
    assert.deepEqual(deriveToolCallActivity(toolCall({ name: "readToolCall", args: '{"path":"/workspace/docs/guide.md"}' }) as never), {
      kind: "tool", tool: "Read", detail: "guide.md", callId: "call-1",
    });
    assert.equal(toolActivity(toolCall({ name: "ExternalRead", args: '{"path":"C:\\\\docs\\\\guide.md"}' })).tool, "ExternalRead");
    assert.equal(toolActivity(toolCall({ name: "awaitToolCall" })).tool, "AwaitShell");
    assert.equal(toolActivity(toolCall({ name: "ExternalAwaitShell" })).tool, "ExternalAwaitShell");
  });

  it("summarizes search, fetch, image, MCP, computer, task and screenshot activity", () => {
    const activity = (name: string, args?: string, summary?: string) => toolActivity(toolCall({ name, ...(args === undefined ? {} : { args }), ...(summary === undefined ? {} : { summary }) }));
    assert.deepEqual(activity("webSearchToolCall", '{"searchTerm":"  slate docs  "}'), { kind: "tool", tool: "WebSearch", detail: "slate docs", callId: "call-1" });
    assert.deepEqual(activity("webFetchToolCall", '{"url":"https://example.com:8443/path"}'), { kind: "tool", tool: "WebFetch", detail: "example.com", callId: "call-1" });
    assert.equal(activity("generateImageToolCall", JSON.stringify({ description: "x".repeat(100) })).detail?.length, MAX_ACTIVITY_DETAIL_CHARS);
    assert.deepEqual(activity("mcpToolCall", '{"serverIdentifier":"server-a"}'), { kind: "tool", tool: "CallMcpTool", detail: "server-a", callId: "call-1" });
    assert.deepEqual(activity("mcpToolCall", '{"providerIdentifier":"provider-a","serverIdentifier":"server-b"}'), { kind: "tool", tool: "CallMcpTool", detail: "provider-a", callId: "call-1" });
    assert.deepEqual(activity("getMcpToolsToolCall", '{"server":"server-b"}'), { kind: "tool", tool: "GetMcpTools", detail: "server-b", callId: "call-1" });
    assert.deepEqual(activity("mcpAuthToolCall", '{"serverIdentifier":"server-c"}'), { kind: "tool", tool: "McpAuth", detail: "server-c", callId: "call-1" });
    assert.equal(activity("computerUseToolCall").tool, "Computer");
    assert.deepEqual(activity("Task", undefined, "opening a file"), { kind: "tool", tool: "Task", detail: "opening a file", callId: "call-1" });
    assert.deepEqual(activity("Screenshot"), { kind: "tool", tool: "Screenshot", callId: "call-1" });
  });

  it("reads only a marked Slate communicate-update payload", () => {
    const marked = JSON.stringify({ __slate_tool__: true, tool: "Read", detail: "summary.md", target: "notes" });
    assert.deepEqual(toolActivity(toolCall({ name: "communicateUpdateToolCall", args: JSON.stringify({ currentStep: marked }) })), {
      kind: "tool", tool: "Read", detail: "summary.md", target: "notes", callId: "call-1",
    });
    assert.deepEqual(toolActivity(toolCall({ name: "communicateUpdateToolCall", args: '{"currentStep":"ordinary progress"}' })), {
      kind: "tool", tool: "communicateUpdateToolCall", callId: "call-1",
    });
    const unmarked = JSON.stringify({ currentStep: JSON.stringify({ __slate_tool__: false, tool: "Read", detail: "not ours" }) });
    assert.deepEqual(toolActivity(toolCall({ name: "communicateUpdateToolCall", args: unmarked })), {
      kind: "tool", tool: "communicateUpdateToolCall", callId: "call-1",
    });
  });
});
