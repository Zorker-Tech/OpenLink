/** Translate resumed goal lifecycle changes into the generated state representation. */

import type { GoalState } from "../proto/generated/agent/v1/agent_pb.ts";
import { GoalStatus } from "../proto/generated/agent/v1/goal_tool_pb.ts";
import { goalClockOnActivation } from "../../../packages/agent-core/goal-continuation.ts";

export function isPausedGoalState(value: unknown): boolean {
  return typeof value === "object" && value !== null &&
    (value as { status?: unknown }).status === GoalStatus.PAUSED;
}

export function pauseGoalState(value: unknown): void {
  (value as GoalState).status = GoalStatus.PAUSED;
}

export function activatePausedGoalState(value: unknown, nowMs: number): unknown {
  const current = value as GoalState;
  const resumed = current.clone();
  resumed.status = GoalStatus.ACTIVE;
  resumed.idleContinuationsWithoutToolCalls = 0;
  Object.assign(resumed, goalClockOnActivation(resumed, nowMs));
  return resumed;
}
