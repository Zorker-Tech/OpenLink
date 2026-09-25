/**
 * What a user message does to a paused goal.
 *
 * A goal that was paused was paused by the user, and a new message from that user is them coming back to
 * it — so the goal resumes rather than staying paused until they say so explicitly. Resuming means the
 * status goes back to active, the count of continuations that produced nothing is cleared (it was about
 * the previous stretch of work), and the clock is anchored again so the time the goal spent paused is not
 * counted as work. A goal that is not paused is left exactly as it is.
 */

import { GoalStatus } from "../../../proto/generated/agent/v1/goal_tool_pb.ts"
import type { GoalState } from "../../../proto/generated/agent/v1/agent_pb.ts"
import type { Context } from "../../../context/context.ts"
import { goalClockOnActivation } from "../../../agent-core/goal-continuation.ts"

type StateHandlerLike = {
  readonly goalState: GoalState | undefined
  setGoalState(goalState: GoalState): void
  computeNewStructure(ctx: Context): Promise<unknown>
}

export async function reactivatePausedGoalOnUserMessage(
  ctx: Context,
  stateHandler: StateHandlerLike,
  onStateUpdate: (ctx: Context, state: unknown) => Promise<void>,
): Promise<void> {
  const current = stateHandler.goalState
  if (current === undefined || current.status !== GoalStatus.PAUSED) return
  const resumed = current.clone()
  resumed.status = GoalStatus.ACTIVE
  resumed.idleContinuationsWithoutToolCalls = 0
  Object.assign(resumed, goalClockOnActivation(resumed, Date.now()))
  stateHandler.setGoalState(resumed)
  await onStateUpdate(ctx, await stateHandler.computeNewStructure(ctx))
}
