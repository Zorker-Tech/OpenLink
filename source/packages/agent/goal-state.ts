/** Slate's durable goal state and lifecycle transitions. */
import {
  goalClockOnActivation,
  SlateGoalStatus,
  type SlateGoalStatus as SlateGoalStatusValue,
} from "../agent-core/goal-continuation.ts"

export interface SlateGoalStateInput {
  readonly conversationId: string
  readonly goalId: string
  readonly objective: string
  readonly status: SlateGoalStatusValue
  readonly idleContinuationsWithoutToolCalls: number
  readonly activeDurationMs?: bigint | undefined
  readonly lastAccruedAtMs?: bigint | undefined
  readonly continuationCount: number
  readonly agentSessionId?: string | undefined
  readonly unknownStatusCode?: number | undefined
}

export class SlateGoalState {
  conversationId: string
  goalId: string
  objective: string
  status: SlateGoalStatusValue
  idleContinuationsWithoutToolCalls: number
  activeDurationMs?: bigint | undefined
  lastAccruedAtMs?: bigint | undefined
  continuationCount: number
  agentSessionId?: string | undefined
  unknownStatusCode?: number | undefined

  constructor(input: SlateGoalStateInput) {
    this.conversationId = input.conversationId
    this.goalId = input.goalId
    this.objective = input.objective
    this.status = input.status
    this.idleContinuationsWithoutToolCalls = input.idleContinuationsWithoutToolCalls
    this.activeDurationMs = input.activeDurationMs
    this.lastAccruedAtMs = input.lastAccruedAtMs
    this.continuationCount = input.continuationCount
    this.agentSessionId = input.agentSessionId
    this.unknownStatusCode = input.unknownStatusCode
  }

  clone(): SlateGoalState {
    return new SlateGoalState(this)
  }
}

export function isPausedGoalState(value: unknown): value is SlateGoalState {
  return value instanceof SlateGoalState && value.status === SlateGoalStatus.PAUSED
}

export function pauseGoalState(value: SlateGoalState): void {
  value.status = SlateGoalStatus.PAUSED
  delete value.unknownStatusCode
}

export function activatePausedGoalState(value: SlateGoalState, nowMs: number): SlateGoalState {
  const resumed = value.clone()
  resumed.status = SlateGoalStatus.ACTIVE
  resumed.idleContinuationsWithoutToolCalls = 0
  delete resumed.unknownStatusCode
  Object.assign(resumed, goalClockOnActivation(resumed, nowMs))
  return resumed
}

export interface SlatePlanRegistryEntry {
  readonly id: string
  readonly path: string
}

export function createSlatePlanRegistryEntry(id: string, path: string): SlatePlanRegistryEntry {
  return { id, path }
}
