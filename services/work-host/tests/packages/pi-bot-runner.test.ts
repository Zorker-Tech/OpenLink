import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import type { BotRuntimeBinding } from "../../source/host/bot/bot-runtime-store.ts";
import { createPiBotRunStep } from "../../source/host/bot/pi-bot-runner.ts";
import { parseFirstBotReply } from "../../source/host/bot/first-bot-reply.ts";
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
  it('returns management results to the isolated group Worker without exposing its tool traffic', async () => {
    const argumentsSeen: unknown[] = [];
    const updates: RunnerUpdate[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body));
      if (url.endsWith('/v1/group/events')) {
        assert.equal(body.management, true);
        return streamOf([
          { type: 'openlink_bot_management', id: 'request-for-tool', parameters: { action: 'create_routine', name: 'Morning report' } },
          { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'private planning' } },
          { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'private final' }] } },
          { type: 'agent_settled' },
        ]);
      }
      assert.ok(url.endsWith('/v1/group/management/resolve'));
      assert.deepEqual(body, { id: 'request-for-tool', result: { routine: { id: 'morning-report' } } });
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const step = createPiBotRunStep({
      agentId: AGENT_ID, getBinding: binding, groupMember: true,
      async manageBot(id, parameters) {
        argumentsSeen.push(id, parameters);
        return { routine: { id: 'morning-report' } };
      },
    });
    await step(0, {
      signal: new AbortController().signal, emitUpdate: update => updates.push(update), prompt: 'Create a routine',
      runOptions: {}, requestId: 'room-request', state: {}, setState: () => {},
    });
    assert.deepEqual(argumentsSeen, ['room-request:request-for-tool', { action: 'create_routine', name: 'Morning report' }]);
    assert.deepEqual(updates, []);
  });

  it("translates Pi events into one delivered message and one turn lifecycle", async () => {
    const requests: Array<{ url: string; body: unknown; headers: Headers }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({
        url,
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
        headers: new Headers(init?.headers),
      });
      if (url.endsWith("/v1/title")) {
        return new Response(JSON.stringify({ title: "Fix the login flow" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
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
    // The title is a parallel metadata request; the turn itself still uses
    // exactly one prompt stream.
    await new Promise((resolve) => setImmediate(resolve));
    const promptRequests = requests.filter((request) => request.url.endsWith("/v1/events"));
    const titleRequests = requests.filter((request) => request.url.endsWith("/v1/title"));
    assert.equal(promptRequests.length, 1);
    assert.equal(promptRequests[0]!.url, "http://worker.example/v1/events");
    const promptBody = promptRequests[0]!.body as { message: string; deliveryGuidance: string };
    assert.equal(promptBody.message, "hello");
    assert.match(promptBody.deliveryGuidance, /SendMessage/);
    assert.equal(promptRequests[0]!.headers.get("authorization"), "Bearer worker-token");
    assert.equal(titleRequests.length, 1);
    assert.deepEqual(titleRequests[0]!.body, { message: "hello" });
    assert.equal(titleRequests[0]!.headers.get("authorization"), "Bearer worker-token");
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
    assert.deepEqual(events.filter((event) => {
      const payload = event && typeof event === "object" ? (event as Record<string, any>).payload : null;
      return payload?.phase !== "title";
    }), [
      { channel: "bot-turn", payload: { agentId: AGENT_ID, requestId: "request-1", phase: "started" } },
      { channel: "bot-turn", payload: { agentId: AGENT_ID, requestId: "request-1", phase: "ended", ok: true } },
    ]);
    assert.deepEqual(events.find((event) => {
      const payload = event && typeof event === "object" ? (event as Record<string, any>).payload : null;
      return payload?.phase === "title";
    }), {
      channel: "bot-turn",
      payload: { agentId: AGENT_ID, requestId: "request-1", phase: "title", title: "Fix the login flow" },
    });
  });

  it('starts the reply stream while the title is still pending and suppresses duplicate final text', async () => {
    let finishTitle!: (response: Response) => void;
    globalThis.fetch = async (input) => String(input).endsWith('/title')
      ? new Promise<Response>(resolve => { finishTitle = resolve; })
      : streamOf([
        { type: 'send-message', message: { content: 'Verified result' } },
        { type: 'send-message', message: { content: 'Verified result' } },
        { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Verified result' }] } },
        { type: 'agent_settled' },
      ]);
    const updates: RunnerUpdate[] = [];
    const step = createPiBotRunStep({ agentId: AGENT_ID, getBinding: binding });
    await step(0, { signal: new AbortController().signal, emitUpdate: update => updates.push(update), prompt: 'verify',
      runOptions: {}, requestId: 'progress', state: {}, setState: () => {} });
    finishTitle(Response.json({ title: 'Delayed title' }));
    assert.equal(updates.filter(({ type }) => type === 'send-message').length, 1);
  });

  it('publishes every distinct proactive message and accounts for model usage', async () => {
    globalThis.fetch = async () => streamOf([
      { type: 'send-message', message: { content: 'Found a regression.' } },
      { type: 'send-message', message: { content: 'Found a regression.' } },
      { type: 'message_end', message: { role: 'assistant', content: [], usage: { totalTokens: 12, cost: { total: 0.01 } } } },
      { type: 'send-message', message: { content: 'The fix passed the tests.' } },
      { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Internal summary' }] } },
      { type: 'agent_settled' },
    ]);
    const updates: RunnerUpdate[] = [];
    const costs: number[] = [];
    const step = createPiBotRunStep({ agentId: AGENT_ID, getBinding: binding });
    await step(0, {
      signal: new AbortController().signal, emitUpdate: update => updates.push(update), prompt: 'Investigate',
      runOptions: { requestSource: 'inspiration', suppressFinalMessage: true, onInspirationUsage: ({ costUsd }: { costUsd: number }) => costs.push(costUsd) },
      requestId: 'proactive', state: {}, setState: () => {},
    });
    assert.deepEqual(updates.filter(update => update.type === 'send-message').map(update => update.message), [
      { type: 'text', content: 'Found a regression.' },
      { type: 'text', content: 'The fix passed the tests.' },
    ]);
    assert.deepEqual(costs, [0.01, 0]);
  });

  it('delivers an explicitly marked proactive finding without SendMessage', async () => {
    globalThis.fetch = async () => streamOf([
      { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '{"message":"The deploy check lacks a regression test."}' }] } },
      { type: 'agent_settled' },
    ]);
    const updates: RunnerUpdate[] = [];
    const step = createPiBotRunStep({ agentId: AGENT_ID, getBinding: binding });
    await step(0, {
      signal: new AbortController().signal, emitUpdate: update => updates.push(update), prompt: 'Investigate',
      runOptions: { requestSource: 'inspiration', suppressFinalMessage: true }, requestId: 'proactive-finding', state: {}, setState: () => {},
    });
    assert.deepEqual(updates.filter(update => update.type === 'send-message').map(update => update.message), [
      { type: 'text', content: 'The deploy check lacks a regression test.' },
    ]);
  });

  it('validates a single emoji and requires inspection of attachments before skipping the full turn', () => {
    const response = JSON.stringify({ message: 'The next step is a quick check.', emoji: '👩🏽‍💻', needsFollowUp: false });
    assert.deepEqual(parseFirstBotReply(response, false), { message: 'The next step is a quick check.', emoji: '👩🏽‍💻', needsFollowUp: false });
    assert.equal(parseFirstBotReply(response, true)?.needsFollowUp, true);
    assert.equal(parseFirstBotReply(response.replace('👩🏽‍💻', '👍🙂'), false)?.emoji, null);
    assert.equal(parseFirstBotReply('{"message":"That is ready."}', false), null);
  });

  it('lets a continuation finish silently after the model decides there is nothing else to deliver', async () => {
    const opening = 'I’ll check the desktop logs.';
    globalThis.fetch = async (input, init) => {
      if (String(input).endsWith('/title')) return Response.json({ title: 'Check the desktop logs' });
      const body = JSON.parse(String(init?.body));
      assert.match(body.deliveryGuidance, /I’ll check the desktop logs/);
      assert.match(body.deliveryGuidance, /Earlier completed dialogue/);
      return streamOf([
        { type: 'send-message', message: { content: 'I’ll check the desktop logs!' } },
        { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '{"message":null}' }] } },
        { type: 'agent_settled' },
      ]);
    };
    const updates: RunnerUpdate[] = [];
    const step = createPiBotRunStep({ agentId: AGENT_ID, getBinding: binding, firstReplyContext: async () => ({
      reply: { message: opening, emoji: null, needsFollowUp: true }, recentCompletedTurns: [{ role: 'user', text: 'This is my desktop.' }],
    }) });
    await step(0, {
      signal: new AbortController().signal, emitUpdate: update => updates.push(update), prompt: 'Check the desktop logs',
      runOptions: { messageId: 'message-id' }, requestId: 'optional-continuation', state: {}, setState: () => {},
    });
    assert.equal(updates.some(update => update.type === 'send-message'), false);
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

  it("hands a sibling nomination to the host without failing the turn", async () => {
    globalThis.fetch = (async () => streamOf([
      { type: "nominate-inspiration", target: "other-bot", task: "check the deploy pipeline" },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1, output: 1 } } },
      { type: "agent_settled" },
    ])) as typeof fetch;
    const nominations: Array<{ target: string; task: string }> = [];
    const step = createPiBotRunStep({
      agentId: AGENT_ID,
      getBinding: () => binding(),
      nominateInspiration: async (target, task) => {
        nominations.push({ target, task });
        return { ok: true };
      },
      now: () => 11,
    });
    await step(0, {
      signal: new AbortController().signal,
      emitUpdate: () => {},
      prompt: "hand off",
      runOptions: {},
      requestId: "request-nominate",
      state: {},
      setState: () => {},
    });
    assert.deepEqual(nominations, [{ target: "other-bot", task: "check the deploy pipeline" }]);
  });

  it("fails a settled turn whose final assistant message carries a provider error", async () => {
    globalThis.fetch = (async () => streamOf([
      { type: "message_end", message: { role: "assistant", content: [], errorMessage: "provider unavailable", usage: { input: 1, output: 0 } } },
      { type: "agent_settled" },
    ])) as typeof fetch;
    const events: Array<Record<string, any>> = [];
    const step = createPiBotRunStep({
      agentId: AGENT_ID,
      getBinding: () => binding(),
      emitGatewayEvent: (event) => events.push(event as Record<string, any>),
      now: () => 1,
    });
    await assert.rejects(
      step(0, {
        signal: new AbortController().signal,
        emitUpdate: () => {},
        prompt: "hello",
        runOptions: {},
        requestId: "request-error",
        state: {},
        setState: () => {},
      }),
      /provider unavailable/,
    );
    assert.deepEqual(events.at(-1)?.payload, {
      agentId: AGENT_ID,
      requestId: "request-error",
      phase: "ended",
      ok: false,
      error: "provider unavailable",
    });
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
