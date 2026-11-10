/** Watches one cloud run at a time; account catalogs and launch policy live in cloud-agent-watch-policy.ts. */

import type { DeadlinePolicy } from "../extensions/scheduling.ts"
import { buildWatchResult, cloudAgentRateLimitPauseMs, normalizeCloudAgentRunStatus } from "./cloud-agent-watch-policy.ts"
import type { Clock, DetailedComposer } from "./cloud-agent-watch-policy.ts"

export {
  availableEnvironmentsNote,
  buildWatchResult,
  CloudAgentModelCatalogCache,
  CloudAgentTeamAdminPolicyCache,
  cloudAgentRateLimitPauseMs,
  formatDiffStats,
  normalizeCloudAgentRunStatus,
  resolveSavedEnvironment,
  resolveSlateLimitError,
  CLOUD_AGENT_RATE_LIMIT_FALLBACK_MS,
  CLOUD_AGENT_RATE_LIMIT_JITTER_RATIO,
  MAX_LISTED_SAVED_ENVIRONMENTS,
  MODEL_CATALOG_TTL_MS,
  SAVED_ENVIRONMENT_LIST_LIMIT,
  TEAM_ADMIN_POLICY_REQUEST_TIMEOUT_MS,
  TEAM_ADMIN_POLICY_TTL_MS,
} from "./cloud-agent-watch-policy.ts"
export type { Clock, CloudAgentRunStatus, DetailedComposer, SavedEnvironment, SavedEnvironmentClient } from "./cloud-agent-watch-policy.ts"

export const CLOUD_AGENT_MAX_WAIT_MS = 5 * 60 * 60_000
export const CLOUD_AGENT_POLL_INTERVAL_MS = 10_000
export const CLOUD_AGENT_POLL_RPC_TIMEOUT_MS = 30_000
export const CLOUD_AGENT_RUN_RESTART_GRACE_MS = 3 * 60_000

export interface PollingPolicy {
  start(run: () => void | Promise<void>): { dispose(): void }
}

export interface CloudAgentCompletion {
  readonly status: "completed" | "error"
  readonly text: string
}

function stoppedWatchResult(agentId: string): CloudAgentCompletion {
  return {
    status: "error",
    text: `Stopped watching the Slate agent (${agentId}) before it finished. The run may still be active; check the Slate cloud agents dashboard for its result.`,
  }
}

export class CloudAgentCompletionPoller {
  private readonly active = new Map<{ dispose(): void }, () => void>()
  private disposed = false

  constructor(
    private readonly options: {
      readonly completionPolling: PollingPolicy
      readonly clock: Clock
      readonly maxWaitMs?: number
      readonly runRestartGraceMs?: number
      readonly randomFn?: () => number
      readonly isRateLimitError?: (error: unknown) => boolean
    },
    private readonly getClient: () => {
      getBackgroundComposerInfo(
        request: { bcId: string; includeDiff: false; doNotThrowIfSetupNotFinished: true },
        options: { timeoutMs: number },
      ): Promise<{ composer?: DetailedComposer }>
    },
  ) {}

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const cancel of [...this.active.values()]) cancel()
  }

  async awaitCompletion(agentId: string, options?: { waitForRestart?: boolean }): Promise<CloudAgentCompletion> {
    if (this.disposed) return stoppedWatchResult(agentId)

    const client = this.getClient()
    const maxWaitMs = this.options.maxWaitMs ?? CLOUD_AGENT_MAX_WAIT_MS
    const deadline = this.options.clock.monotonicNow() + maxWaitMs
    const restartDeadline = this.options.clock.monotonicNow() + (this.options.runRestartGraceMs ?? CLOUD_AGENT_RUN_RESTART_GRACE_MS)
    let awaitingRestart = options?.waitForRestart ?? false
    let skipInitialPoll = true
    let pausedUntil = 0

    return await new Promise<CloudAgentCompletion>((resolve) => {
      let settled = false
      let poll: { dispose(): void } | undefined
      const outOfTime = (): CloudAgentCompletion => ({
        status: "error",
        text: `The Slate agent (${agentId}) is still running after ${Math.round(maxWaitMs / 60_000)} minutes. It keeps running on the VM; check the Slate cloud agents dashboard for the result.`,
      })
      const finish = (result: CloudAgentCompletion): void => {
        if (settled) return
        settled = true
        const currentPoll = poll
        poll = undefined
        if (currentPoll !== undefined) {
          this.active.delete(currentPoll)
          currentPoll.dispose()
        }
        resolve(result)
      }

      const pollOnce = async (): Promise<void> => {
        try {
          if (skipInitialPoll) {
            skipInitialPoll = false
            return
          }
          const now = this.options.clock.monotonicNow()
          if (now < pausedUntil) {
            if (now >= deadline) finish(outOfTime())
            return
          }

          let detailed: DetailedComposer | undefined
          try {
            detailed = (await client.getBackgroundComposerInfo(
              { bcId: agentId, includeDiff: false, doNotThrowIfSetupNotFinished: true },
              { timeoutMs: CLOUD_AGENT_POLL_RPC_TIMEOUT_MS },
            )).composer
          } catch (error) {
            if (this.options.isRateLimitError?.(error)) {
              pausedUntil = now + cloudAgentRateLimitPauseMs(error, this.options.randomFn)
            }
            if (now >= deadline) finish(outOfTime())
            return
          }

          const status = normalizeCloudAgentRunStatus(detailed?.composer?.status ?? "unspecified")
          const active = status === "running" || status === "creating"
          if (awaitingRestart) {
            if (active || now >= restartDeadline) awaitingRestart = false
            else {
              if (now >= deadline) finish(outOfTime())
              return
            }
          }
          if (active || status === "unspecified") {
            if (now >= deadline) finish(outOfTime())
            return
          }
          finish(buildWatchResult(agentId, status, detailed))
        } catch {
          finish({
            status: "error",
            text: `The Slate agent (${agentId}) status check failed unexpectedly. Check the Slate cloud agents dashboard for the result.`,
          })
        }
      }

      try {
        const started = this.options.completionPolling.start(pollOnce)
        poll = started
        if (settled) started.dispose()
        else this.active.set(started, () => finish(stoppedWatchResult(agentId)))
      } catch {
        finish({
          status: "error",
          text: `The Slate agent (${agentId}) status watcher could not start. Check the Slate cloud agents dashboard for the result.`,
        })
      }
    })
  }
}
