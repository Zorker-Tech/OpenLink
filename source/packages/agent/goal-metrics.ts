/**
 * How durable goals are counted.
 *
 * A goal outlives turns, so its metrics are the only way to see how much work it is actually causing:
 * how many continuations started, and — when one finally stops being active — how many continuations it
 * took to get there. The status and the reason are labels rather than a single "stopped" counter, because
 * a goal that was completed and one that was abandoned are the same event with very different meanings.
 */

import type { Context } from "../context/context.ts"
import { createCounter, createHistogram } from "../metrics/index.ts"

interface GoalTerminalTransitionInput {
  readonly status: string
  readonly reason: string
  readonly continuationCount: number
}

const goalContinuationStarted = createCounter("agent.goal.continuation.started", {
  description: "Counts durable goal continuation turns that started",
})
const goalTerminalTransition = createCounter("agent.goal.terminal_transition", {
  description: "Counts durable goals transitioning out of active status",
  labelNames: ["status", "reason"],
})
const goalContinuationsAtTerminal = createHistogram("agent.goal.continuations_at_terminal", {
  description: "Total continuation turns started when a durable goal transitions out of active status",
  labelNames: ["status", "reason"],
})

export function recordGoalContinuationStarted(ctx: Context): void {
  goalContinuationStarted.increment(ctx)
}

export function recordGoalTerminalTransition(ctx: Context, options: GoalTerminalTransitionInput): void {
  const labels = { status: options.status, reason: options.reason }
  goalTerminalTransition.increment(ctx, 1, labels)
  goalContinuationsAtTerminal.histogram(ctx, options.continuationCount, labels)
}
