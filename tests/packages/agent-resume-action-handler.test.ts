/**
 * The resume handler: its pending-tool-call early exits, turn validation, and the no-turn paths of the step handlers.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { ResumeActionHandler } from "../../source/packages/agent/actions/user-message-action/resume-action-handler.ts";
import { createContext } from "../../source/packages/context/context.ts";
import { AgentConversationTurnHandle } from "../../source/packages/agent/state.ts";

function stateHandler(options: Record<string, unknown> = {}) {
  return {
    getRawPendingMessages: () => options.messages ?? [],
    turns: options.turns ?? [],
    getPrivacyMode: () => "NO_STORAGE",
    getBlobStore: () => ({}),
    computeNewStructure: async () => ({ computed: true }),
  };
}
function instance(calls: unknown[] = []): Record<string, any> {
  const handler = Object.create(ResumeActionHandler.prototype) as Record<string, any>;
  handler.config = { toolsGenerator: () => ({ getStaticTools: () => [], getToolExecutionSet: () => ({}) }), thinkingStyle: "x", featureFlags: {} };
  handler.interactionListener = {};
  handler.resourceAccessor = { get: () => undefined };
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
  assert.equal(await instance().executePendingToolCalls(ctx, stateHandler({ messages: [{ unwrap: () => "{}" }], turns: [] }), {}, {}, "inv"), false);
});

test("a last turn that is not an agent turn is refused", async () => {
  const ctx = createContext();
  await assert.rejects(
    () => instance().executePendingToolCalls(ctx, stateHandler({ messages: [{ unwrap: () => "{}" }], turns: [{ get: async () => ({}) }] }), {}, {}, "inv"),
    /Expected last turn to be an agent turn/,
  );
});

test("a pending message that is not an assistant message is refused", async () => {
  const ctx = createContext();
  await assert.rejects(
    () => instance().executePendingToolCalls(ctx, stateHandler({ messages: [{ unwrap: () => JSON.stringify({ role: "user", content: [] }) }], turns: [{ get: async () => turnHandle() }] }), {}, {}, "inv"),
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
    /execute/,
  );
});
