/** Resume an explicitly paused goal when its owner sends a real message. */

import {
  activatePausedGoalState,
  isPausedGoalState,
} from "../../goal-state.ts";
import type { Context } from "../../../context/context.ts"

type StateHandlerLike = {
  readonly goalState: unknown
  setGoalState(goalState: unknown): void
  computeNewStructure(ctx: Context): Promise<unknown>
}

export async function reactivatePausedGoalOnUserMessage(
  ctx: Context,
  stateHandler: StateHandlerLike,
  onStateUpdate: (ctx: Context, state: unknown) => Promise<void>,
): Promise<void> {
  const current = stateHandler.goalState
  if (!isPausedGoalState(current)) return

  const resumed = activatePausedGoalState(current, Date.now())
  stateHandler.setGoalState(resumed)
  await onStateUpdate(ctx, await stateHandler.computeNewStructure(ctx))
}
