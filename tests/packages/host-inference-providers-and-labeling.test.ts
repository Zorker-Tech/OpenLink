/**
 * The inference the host runs turns through: the labeling a finished turn leaves (and when it leaves none), the model
 * each routed provider runs, a turn run through our own OpenRouter model, where the session's routing lands, and the
 * box lifecycle declared as an extension.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  recordSlatePostTurnLabeling,
  SLATE_AGENT_MODE,
  wrapExecutorWithSlateFollowupLabeling,
  wrapPromptSessionWithSlateFollowupLabeling,
} from "../../source/host/extensions/inference/slate-labeling.ts";
import { createProviderPromptSession, runRoutedProviderText } from "../../source/host/extensions/inference/provider-session.ts";
import { createSlateInferencePromptSession } from "../../source/adapters/interop/slate-backend/slate-backend-client.ts";
import { boxLifecycleExtension } from "../../source/host/boxes/box-lifecycle/extension.ts";
import { BoxLifecycleService } from "../../source/host/boxes/box-lifecycle/box-lifecycle-service.ts";
import { HostExtensions } from "../../source/host/extensions/extension-ids.generated.ts";
import { SLATE_DATA_ROOT_ENV } from "../../source/host/host-paths.ts";
import { conversationIdKey, requestIdKey } from "../../source/adapters/interop/chat-inference-proto/client.ts";
import { SlateSettingsStore } from "../../source/shared/node/settings/slate-settings-store.ts";
import type { LabelMessage } from "../../source/host/extensions/inference/slate-labeling.ts";
import { pinHostDiagnosticsReporter, type HostDiagnostic } from "../../source/host/host-diagnostics.ts";

const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length > 0) restores.pop()?.();
});

function setEnv(name: string, value: string | undefined) {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  restores.push(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

/** A context that knows which conversation and request it is. */
function ctxFor(conversationId: string, requestId: string) {
  const values = new Map<unknown, unknown>([
    [conversationIdKey, conversationId],
    [requestIdKey, requestId],
  ]);
  return { get: (key: unknown) => values.get(key) };
}

function labelingWorld() {
  const recorded: unknown[] = [];
  const executorCalls: string[] = [];
  const messages: LabelMessage[] = [{ role: "user", content: "what was asked" }];
  const executor = {
    appendMessages: (next: unknown) => {
      executorCalls.push("append");
      return next;
    },
    getState: () => ({ state: true }),
    getMessages: () => messages,
    clearMessages: () => executorCalls.push("clear"),
    stream: (...args: unknown[]) => ({ args, marker: "the stream" }),
  };
  const client = {
    recordFollowupClassification: async (request: unknown) => {
      recorded.push(request);
    },
    recordPostTurnLabeling: async (request: unknown) => {
      recorded.push(request);
    },
  };
  return { executor, client, recorded, executorCalls, messages };
}

describe("the labeling a finished turn leaves", () => {
  it("labels the follow-up once per conversation and request, and only when there is one", async () => {
    const world = labelingWorld();
    const recordedIds = new Set<string>();
    const wrapper = wrapExecutorWithSlateFollowupLabeling(world.executor as never, world.client, "the-model", recordedIds);
    // The first turn of a conversation has nothing to reply to.
    const first = wrapper.stream(ctxFor("conv-label-1", "req-1"), "inv-1", [], {});
    assert.deepEqual((first as { marker: string }).marker, "the stream");
    assert.deepEqual(world.recorded.length, 0);
    // A second request labels the follow-up of the first.
    wrapper.stream(ctxFor("conv-label-1", "req-2"), "inv-2", [], {});
    await new Promise((resolve) => setTimeout(resolve, 5));
    const request = world.recorded[0] as { requestId: string; replyingToRequestId: string; conversationId: string; agentMode: string; modelName: string; messages: unknown[] };
    assert.deepEqual(
      [request.requestId, request.replyingToRequestId, request.conversationId, request.agentMode, request.modelName, request.messages.length],
      ["req-2", "req-1", "conv-label-1", SLATE_AGENT_MODE, "the-model", 1],
    );
    // The same request again is not labeled again, and neither is a conversation that is not named.
    wrapper.stream(ctxFor("conv-label-1", "req-2"), "inv-3", [], {});
    wrapper.stream(ctxFor("", "req-9"), "inv-4", [], {});
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(world.recorded.length, 1);
    // What the executor does is passed through, and the wrapper is what appending answers.
    assert.equal(wrapper.appendMessages([] as never), wrapper);
    assert.deepEqual(wrapper.getState(), { state: true });
    assert.deepEqual(wrapper.getMessages(), world.messages);
    wrapper.clearMessages();
    assert.deepEqual(world.executorCalls, ["append", "clear"]);
  });

  it("leaves a summarization turn and an empty session alone", async () => {
    const world = labelingWorld();
    world.messages.push({ role: "assistant", content: "x", providerOptions: { slate: { inferenceReason: "agent-summarization" } } });
    const wrapper = wrapExecutorWithSlateFollowupLabeling(world.executor as never, world.client, "m", new Set());
    wrapper.stream(ctxFor("conv-label-2", "req-1"), "inv-1", [], {});
    wrapper.stream(ctxFor("conv-label-2", "req-2"), "inv-2", [], {});
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(world.recorded.length, 0);
    const empty = labelingWorld();
    empty.messages.length = 0;
    const emptyWrapper = wrapExecutorWithSlateFollowupLabeling(empty.executor as never, empty.client, "m", new Set());
    emptyWrapper.stream(ctxFor("conv-label-3", "req-1"), "inv-1", [], {});
    emptyWrapper.stream(ctxFor("conv-label-3", "req-2"), "inv-2", [], {});
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(empty.recorded.length, 0);
    // The session wrapper hands back the same model, over an executor that labels.
    const session = wrapPromptSessionWithSlateFollowupLabeling({ getModelId: () => "the-model", getExecutor: () => world.executor as never }, world.client, "the-model");
    assert.equal(session.getModelId(), "the-model");
    assert.equal(typeof session.getExecutor().stream, "function");
  });

  it("records what a finished turn was about, and says when that labeling failed", async () => {
    const world = labelingWorld();
    recordSlatePostTurnLabeling(world.client, { conversationId: "conv-label-4", requestId: "req-1", modelName: "m", messages: world.messages as never });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const request = world.recorded[0] as { requestId: string; conversationId: string; agentMode: string };
    assert.deepEqual([request.requestId, request.conversationId, request.agentMode], ["req-1", "conv-label-4", SLATE_AGENT_MODE]);
    // Nothing to label, or nothing to label it for, is nothing to record.
    const before = world.recorded.length;
    recordSlatePostTurnLabeling(world.client, { conversationId: "conv-label-4", requestId: "  ", modelName: "m", messages: world.messages as never });
    recordSlatePostTurnLabeling(world.client, { conversationId: "conv-label-4", requestId: "req-2", modelName: "m", messages: [] });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(world.recorded.length, before);
    // A labeling the backend refused is reported, not thrown.
    const diagnostics: HostDiagnostic[] = [];
    pinHostDiagnosticsReporter((diagnostic) => diagnostics.push(diagnostic));
    restores.push(() => pinHostDiagnosticsReporter(null));
    const failing = { recordFollowupClassification: async () => {}, recordPostTurnLabeling: async () => { throw new Error("the backend said no"); } };
    recordSlatePostTurnLabeling(failing, { conversationId: "conv-label-5", requestId: "req-1", modelName: "m", messages: world.messages as never });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(diagnostics.map((diagnostic) => [diagnostic.kind, diagnostic.stage, diagnostic.errorClass]), [["labeling_failed", "post_turn_labeling", "Error"]]);
  });
});

describe("the routed providers", () => {
  it("names the model each provider runs, and runs a turn through our own OpenRouter model", async () => {
    setEnv("SLATE_OPENROUTER_MODEL", "anthropic/claude-x");
    setEnv("SLATE_CLAUDE_MODEL", undefined);
    setEnv("OPENROUTER_API_KEY", "key-1");
    assert.deepEqual(
      [createProviderPromptSession("claude-code").getModelId(), createProviderPromptSession("openrouter").getModelId(), typeof createProviderPromptSession("codex").getModelId()],
      ["claude-code", "anthropic/claude-x", "string"],
    );
    const requests: Array<{ url: string; model: unknown }> = [];
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), model: (JSON.parse(String(init?.body ?? "{}")) as { model?: unknown }).model });
      const block = 'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":2}}\n\ndata: [DONE]\n\n';
      const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(block)); controller.close(); } });
      return new Response(body, { status: 200 });
    }) as typeof fetch;
    restores.push(() => {
      globalThis.fetch = previousFetch;
    });
    const deltas: string[] = [];
    const text = await runRoutedProviderText("openrouter", [{ role: "user", content: "say hi" }] as never, { onTextDelta: (delta) => deltas.push(delta) });
    assert.deepEqual([text, deltas], ["hi", ["hi"]]);
    assert.deepEqual(requests, [{ url: "https://openrouter.ai/api/v1/chat/completions", model: "anthropic/claude-x" }]);
  });

  it("sends a conversation the platform owns to the backend, and anything else to its own provider", () => {
    const root = mkdtempSync(join(tmpdir(), "slate-inference-"));
    setEnv(SLATE_DATA_ROOT_ENV, root);
    mkdirSync(root, { recursive: true });
    // The settings are written the way the platform writes them, so what it reads back is what a user set.
    const settings = new SlateSettingsStore(join(root, "settings.json"));
    const options = { getAccessToken: async () => "token", getMachineId: async () => "machine", requestedModel: { modelId: "m" } } as never;
    // The platform's own backend is the one provider the platform calls its own: it answers with what was asked of it.
    settings.setInferenceProvider("slate");
    assert.equal((createSlateInferencePromptSession(options) as { getModelId(): string }).getModelId(), "m");
    // Every other provider is one of its own, and the session says which model it runs.
    settings.setInferenceProvider("claude-code");
    assert.equal((createSlateInferencePromptSession(options) as { getModelId(): string }).getModelId(), "claude-code");
    setEnv("SLATE_OPENROUTER_MODEL", "anthropic/claude-x");
    settings.setInferenceProvider("openrouter");
    assert.equal((createSlateInferencePromptSession(options) as { getModelId(): string }).getModelId(), "anthropic/claude-x");
  });
});

describe("the box lifecycle extension", () => {
  it("declares itself and builds the lifecycle service over the host's auth", () => {
    assert.deepEqual([boxLifecycleExtension.id, boxLifecycleExtension.dependencies], [HostExtensions.BoxLifecycle, [HostExtensions.Auth]]);
    const started = boxLifecycleExtension.start({
      deps: { [HostExtensions.Auth]: { getAccessToken: async () => "token", getMachineId: async () => "machine" } },
      host: { events: { emit: async () => {} } },
      onStop: () => {},
    } as never) as unknown;
    assert.equal(started instanceof BoxLifecycleService, true);
  });
});
