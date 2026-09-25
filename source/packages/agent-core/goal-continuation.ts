/**
 * How long a goal has been worked on, and whether a stored goal is still the one in play.
 *
 * A goal outlives turns, so its clock is kept as time already accrued plus the moment the current
 * stretch started: while it is active the elapsed time grows with the wall clock, and when it is
 * deactivated the accrued total is frozen. Identity is checked the same way — a goal belongs to the
 * conversation that owns it, and to the agent session that created it when it names one — which is
 * what stops a resumed conversation from adopting someone else's goal.
 */

export const GOAL_STATUS_ACTIVE = 1
export const GOAL_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface GoalState {
  activeDurationMs?: bigint
  lastAccruedAtMs?: bigint
  status?: number
  goalId: string
  conversationId?: string
  agentSessionId?: string
}

export function goalWorkedMs(goalState: GoalState | null | undefined): number {
  return Number(goalState?.activeDurationMs ?? BigInt(0))
}

/** Accrued time plus the current stretch, which is zero-length when nothing is anchored. */
export function goalElapsedMsFrom(accruedMs: number, accrualAnchorMs: number | undefined, nowMs: number): number {
  return accrualAnchorMs === undefined ? accruedMs : accruedMs + Math.max(0, nowMs - accrualAnchorMs)
}

export function goalElapsedMs(goalState: GoalState | null | undefined, nowMs: number): number {
  return goalElapsedMsFrom(
    goalWorkedMs(goalState),
    goalState?.lastAccruedAtMs === undefined ? undefined : Number(goalState.lastAccruedAtMs),
    nowMs,
  )
}

export function goalClockOnActivation(
  goalState: GoalState | null | undefined,
  nowMs: number,
): { activeDurationMs: bigint; lastAccruedAtMs: bigint } {
  return { activeDurationMs: goalState?.activeDurationMs ?? BigInt(0), lastAccruedAtMs: BigInt(nowMs) }
}

export function goalClockOnDeactivation(
  goalState: GoalState | null | undefined,
  nowMs: number,
): { activeDurationMs: bigint; lastAccruedAtMs: undefined } {
  return { activeDurationMs: BigInt(goalElapsedMs(goalState, nowMs)), lastAccruedAtMs: undefined }
}

/** A goal without an owner is anyone's; a goal with one belongs to that session. */
export function isGoalOwnerValid(goalState: GoalState, agentSessionId: string | undefined): boolean {
  return goalState.agentSessionId === undefined ||
    (goalState.agentSessionId.length > 0 &&
      agentSessionId !== undefined &&
      agentSessionId.length > 0 &&
      goalState.agentSessionId === agentSessionId)
}

export function isGoalIdentityValid(
  goalState: GoalState,
  identity: { conversationId: string; agentSessionId?: string },
): boolean {
  return goalState.agentSessionId === undefined
    ? goalState.conversationId === identity.conversationId
    : isGoalOwnerValid(goalState, identity.agentSessionId)
}

/** The whole check a resumed conversation makes before it continues someone's goal. */
export function isGoalStateShapeValid(
  goalState: GoalState | undefined,
  identity: { conversationId: string; agentSessionId?: string },
): boolean {
  return goalState !== undefined &&
    isGoalIdentityValid(goalState, identity) &&
    goalState.status === GOAL_STATUS_ACTIVE &&
    GOAL_ID_PATTERN.test(goalState.goalId)
}
