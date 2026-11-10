/**
 * How long a goal has been worked on, and whether a stored goal is still the one in play.
 *
 * A goal outlives turns, so its clock is kept as time already accrued plus the moment the current
 * stretch started: while it is active the elapsed time grows with the wall clock, and when it is
 * deactivated the accrued total is frozen. Identity is checked the same way — a goal belongs to the
 * conversation that owns it, and to the agent session that created it when it names one — which is
 * what stops a resumed conversation from adopting someone else's goal.
 */

export const SlateGoalStatus = {
  UNSPECIFIED: "unspecified",
  ACTIVE: "active",
  PAUSED: "paused",
  COMPLETE: "complete",
  CLEARED: "cleared",
} as const;

export type SlateGoalStatus = (typeof SlateGoalStatus)[keyof typeof SlateGoalStatus];

/** The status a goal has while it is being worked on. */
export const GOAL_STATUS_ACTIVE = SlateGoalStatus.ACTIVE;

/** The id a goal is stored under: a uuid-shaped id, in either case. */
export const GOAL_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What a stored goal carries: its identity, the status it was last left in, and its clock. */
export interface GoalState {
  activeDurationMs?: bigint | undefined;
  lastAccruedAtMs?: bigint | undefined;
  status?: SlateGoalStatus;
  goalId: string;
  conversationId?: string;
  agentSessionId?: string | undefined;
}

/** A goal that has never accrued anything. */
const NO_ACCRUED_MS = BigInt(0);

/** The time this goal was worked on before the current stretch, in milliseconds. */
export function goalWorkedMs(goal: GoalState | null | undefined): number {
  return Number(goal?.activeDurationMs ?? NO_ACCRUED_MS);
}

/** Accrued time plus the current stretch, which is zero-length while nothing is anchored. */
export function goalElapsedMsFrom(accruedMs: number, accrualAnchorMs: number | undefined, nowMs: number): number {
  if (accrualAnchorMs === undefined) return accruedMs;
  return accruedMs + Math.max(0, nowMs - accrualAnchorMs);
}

/** The time this goal has been worked on, counting the current stretch when one is anchored. */
export function goalElapsedMs(goal: GoalState | null | undefined, nowMs: number): number {
  const anchor = goal?.lastAccruedAtMs;
  return goalElapsedMsFrom(goalWorkedMs(goal), anchor === undefined ? undefined : Number(anchor), nowMs);
}

/** The clock to store when a goal starts a stretch: what was accrued, and the moment it started. */
export function goalClockOnActivation(goal: GoalState | null | undefined, nowMs: number): { activeDurationMs: bigint; lastAccruedAtMs: bigint } {
  const activeDurationMs = goal?.activeDurationMs ?? NO_ACCRUED_MS;
  return { activeDurationMs, lastAccruedAtMs: BigInt(nowMs) };
}

/** The clock to store when a goal stops: the stretch is folded into the total, and nothing stays anchored. */
export function goalClockOnDeactivation(goal: GoalState | null | undefined, nowMs: number): { activeDurationMs: bigint; lastAccruedAtMs: undefined } {
  return { activeDurationMs: BigInt(goalElapsedMs(goal, nowMs)), lastAccruedAtMs: undefined };
}

/** A goal without an owner is anyone's; a goal with an owner belongs to that session. */
export function isGoalOwnerValid(goal: GoalState, agentSessionId: string | undefined): boolean {
  const owner = goal.agentSessionId;
  if (owner === undefined) return true;
  if (owner.length === 0) return false;
  return agentSessionId !== undefined && agentSessionId.length > 0 && owner === agentSessionId;
}

/** Whether this stored goal belongs to the conversation in play, and to its agent session when it names one. */
export function isGoalIdentityValid(goal: GoalState, identity: { conversationId: string; agentSessionId?: string }): boolean {
  if (goal.agentSessionId === undefined) return goal.conversationId === identity.conversationId;
  return isGoalOwnerValid(goal, identity.agentSessionId);
}

/** The whole check a resumed conversation makes before it continues a stored goal. */
export function isGoalStateShapeValid(goal: GoalState | undefined, identity: { conversationId: string; agentSessionId?: string }): boolean {
  if (goal === undefined) return false;
  if (!isGoalIdentityValid(goal, identity)) return false;
  if (goal.status !== GOAL_STATUS_ACTIVE) return false;
  return GOAL_ID_PATTERN.test(goal.goalId);
}
