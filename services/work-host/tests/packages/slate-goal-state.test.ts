import { test } from "node:test"
import assert from "node:assert/strict"

import {
  fromInteropGoalState,
  fromInteropPlanRegistryEntry,
  toInteropGoalState,
  toInteropPlanRegistryEntry,
} from "../../source/adapters/interop/agent/agent-state-message-serdes-adapter.ts"
import {
  GoalState,
  PlanRegistryEntry,
} from "../../source/adapters/interop/proto/generated/agent/v1/agent_pb.ts"
import { GoalStatus } from "../../source/adapters/interop/proto/generated/agent/v1/goal_tool_pb.ts"
import {
  SlateGoalState,
  pauseGoalState,
} from "../../source/packages/agent/goal-state.ts"
import { SlateGoalStatus } from "../../source/packages/agent-core/goal-continuation.ts"

test("goal state preserves its identity, status, clock and ownership", () => {
  const interop = new GoalState({
    conversationId: "conversation-1",
    goalId: "goal-1",
    objective: "ship",
    status: GoalStatus.ACTIVE,
    idleContinuationsWithoutToolCalls: 2,
    activeDurationMs: BigInt(30),
    lastAccruedAtMs: BigInt(40),
    continuationCount: 3,
    agentSessionId: "session-1",
  })
  const slate = fromInteropGoalState(interop)
  const roundTripped = toInteropGoalState(slate)

  assert.ok(slate instanceof SlateGoalState)
  assert.equal(slate.status, SlateGoalStatus.ACTIVE)
  assert.equal(roundTripped.conversationId, "conversation-1")
  assert.equal(roundTripped.objective, "ship")
  assert.equal(roundTripped.status, GoalStatus.ACTIVE)
  assert.equal(roundTripped.idleContinuationsWithoutToolCalls, 2)
  assert.equal(roundTripped.activeDurationMs, BigInt(30))
  assert.equal(roundTripped.lastAccruedAtMs, BigInt(40))
  assert.equal(roundTripped.continuationCount, 3)
  assert.equal(roundTripped.agentSessionId, "session-1")
})

test("an unknown persisted goal status maps to unspecified", () => {
  const slate = fromInteropGoalState(new GoalState({ status: 99 as GoalStatus }))

  assert.equal(slate.status, SlateGoalStatus.UNSPECIFIED)
  assert.equal(toInteropGoalState(slate).status, GoalStatus.UNSPECIFIED)

  pauseGoalState(slate)
  assert.equal(slate.status, SlateGoalStatus.PAUSED)
  assert.equal(toInteropGoalState(slate).status, GoalStatus.PAUSED)
})

test("a plan registry entry crosses the historical storage boundary as a plain Slate record", () => {
  const entry = { id: "plan-1", path: "/plans/plan.md" }
  const interop = toInteropPlanRegistryEntry(entry)

  assert.ok(interop instanceof PlanRegistryEntry)
  assert.deepEqual(fromInteropPlanRegistryEntry(interop), entry)
})
