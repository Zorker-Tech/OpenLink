/** Resume an explicitly paused goal when its owner sends a real message. */

import {
  activatePausedGoalState,
  isPausedGoalState,
} from "../../goal-state.ts";
import type { Context } from "../../../context/context.ts"
import type { SlateConversationState } from "../../conversation-state.ts"
import type { SlateGoalState } from "../../goal-state.ts"

type StateHandlerLike = {
  readonly goalState: SlateGoalState | undefined
  setGoalState(goalState: SlateGoalState): void
  computeNewStructure(ctx: Context): Promise<SlateConversationState>
}

export async function reactivatePausedGoalOnUserMessage(
  ctx: Context,
  stateHandler: StateHandlerLike,
  onStateUpdate: (ctx: Context, state: SlateConversationState) => Promise<void>,
): Promise<void> {
  const current = stateHandler.goalState
  if (!isPausedGoalState(current)) return

  const resumed = activatePausedGoalState(current, Date.now())
  stateHandler.setGoalState(resumed)
  await onStateUpdate(ctx, await stateHandler.computeNewStructure(ctx))
}
