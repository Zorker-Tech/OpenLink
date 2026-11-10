import type { AgentStoreRetryConfiguration, ResolvedAgentStoreRetryConfiguration } from "./retry-schedule-contracts.ts"
import {
  resolveAgentStoreRetryConfiguration,
  retryDelayWithJitter,
  retryDelayWithoutJitter,
} from "./retry-schedule-policy.ts"

/** Keeps per-agent-store retry timing while a credential or object is temporarily unavailable. */
export class AgentStoreRetrySchedule {
  private failuresInARow = 0
  private readonly policy: ResolvedAgentStoreRetryConfiguration

  constructor(options: AgentStoreRetryConfiguration) {
    this.policy = resolveAgentStoreRetryConfiguration(options)
  }

  noteSuccess(): void {
    this.failuresInARow = 0
  }

  noteFailure(): number {
    this.failuresInARow += 1
    return retryDelayWithJitter(this.failuresInARow, this.policy)
  }

  peekNextDelayMs(): number {
    return retryDelayWithoutJitter(this.failuresInARow + 1, this.policy)
  }

  get failureCount(): number {
    return this.failuresInARow
  }

  restoreFailureCount(count: number): void {
    this.failuresInARow = count <= 0 ? 0 : Math.floor(count)
  }
}

export type { AgentStoreRetryConfiguration } from "./retry-schedule-contracts.ts"
