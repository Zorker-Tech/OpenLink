import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createContext, type Context } from "../../source/packages/context/context.ts";
import { conversationIdKey } from "../../source/packages/agent/utils/request-scope.ts";
import { GoalContinuationActionHandler } from "../../source/packages/agent/actions/goal-continuation-action-handler.ts";
import { GoalState, SimulatedMsgReason } from "../../source/packages/proto/generated/agent/v1/agent_pb.ts";
import { GoalStatus } from "../../source/packages/proto/generated/agent/v1/goal_tool_pb.ts";
import { PrivacyMode } from "../../source/packages/redaction/privacy-mode.ts";

const GOAL_ID = "123e4567-e89b-42d3-a456-426614174000";
const baseCtx = () => createContext().with(conversationIdKey, "conv-1");
const activeGoal = (overrides: Record<string, unknown> = {}) => new GoalState({
  goalId: GOAL_ID,
  status: GoalStatus.ACTIVE,
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
    mode: 1,
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
    assert.equal(await instance.adaptAction(ctx, stateHandler(activeGoal({ status: GoalStatus.PAUSED })).state, undefined, publish), undefined);
    const withoutConversation = instance;
    assert.equal(await withoutConversation.adaptAction(createContext(), stateHandler(activeGoal()).state, undefined, publish), undefined);
  });

  it("pauses a goal that kept continuing without tool calls", async () => {
    const { instance } = handler();
    const ctx = baseCtx();
    const harness = stateHandler(activeGoal({ idleContinuationsWithoutToolCalls: 3 }));
    const result = await instance.adaptAction(ctx, harness.state, undefined, publish);
    assert.equal(result, undefined);
    const written = harness.written[0] as GoalState;
    assert.equal(written.status, GoalStatus.PAUSED);
    assert.equal(written.lastAccruedAtMs, undefined);
  });

  it("continues a goal and builds the synthetic wakeup message", async () => {
    const { instance } = handler();
    const ctx = baseCtx();
    const harness = stateHandler(activeGoal({ activeDurationMs: BigInt(0), lastAccruedAtMs: BigInt(Date.now() - 1_000) }));
    const action = await instance.adaptAction(ctx, harness.state, undefined, publish);
    const written = harness.written[0] as GoalState;
    assert.equal(written.continuationCount, 1);
    assert.equal(written.idleContinuationsWithoutToolCalls, 1);
    assert.equal(written.activeDurationMs! > BigInt(0), true);
    assert.equal(typeof written.lastAccruedAtMs, "bigint");
    assert.notEqual(action.userMessage, undefined);
    assert.equal((action.userMessage as any).isSimulatedMsg, true);
    assert.equal((action.userMessage as any).simulatedMsgReason, SimulatedMsgReason.GOAL_CONTINUATION);
    assert.equal(action.sendToInteractionListener, true);
  });

  it("clears the idle streak only when there is one", async () => {
    const { instance } = handler();
    const ctx = baseCtx();
    const absent = stateHandler(activeGoal());
    assert.equal(await instance.clearIdleContinuationStreak(ctx, absent.state, publish), undefined);
    const present = stateHandler(activeGoal({ idleContinuationsWithoutToolCalls: 2 }));
    const published: unknown[] = [];
    const structure = await instance.clearIdleContinuationStreak(ctx, present.state, async (_ctx: unknown, value: unknown) => { published.push(value); });
    assert.equal((present.written[0] as GoalState).idleContinuationsWithoutToolCalls, 0);
    assert.notEqual(structure, undefined);
    assert.equal(published.length, 1);
  });

  it("returns the new structure when there is nothing to continue", async () => {
    const { instance } = handler();
    const ctx = baseCtx();
    const result = await instance.handle(ctx, undefined, {} as never, stateHandler(undefined).state, undefined, publish);
    assert.equal((result as any).structure, 0);
    const single = await instance.handleSingleStep(ctx, undefined, {} as never, stateHandler(undefined).state, undefined, publish);
    assert.equal((single as any).hasToolCall, false);
    const model = await instance.handleModelStep(ctx, undefined, {} as never, stateHandler(undefined).state, undefined, publish);
    assert.equal((model as any).splitStepData.goalContinuationNoop, true);
  });

  it("reports the tool names the session spells them with", () => {
    const { instance } = handler();
    const ctx = baseCtx();
    const names = instance.currentToolNames(ctx, stateHandler(activeGoal()).state, undefined);
    assert.deepEqual(names, { todoWriteToolName: "todo_write", updateGoalToolName: "update_goal" });
  });
});
