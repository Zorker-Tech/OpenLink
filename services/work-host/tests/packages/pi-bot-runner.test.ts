import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import type { BotRuntimeBinding } from "../../source/host/bot/bot-runtime-store.ts";
import { createPiBotRunStep } from "../../source/host/bot/pi-bot-runner.ts";
import type { RunnerUpdate } from "../../source/host/runner/runner-turn-attempt.ts";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";

function binding(): BotRuntimeBinding {
  return {
    version: 1,
    agentId: AGENT_ID,
    botId: "22222222-2222-4222-8222-222222222222",
    boxKey: "bot-22222222-2222-4222-8222-222222222222",
    projectId: "33333333-3333-4333-8333-333333333333",
    userId: "user",
    workspaceId: "workspace",
    workerUrl: "http://worker.example",
    workerHeaders: { Authorization: "Bearer worker-token" },
    desktopUrl: "http://desktop.example/vnc.html",
    vncUrl: "http://desktop.example/vnc.html",
    sandboxId: "sandbox-1",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function streamOf(lines: readonly unknown[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "application/x-ndjson" } });
}

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe("the Pi-backed Bot run step", () => {
  it("translates Pi events into one delivered message and one turn lifecycle", async () => {
    const requests: Array<{ url: string; body: unknown; headers: Headers }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(input),
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
        headers: new Headers(init?.headers),
      });
      return streamOf([
        { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "planning" } },
        { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hello" } },
        { type: "tool_execution_start", toolCallId: "call-1", toolName: "read" },
        { type: "tool_execution_end", toolCallId: "call-1", toolName: "read", isError: false },
        { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Hello world" }], usage: { input: 3, output: 5 } } },
        { type: "agent_settled" },
      ]);
    }) as typeof fetch;

    const updates: RunnerUpdate[] = [];
    const events: unknown[] = [];
    const step = createPiBotRunStep({
      agentId: AGENT_ID,
      getBinding: () => binding(),
      emitGatewayEvent: (event) => events.push(event),
      now: () => 42,
    });
    const result = await step(0, {
      signal: new AbortController().signal,
      emitUpdate: (update) => updates.push(update),
      prompt: "hello",
      runOptions: { ackToken: "ack-token" },
      requestId: "request-1",
      state: {},
      setState: () => {},
    });

    assert.deepEqual(result, { done: true });
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.url, "http://worker.example/v1/events");
    assert.deepEqual(requests[0]!.body, { message: "hello" });
    assert.equal(requests[0]!.headers.get("authorization"), "Bearer worker-token");
    assert.deepEqual(
      updates.filter((update) => update.type !== "tool-call"),
      [
        { type: "thinking-delta", text: "planning" },
        { type: "text-delta", text: "Hello" },
        { type: "send-message", message: { type: "text", content: "Hello world" }, timestampMs: 42, ackToken: "ack-token" },
        { type: "turn-ended", usage: { input: 3, output: 5 } },
      ],
    );
    assert.deepEqual(
      updates.filter((update) => update.type === "tool-call").map((update) => update.status),
      ["pending", "completed"],
    );
    assert.deepEqual(events, [
      { channel: "bot-turn", payload: { agentId: AGENT_ID, requestId: "request-1", phase: "started" } },
      { channel: "bot-turn", payload: { agentId: AGENT_ID, requestId: "request-1", phase: "ended", ok: true } },
    ]);
  });

  it("turns a Pi dialog into a durable question card and an awaiting-input event", async () => {
    globalThis.fetch = (async () => streamOf([
      { type: "extension_ui_request", id: "dialog-1", method: "confirm", title: "Continue?", message: "Deploy now?" },
      { type: "agent_settled" },
    ])) as typeof fetch;
    const updates: RunnerUpdate[] = [];
    const events: Array<Record<string, any>> = [];
    const step = createPiBotRunStep({
      agentId: AGENT_ID,
      getBinding: () => binding(),
      emitGatewayEvent: (event) => events.push(event as Record<string, any>),
      now: () => 7,
    });
    await step(0, {
      signal: new AbortController().signal,
      emitUpdate: (update) => updates.push(update),
      prompt: "deploy",
      runOptions: {},
      requestId: "request-2",
      state: {},
      setState: () => {},
    });
    const card = updates.find((update) => update.type === "send-message");
    assert.ok(card !== undefined && card.type === "send-message");
    assert.deepEqual(card.message, {
      type: "widget",
      widget: { kind: "bot-question", id: "dialog-1", method: "confirm", title: "Continue?", prompt: "Deploy now?" },
    });
    assert.equal(events.some((event) => event.payload?.phase === "awaiting-input" && event.payload?.extensionUiId === "dialog-1"), true);
    assert.equal(events.at(-1)?.payload?.phase, "ended");
  });

  it("keeps a user-facing notice and projects a transient status line", async () => {
    globalThis.fetch = (async () => streamOf([
      { type: "extension_ui_request", id: "notice-1", method: "notify", message: "Heads up" },
      { type: "extension_ui_request", id: "status-1", method: "setStatus", statusKey: "work", statusText: "Checking the deploy" },
      { type: "agent_settled" },
    ])) as typeof fetch;
    const updates: RunnerUpdate[] = [];
    const events: Array<Record<string, any>> = [];
    const step = createPiBotRunStep({
      agentId: AGENT_ID,
      getBinding: () => binding(),
      emitGatewayEvent: (event) => events.push(event as Record<string, any>),
      now: () => 9,
    });
    await step(0, {
      signal: new AbortController().signal,
      emitUpdate: (update) => updates.push(update),
      prompt: "deploy",
      runOptions: {},
      requestId: "request-4",
      state: {},
      setState: () => {},
    });
    assert.deepEqual(updates.find((update) => update.type === "send-message"), {
      type: "send-message",
      message: { type: "bot-activity", activity: { label: "Heads up", status: "done", tool: "notice" } },
      timestampMs: 9,
    });
    assert.equal(events.some((event) => event.payload?.phase === "status" && event.payload?.label === "Checking the deploy"), true);
  });

  it("refuses a turn when the Bot has no runtime binding", async () => {
    const step = createPiBotRunStep({ agentId: AGENT_ID, getBinding: () => null });
    await assert.rejects(
      step(0, {
        signal: new AbortController().signal,
        emitUpdate: () => {},
        prompt: "hello",
        runOptions: {},
        requestId: "request-3",
        state: {},
        setState: () => {},
      }),
      /BOT_RUNTIME_BINDING_MISSING/,
    );
  });
});
