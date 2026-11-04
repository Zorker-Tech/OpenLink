import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SlateGoalState } from "../../source/packages/agent/goal-state.ts";
import { SlateGoalStatus } from "../../source/packages/agent-core/goal-continuation.ts";
import { createContext } from "../../source/packages/context/context.ts";
import { reactivatePausedGoalOnUserMessage } from "../../source/packages/agent/actions/user-message-action/reactivate-paused-goal.ts";

function buildStateHandler(goalState: SlateGoalState | undefined) {
  const events: unknown[] = [];
  let current = goalState;
  const structure = { revision: 7 };
  return {
    events,
    structure,
    get goalState() { return current; },
    setGoalState(next: SlateGoalState) {
      events.push(["set", next]);
      current = next;
    },
    async computeNewStructure() {
      events.push(["compute"]);
      return structure;
    },
  };
}

describe("paused goal reactivation contract", () => {
  it("activates a paused goal, resets its idle streak, and publishes the new structure", async () => {
    const previousNow = Date.now;
    Date.now = () => 9_000;
    try {
      const original = new SlateGoalState({
        conversationId: "",
        goalId: "goal-1",
        objective: "",
        status: SlateGoalStatus.PAUSED,
        idleContinuationsWithoutToolCalls: 5,
        continuationCount: 0,
        activeDurationMs: 1_250n,
        lastAccruedAtMs: 4_000n,
      });
      const state = buildStateHandler(original);
      const updates: unknown[] = [];

      await reactivatePausedGoalOnUserMessage(
        createContext(),
        state,
        async (_context, structure) => {
          state.events.push(["update", structure]);
          updates.push(structure);
        },
      );

      const resumed = state.goalState;
      assert.ok(resumed);
      assert.notEqual(resumed, original);
      assert.equal(original.status, SlateGoalStatus.PAUSED);
      assert.equal(original.idleContinuationsWithoutToolCalls, 5);
      assert.equal(resumed.status, SlateGoalStatus.ACTIVE);
      assert.equal(resumed.idleContinuationsWithoutToolCalls, 0);
      assert.equal(resumed.activeDurationMs, 1_250n);
      assert.equal(resumed.lastAccruedAtMs, 9_000n);
      assert.deepEqual(updates, [state.structure]);
      assert.deepEqual(state.events.map((event) => Array.isArray(event) ? event[0] : event), ["set", "compute", "update"]);
    } finally {
      Date.now = previousNow;
    }
  });

  it("leaves an active goal alone", async () => {
    const current = new SlateGoalState({
      conversationId: "",
      goalId: "goal-2",
      objective: "",
      status: SlateGoalStatus.ACTIVE,
      idleContinuationsWithoutToolCalls: 2,
      continuationCount: 0,
    });
    const state = buildStateHandler(current);
    const updates: unknown[] = [];

    await reactivatePausedGoalOnUserMessage(createContext(), state, async (_context, value) => { updates.push(value); });

    assert.equal(state.goalState, current);
    assert.deepEqual(state.events, []);
    assert.deepEqual(updates, []);
  });

  it("does nothing when no goal is stored", async () => {
    const state = buildStateHandler(undefined);
    const updates: unknown[] = [];

    await reactivatePausedGoalOnUserMessage(createContext(), state, async (_context, value) => { updates.push(value); });

    assert.equal(state.goalState, undefined);
    assert.deepEqual(state.events, []);
    assert.deepEqual(updates, []);
  });
});
