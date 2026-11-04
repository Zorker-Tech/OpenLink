import type { LogShipResult } from "./log-ship-contracts.ts"
import { nextLogShipWindow } from "./log-ship-policy.ts"

export class LogShipSchedule {
  private nextEligibleAtMs = 0
  private consecutiveFailures = 0
  private consecutiveRateLimits = 0

  isDue(eager: boolean, nowMs = Date.now()): boolean {
    return nowMs >= this.nextEligibleAtMs || (eager && !this.isBackingOff())
  }

  shipNext(): void {
    if (!this.isBackingOff()) this.nextEligibleAtMs = 0
  }

  record(result: LogShipResult, nowMs = Date.now()): void {
    const next = nextLogShipWindow(
      result,
      this.consecutiveFailures,
      this.consecutiveRateLimits,
      nowMs,
    )
    this.nextEligibleAtMs = next.nextShipAtMs
    this.consecutiveFailures = next.failureStreak
    this.consecutiveRateLimits = next.rateLimitStreak
  }

  isBackingOff(): boolean {
    return this.consecutiveFailures + this.consecutiveRateLimits > 0
  }
}
