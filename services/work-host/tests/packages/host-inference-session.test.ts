/**
 * The inference sessions the host runs turns with: which model a turn resolves to, what a scripted mock response may
 * be, and how a session is built when the platform's own inference is the account's provider — or is not.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";

import { SLATE_COMPUTER_USE_MODEL_SELECTION, SLATE_COMPUTER_USE_SUBAGENT_MODEL_ID } from "../../source/shared/agents/slate-agent-model.ts";
import { createSlateInferenceSessionFactory, createScriptedMockSession, parseSlateMockScript, resolveSlateRequestedModel, SLATE_DEFAULT_MODEL_ID, SLATE_DEFAULT_MODEL_SELECTION, type SlateInferenceSessionFactoryOptions, type SlateInferenceSessionInteropPort } from "../../source/host/extensions/inference/slate-inference-session.ts";
import { SlateSettingsStore } from "../../source/shared/node/settings/slate-settings-store.ts";
import { createMockPromptExecutor } from "../../source/packages/chat-inference/mock-prompt-executor.ts";

const testInterop: SlateInferenceSessionInteropPort = {
  resolvePrivacyMode: () => "safe",
  createAttachedMediaUrlProvider: () => ({ getUrl: async () => "media-url" }),
  createPromptSession: ({ requestedModel }) => ({
    getModelId: () => requestedModel.modelId,
    getExecutor: () => createMockPromptExecutor(() => ({ response: "answer" })),
  }),
  createLabelingClient: () => ({
    recordFollowupClassification: async () => undefined,
    recordPostTurnLabeling: async () => undefined,
  }),
};

function createInference(options: Partial<Omit<SlateInferenceSessionFactoryOptions, "interop">> = {}) {
  return createSlateInferenceSessionFactory({ interop: testInterop, ...options });
}

const scratch = mkdtempSync(join(tmpdir(), "slate-inference-session-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const savedEnv = { mock: process.env["SLATE_AGENT_MOCK_RESPONSE"], model: process.env["SLATE_AGENT_MODEL"], root: process.env["SLATE_DATA_ROOT"] };
beforeEach(() => {
  delete process.env["SLATE_AGENT_MOCK_RESPONSE"];
  delete process.env["SLATE_AGENT_MODEL"];
});

const selection = (modelId: string, parameters: { id: string; value: string }[] = []) => ({ modelId, maxMode: true, parameters });

/** The text a mock executor answers with, read off the stream it hands out. */
async function streamedText(executor: { stream(...args: readonly unknown[]): unknown }): Promise<string> {
  const stream = executor.stream({}) as { fullStream: AsyncIterable<{ type: string; textDelta?: string }> };
  let text = "";
  for await (const event of stream.fullStream) if (event.type === "text-delta") text += event.textDelta ?? "";
  return text;
}

/** The tool calls a mock executor answers with, read off the stream it hands out. */
async function scriptedCalls(executor: { stream(...args: readonly unknown[]): unknown }): Promise<[string, string][]> {
  const stream = executor.stream({}) as { fullStream: AsyncIterable<{ type: string; toolCallId?: string; toolName?: string }> };
  const calls: [string, string][] = [];
  for await (const event of stream.fullStream) {
    if (event.type === "tool-call-streaming-start") calls.push([event.toolCallId ?? "", event.toolName ?? ""]);
  }
  return calls;
}

describe("the model a turn runs on", () => {
  it("answers with the saved selection when nothing else was said", () => {
    assert.deepEqual(resolveSlateRequestedModel({}), { modelId: SLATE_DEFAULT_MODEL_ID, maxMode: true, parameters: [...SLATE_DEFAULT_MODEL_SELECTION.parameters] });
    assert.equal(resolveSlateRequestedModel({}).modelId, "slate-4.5");
    const stored = { modelId: "saved-model", maxMode: false, parameters: [{ id: "effort", value: "low" }] };
    assert.deepEqual(resolveSlateRequestedModel({ storedDefaultModel: stored }), { modelId: "saved-model", maxMode: false, parameters: [{ id: "effort", value: "low" }] });
    // The parameters are copied, so a later change to the saved selection is nobody's business of this turn's.
    const requested = resolveSlateRequestedModel({ storedDefaultModel: stored });
    assert.equal(requested.parameters !== stored.parameters, true);
  });

  it("lets the environment override the saved selection, and the experiment override it", () => {
    const storedDefaultModel = selection("saved-model");
    const experimentModelOverride = selection("experiment-model");
    assert.equal(resolveSlateRequestedModel({ storedDefaultModel, envModelOverride: "environment-model" }).modelId, "environment-model");
    assert.equal(resolveSlateRequestedModel({ storedDefaultModel, experimentModelOverride }).modelId, "experiment-model");
    assert.equal(resolveSlateRequestedModel({ storedDefaultModel, envModelOverride: "environment-model", experimentModelOverride }).modelId, "environment-model");
  });

  it("answers for the platform's own subagents", () => {
    // A summarization session runs on the model it was opened with.
    assert.deepEqual(resolveSlateRequestedModel({ sessionOptions: { isSummarizationSession: true, modelId: "summarizer" } }), { modelId: "summarizer", maxMode: true });
    // A computer-use subagent takes the saved computer-use model, and the platform's own when none was saved.
    assert.equal(resolveSlateRequestedModel({ sessionOptions: { isComputerUseSubagent: true }, storedComputerUseModel: selection("saved-computer") }).modelId, "saved-computer");
    assert.equal(resolveSlateRequestedModel({ sessionOptions: { isComputerUseSubagent: true }, storedComputerUseModel: "not a selection" }).modelId, SLATE_COMPUTER_USE_SUBAGENT_MODEL_ID);
    const platformSelection = resolveSlateRequestedModel({ sessionOptions: { isComputerUseSubagent: true }, storedComputerUseModel: null });
    assert.deepEqual(platformSelection, { modelId: SLATE_COMPUTER_USE_MODEL_SELECTION.modelId, maxMode: SLATE_COMPUTER_USE_MODEL_SELECTION.maxMode, parameters: [...SLATE_COMPUTER_USE_MODEL_SELECTION.parameters] });
    // A browser-use subagent only takes a saved model when there is one; otherwise it is an ordinary turn.
    assert.equal(resolveSlateRequestedModel({ sessionOptions: { isBrowserUseSubagent: true }, storedBrowserUseModel: selection("saved-browser") }).modelId, "saved-browser");
    assert.equal(resolveSlateRequestedModel({ sessionOptions: { isBrowserUseSubagent: true }, storedBrowserUseModel: null, storedDefaultModel: selection("saved-default") }).modelId, "saved-default");
    // A session that named the model the host already uses is not a subagent model change: it answers as an
    // ordinary turn (with the saved parameters), not as a subagent (which carries a model and max mode only).
    assert.deepEqual(resolveSlateRequestedModel({ sessionOptions: { modelId: "saved-default" }, storedDefaultModel: { modelId: "saved-default", maxMode: true, parameters: [{ id: "effort", value: "low" }] } }), { modelId: "saved-default", maxMode: true, parameters: [{ id: "effort", value: "low" }] });
    assert.deepEqual(resolveSlateRequestedModel({ sessionOptions: { modelId: "other-model" }, storedDefaultModel: selection("saved-default") }), { modelId: "other-model", maxMode: true });
    // The environment's model counts as the host's own: a session naming it is the environment's turn, not a subagent.
    assert.deepEqual(resolveSlateRequestedModel({ sessionOptions: { modelId: "environment-model" }, storedDefaultModel: selection("saved-model"), envModelOverride: "environment-model" }), { modelId: "environment-model" });
  });
});

describe("a scripted mock response", () => {
  it("reads one message, or the tool calls it was given", () => {
    assert.deepEqual(parseSlateMockScript('{"sendMessage":"hello there"}'), { toolCalls: [{ toolName: "SendMessage", args: { type: "text", content: "hello there" } }] });
    assert.deepEqual(parseSlateMockScript('{"toolCalls":[{"toolName":"read","args":{"path":"/tmp/x"}},{"toolCallId":"call-1","toolName":"write","args":{}}]}'), {
      toolCalls: [{ toolName: "read", args: { path: "/tmp/x" } }, { toolCallId: "call-1", toolName: "write", args: {} }],
    });
  });

  it("refuses anything that is not a script, rather than guessing", () => {
    for (const raw of ["not json", "null", "[]", '"a string"', "42", '{"sendMessage":""}', "{}", '{"toolCalls":[]}', '{"toolCalls":"no"}', '{"toolCalls":[null]}', '{"toolCalls":[{"args":{}}]}', '{"toolCalls":[{"toolName":"","args":{}}]}', '{"toolCalls":[{"toolName":"read","args":[]}]}', '{"toolCalls":[{"toolName":"read","args":null}]}', '{"toolCalls":[{"toolName":"read","args":{},"toolCallId":""}]}', '{"toolCalls":[{"toolName":"read","args":{},"toolCallId":7}]}']) {
      assert.equal(parseSlateMockScript(raw), null, raw);
    }
  });

  it("answers with the scripted calls in order, and says nothing once the script ran out", async () => {
    const session = createScriptedMockSession({ toolCalls: [{ toolName: "first", args: { n: 1 } }, { toolCallId: "given", toolName: "second", args: { n: 2 } }] }, "mock-model");
    assert.equal(session.getModelId(), "mock-model");
    const executor = session.getExecutor();
    assert.deepEqual([await scriptedCalls(executor), await scriptedCalls(executor), await scriptedCalls(executor)], [
      [["mock-tool-1", "first"]],
      [["given", "second"]],
      [],
    ]);
  });
});

describe("the inference a host offers", () => {
  it("stands a mock response in for the model, so a turn can be driven without inference", async () => {
    process.env["SLATE_AGENT_MOCK_RESPONSE"] = '{"sendMessage":"scripted answer"}';
    const inference = createInference();
    const scripted = inference.createSession(() => {}, { modelId: "some-model" });
    assert.equal(scripted.getModelId(), "some-model");
    assert.deepEqual(await scriptedCalls(scripted.getExecutor()), [["mock-tool-1", "SendMessage"]]);
    // A response that is not a script is one answer, and a session with no model named is the mock's own.
    process.env["SLATE_AGENT_MOCK_RESPONSE"] = "just an answer";
    const plain = inference.createSession(() => {});
    assert.equal(plain.getModelId(), "slate-mock");
    assert.equal(await streamedText(plain.getExecutor()), "just an answer");
  });

  it("runs the turn through the provider the account chose, and through the platform's own when it chose that", () => {
    const root = join(scratch, "data-root");
    mkdirSync(root, { recursive: true });
    process.env["SLATE_DATA_ROOT"] = root;
    try {
      const inference = createInference();
      // No settings at all means the platform's own provider, and the platform's own session.
      const own = inference.createSession(() => {});
      assert.equal(typeof own.getModelId(), "string");
      // The account chose a provider that is not ours; the store is the same one the host reads it from, and the
      // model the routed provider carries is its own — which is how the session can be told from the platform's.
      new SlateSettingsStore(join(root, "settings.json")).setInferenceProvider("openrouter");
      process.env["SLATE_OPENROUTER_MODEL"] = "openai/routed-model";
      const routed = createInference();
      assert.equal(routed.createSession(() => {}).getModelId(), "openai/routed-model");
      assert.equal(routed.getAttachedMediaUrlProvider(), undefined);
      assert.equal(routed.getAttachedMediaUrlProvider() === undefined, true);
    } finally {
      delete process.env["SLATE_OPENROUTER_MODEL"];
      if (savedEnv.root === undefined) delete process.env["SLATE_DATA_ROOT"];
      else process.env["SLATE_DATA_ROOT"] = savedEnv.root;
    }
  });

  it("offers the attached-media provider only when the video API is on", () => {
    process.env["SLATE_DATA_ROOT"] = join(scratch, "empty-root");
    try {
      const off = createInference();
      const on = createInference({ isVideoAttachmentEnabled: () => true });
      assert.equal(off.getAttachedMediaUrlProvider(), undefined);
      assert.equal(on.getAttachedMediaUrlProvider() !== undefined, true);
    } finally {
      if (savedEnv.root === undefined) delete process.env["SLATE_DATA_ROOT"];
      else process.env["SLATE_DATA_ROOT"] = savedEnv.root;
    }
  });
});
