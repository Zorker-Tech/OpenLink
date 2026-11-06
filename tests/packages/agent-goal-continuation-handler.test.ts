import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createContext, type Context } from "../../source/packages/context/context.ts";
import { conversationIdKey } from "../../source/packages/agent/utils/request-scope.ts";
import { GoalContinuationActionHandler } from "../../source/packages/agent/actions/goal-continuation-action-handler.ts";
import { createSlateGoalContinuationActionPayload } from "../../source/packages/agent/actions/goal-continuation-contracts.ts";
import type { SlateUserMessageActionPayload } from "../../source/packages/agent/agent-action-state.ts";
import { SlateSimulatedMessageReason } from "../../source/packages/agent/user-message-state.ts";
import { PrivacyCapability } from "../../source/packages/redaction/classification.ts";
import { PrivacyMode } from "../../source/packages/redaction/privacy-mode.ts";
import { SlateMode } from "../../source/packages/agent/mode-processing.ts";
import { SlateGoalState } from "../../source/packages/agent/goal-state.ts";
import { SlateGoalStatus } from "../../source/packages/agent-core/goal-continuation.ts";

const GOAL_ID = "123e4567-e89b-42d3-a456-426614174000";
const baseCtx = () => createContext().with(conversationIdKey, "conv-1");
const activeGoal = (overrides: Record<string, unknown> = {}) => new SlateGoalState({
  goalId: GOAL_ID,
  status: SlateGoalStatus.ACTIVE,
  objective: "ship the thing",
  conversationId: "conv-1",
  continuationCount: 0,
  idleContinuationsWithoutToolCalls: 0,
  ...overrides,
}) as never;
function stateHandler(goal: unknown, overrides: Record<string, unknown> = {}) {
  const written: unknown[] = [];
  const published: unknown[] = [];
  const state: any = {
    goalState: goal,
    mode: SlateMode.AGENT,
    getPrivacyMode: () => PrivacyMode.NO_STORAGE,
    getBlobStore: () => ({}),
    setGoalState: (value: unknown) => written.push(value),
    computeNewStructure: async (ctx: Context) => ({ structure: published.length + written.length, ctx: ctx !== undefined }),
    ...overrides,
  };
  return { state, written, published };
}
function handler(tools: any = { TODO_WRITE: { name: "todo_write" }, UPDATE_GOAL: { name: "update_goal" } }, actionResult: any = {}) {
  const calls: any[] = [];
  const userMessageActionHandler = {
    handle: async (...args: unknown[]) => { calls.push(["handle", args[1]]); return actionResult.handle ?? { state: "after" }; },
    handleSingleStep: async (...args: unknown[]) => { calls.push(["single", args[1]]); return actionResult.single ?? { state: "after-single", hasToolCall: false }; },
    handleModelStep: async (...args: unknown[]) => { calls.push(["model", args[1]]); return actionResult.model ?? { state: "after-model", toolCallDescriptors: [] }; },
  };
  const instance = new GoalContinuationActionHandler(
    userMessageActionHandler as never,
    ((props: unknown) => { calls.push(["tools", props]); return { getTool: (key: string) => tools[key] }; }) as never,
    {} as never,
    "session-1",
  );
  return { instance, calls };
}
const publish = async (ctx: unknown, structure: unknown) => ({ publishedCalls: [structure] });

describe("the goal continuation handler", () => {
  it("does not continue a goal that is not this conversation’s or is not active", async () => {
    const { instance } = handler();
    const ctx = baseCtx();
    assert.equal(await instance.adaptAction(ctx, stateHandler(undefined).state, undefined, publish), undefined);
    assert.equal(await instance.adaptAction(ctx, stateHandler(activeGoal({ conversationId: "other" })).state, undefined, publish), undefined);
    assert.equal(await instance.adaptAction(ctx, stateHandler(activeGoal({ status: SlateGoalStatus.PAUSED })).state, undefined, publish), undefined);
    const withoutConversation = instance;
    assert.equal(await withoutConversation.adaptAction(createContext(), stateHandler(activeGoal()).state, undefined, publish), undefined);
  });

  it("pauses a goal that kept continuing without tool calls", async () => {
    const { instance } = handler();
    const ctx = baseCtx();
    const harness = stateHandler(activeGoal({ idleContinuationsWithoutToolCalls: 3 }));
    const result = await instance.adaptAction(ctx, harness.state, undefined, publish);
    assert.equal(result, undefined);
    const written = harness.written[0] as SlateGoalState;
    assert.equal(written.status, SlateGoalStatus.PAUSED);
    assert.equal(written.lastAccruedAtMs, undefined);
  });

  it("continues a goal and builds the synthetic wakeup message", async () => {
    const { instance } = handler();
    const ctx = baseCtx();
    const harness = stateHandler(activeGoal({ activeDurationMs: BigInt(0), lastAccruedAtMs: BigInt(Date.now() - 1_000) }));
    const action = await instance.adaptAction(ctx, harness.state, undefined, publish) as SlateUserMessageActionPayload;
    const written = harness.written[0] as SlateGoalState;
    assert.equal(written.continuationCount, 1);
    assert.equal(written.idleContinuationsWithoutToolCalls, 1);
    assert.equal(written.activeDurationMs! > BigInt(0), true);
    assert.equal(typeof written.lastAccruedAtMs, "bigint");
    assert.equal(action.schema, "slate.agent-action.user-message");
    assert.equal(action.message?.mode, SlateMode.AGENT);
    assert.equal(action.message?.isSimulatedMsg, true);
    assert.equal(action.message?.simulatedMsgReason, SlateSimulatedMessageReason.GOAL_CONTINUATION);
    assert.equal(action.notifyUser, true);
    assert.deepEqual(action.earlierMessages, []);
    const messageText = action.message?.text;
    assert.ok(messageText !== undefined);
    const text = typeof messageText === "string"
      ? messageText
      : messageText.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED);
    assert.match(text, /<objective>\nship the thing\n<\/objective>/);
  });

  it("clears the idle streak only when there is one", async () => {
    const { instance } = handler();
    const ctx = baseCtx();
    const absent = stateHandler(activeGoal());
    assert.equal(await instance.clearIdleContinuationStreak(ctx, absent.state, publish), undefined);
    const present = stateHandler(activeGoal({ idleContinuationsWithoutToolCalls: 2 }));
    const published: unknown[] = [];
    const structure = await instance.clearIdleContinuationStreak(ctx, present.state, async (_ctx: unknown, value: unknown) => { published.push(value); });
    assert.equal((present.written[0] as SlateGoalState).idleContinuationsWithoutToolCalls, 0);
    assert.notEqual(structure, undefined);
    assert.equal(published.length, 1);
  });

  it("returns the new structure when there is nothing to continue", async () => {
    const { instance } = handler();
    const ctx = baseCtx();
    const result = await instance.handle(ctx, createSlateGoalContinuationActionPayload(), {} as never, stateHandler(undefined).state, undefined, publish);
    assert.equal((result as any).structure, 0);
    const single = await instance.handleSingleStep(ctx, createSlateGoalContinuationActionPayload(), {} as never, stateHandler(undefined).state, undefined, publish);
    assert.equal((single as any).hasToolCall, false);
    const model = await instance.handleModelStep(ctx, createSlateGoalContinuationActionPayload(), {} as never, stateHandler(undefined).state, undefined, publish);
    assert.equal((model as any).splitStepData.goalContinuationNoop, true);
  });

  it("reports the tool names the session spells them with", () => {
    const { instance } = handler();
    const ctx = baseCtx();
    const names = instance.currentToolNames(ctx, stateHandler(activeGoal()).state, undefined);
    assert.deepEqual(names, { todoWriteToolName: "todo_write", updateGoalToolName: "update_goal" });
  });
});
