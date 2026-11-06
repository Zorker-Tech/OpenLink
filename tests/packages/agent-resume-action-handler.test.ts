/**
 * The resume handler: its pending-tool-call early exits, turn validation, and the no-turn paths of the step handlers.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { ResumeActionHandler } from "../../source/packages/agent/actions/user-message-action/resume-action-handler.ts";
import { createContext } from "../../source/packages/context/context.ts";
import { AgentConversationTurnHandle } from "../../source/packages/agent/state.ts";
import { AgentMode } from "../../source/adapters/interop/proto/generated/agent/v1/agent_pb.ts";
import { SlateMode } from "../../source/packages/agent/mode-processing.ts";
import { RequestContext, RequestContextResult, RequestContextSuccess } from "../../source/adapters/interop/proto/generated/agent/v1/request_context_exec_pb.ts";

function stateHandler(options: Record<string, unknown> = {}) {
  return {
    getPendingToolCalls: () => options.messages ?? [],
    turns: options.turns ?? [],
    getPrivacyMode: () => "NO_STORAGE",
    getBlobStore: () => ({}),
    computeNewStructure: async () => ({ computed: true }),
  };
}
function instance(calls: unknown[] = []): Record<string, any> {
  const handler = Object.create(ResumeActionHandler.prototype) as Record<string, any>;
  handler.config = { toolsGenerator: () => ({ getStaticTools: () => [], getToolExecutionSet: () => ({ modelVisibleTools: [], additionalExecutableTools: [] }) }), thinkingStyle: "x", featureFlags: {} };
  handler.interactionListener = {};
  handler.resourceAccessor = { get: () => ({ async execute() { return new RequestContextResult({ result: { case: "success", value: new RequestContextSuccess({ requestContext: new RequestContext() }) } }); } }) };
  handler.mergeRequestContextTools = () => ({ merged: true });
  handler.resolveWriteBarrierTimeoutMs = () => 7;
  handler.runTurnLoop = async (...args: unknown[]) => { calls.push(["runTurnLoop", args.length]); };
  handler.runSingleStep = async (...args: unknown[]) => { calls.push(["runSingleStep", args.length]); return { hasToolCall: true }; };
  handler.runModelStep = async (...args: unknown[]) => { calls.push(["runModelStep", args.length]); return { toolCallDescriptors: ["d"], splitStepData: { modelResponseMessages: ["m"] } }; };
  return handler;
}
const action = () => ({ requestContext: undefined });

test("nothing pending or no turns means nothing to execute", async () => {
  const ctx = createContext();
  assert.equal(await instance().executePendingToolCalls(ctx, stateHandler(), {}, {}, "inv"), false);
  assert.equal(await instance().executePendingToolCalls(ctx, stateHandler({ messages: ["{}"], turns: [] }), {}, {}, "inv"), false);
});

test("a last turn that is not an agent turn is refused", async () => {
  const ctx = createContext();
  await assert.rejects(
    () => instance().executePendingToolCalls(ctx, stateHandler({ messages: ["{}"], turns: [{ get: async () => ({}) }] }), {}, {}, "inv"),
    /Expected last turn to be an agent turn/,
  );
});

test("a pending message that is not an assistant message is refused", async () => {
  const ctx = createContext();
  await assert.rejects(
    () => instance().executePendingToolCalls(ctx, stateHandler({ messages: [JSON.stringify({ role: "user", content: [] })], turns: [{ get: async () => turnHandle() }] }), {}, {}, "inv"),
    /No assistant message to resume from/,
  );
});
function turnHandle(): unknown {
  const turn = Object.create(AgentConversationTurnHandle.prototype) as Record<string, unknown>;
  turn.userMessage = { get: async () => ({ mode: "user-message" }) };
  return turn;
}

test("the setup step refuses a non-agent last turn", async () => {
  const ctx = createContext();
  await assert.rejects(
    () => instance().setupResumeStep(ctx, action(), stateHandler({ turns: [{ get: async () => ({}) }] }), {}),
    /Expected last turn to be an agent turn/,
  );
});

function realTurn(append: unknown[], mode: unknown = "user-message"): unknown {
  const turn = Object.create(AgentConversationTurnHandle.prototype) as Record<string, any>;
  turn.userMessage = { get: async () => ({ mode }) };
  turn.appendPromptMessages = (messages: unknown) => { append.push(messages); };
  return turn;
}
function resumeInput(content: unknown, contracts?: Record<string, unknown>) {
  const assistant = { role: "assistant", content, ...(contracts === undefined ? {} : { providerOptions: { cursor: { pendingToolExecutionContracts: contracts } } }) };
  return JSON.stringify(assistant);
}
const tool = { name: "outer", toolIdentifier: "outer", execute: async () => ({ content: [] }) };

test("a pending tool call whose admitted identity changed gets the mismatch answer instead of running", async () => {
  const ctx = createContext();
  const appended: unknown[] = [];
  const scoped: unknown[] = [];
  const handler = instance();
  handler.config.toolsGenerator = () => ({
    getStaticTools: () => [tool],
    getToolExecutionSet: (tools: unknown[]) => { scoped.push(tools.map((entry) => (entry as { name: string }).name)); return { modelVisibleTools: tools, additionalExecutableTools: [] }; },
  });
  const turn = realTurn(appended);
  const state = stateHandler({
    messages: [resumeInput([{ type: "tool-call", toolCallId: "call-1", toolName: "outer", args: {} }], { "call-1": { toolCallId: "call-1", outerToolName: "outer", toolIdentifier: "outer", isDynamic: false, allowedToolNames: ["outer"], effectiveToolName: "inner" } })],
    turns: [{ get: async () => turn }],
  });
  assert.equal(await handler.executePendingToolCalls(ctx, state, {}, { repositoryInfo: [] }, "inv"), true);
  assert.deepEqual(scoped, [["outer"]]);
  assert.equal(appended.length, 1);
  assert.match(JSON.stringify(appended), /contract mismatch/);
});

test("an assistant message without tool calls resumes with nothing to execute", async () => {
  const ctx = createContext();
  const appended: unknown[] = [];
  const handler = instance();
  const turn = realTurn(appended);
  const state = stateHandler({ messages: [resumeInput("plain answer")], turns: [{ get: async () => turn }] });
  assert.equal(await handler.executePendingToolCalls(ctx, state, {}, { repositoryInfo: [] }, "inv"), true);
  assert.equal(appended.length, 1);
});

test("a resumed turn gives its tools the mode stored on the user message", async () => {
  const ctx = createContext();
  const modes: unknown[] = [];
  const handler = instance();
  handler.config.toolsGenerator = (options: { mode?: unknown }) => {
    modes.push(options.mode);
    return {
      getStaticTools: () => [],
      getToolExecutionSet: () => ({ modelVisibleTools: [], additionalExecutableTools: [] }),
    };
  };
  const turn = realTurn([], AgentMode.PLAN);
  const state = stateHandler({
    messages: [resumeInput("plain answer")],
    turns: [{ get: async () => turn }],
  });

  assert.equal(await handler.executePendingToolCalls(ctx, state, {}, { repositoryInfo: [] }, "inv"), true);
  assert.deepEqual(modes, [SlateMode.PLAN]);
});

test("a turn that is present is resumed through the loop", async () => {
  const ctx = createContext();
  const calls: unknown[] = [];
  const handler = instance(calls);
  const turn = realTurn([]);
  const state = stateHandler({ turns: [{ get: async () => turn }] });
  const result = await handler.handle(ctx, action(), {}, state, {}, async () => undefined);
  assert.deepEqual(result, { computed: true });
  assert.deepEqual(calls.map((call) => (call as unknown[])[0]), ["runTurnLoop"]);
});

test("a turn that is present is set up for the single-step and model-step entries", async () => {
  const ctx = createContext();
  const calls: unknown[] = [];
  const handler = instance(calls);
  const turn = realTurn([]);
  const state = stateHandler({ turns: [{ get: async () => turn }] });
  const setup = await handler.setupResumeStep(ctx, action(), state, {});
  assert.equal(setup.turn, turn);
  assert.equal(setup.requestContextProvenance, "executorFetched");
  const single = await handler.handleSingleStep(ctx, action(), {}, state, {}, async () => undefined);
  assert.deepEqual(single, { state: { computed: true }, hasToolCall: true });
  const model = await handler.handleModelStep(ctx, action(), {}, state, {}, async () => undefined);
  assert.deepEqual(model.toolCallDescriptors, ["d"]);
  assert.deepEqual(model.splitStepData.modelResponseMessages, ["m"]);
  assert.equal(typeof model.splitStepData.requestContextProvenance, "string");
  assert.equal(calls.filter((call) => (call as unknown[])[0] === "runTurnLoop").length, 0);
});

test("the no-turn entries answer without touching the loop", async () => {
  const ctx = createContext();
  const calls: unknown[] = [];
  const handler = instance(calls);
  const state = stateHandler();
  assert.deepEqual(await handler.setupResumeStep(ctx, action(), state, {}), { noTurns: true });
  assert.deepEqual(await handler.handleSingleStep(ctx, action(), {}, state, {}, async () => undefined), { state: { computed: true }, hasToolCall: false });
  const model = await handler.handleModelStep(ctx, action(), {}, state, {}, async () => undefined);
  assert.deepEqual(model.toolCallDescriptors, []);
  assert.deepEqual(calls, []);
});
