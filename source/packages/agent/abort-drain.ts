/**
 * What happens to writes already in flight when a turn is aborted.
 *
 * A turn that fails or is cancelled leaves blob writes and checkpoints pending, and dropping them would
 * lose the transcript of the work that did happen. So they are waited for — but only briefly: the point
 * of an abort is to stop, and a drain that can hang would make cancelling a turn impossible. The outcome
 * is counted either way, because "the writes were lost" is something the platform should be able to see
 * rather than discover later.
 */

import { createLogger } from "../context/logging.ts"
import type { Context } from "../context/context.ts"
import { createCounter } from "../metrics/index.ts"
import { TimeoutError, withTimeout } from "../utils/promise-tools.ts"

const logger = createLogger("agent/abort-drain")
const ABORT_DRAIN_TIMEOUT_MS = 5_000

const abortDrainOutcomeCounter = createCounter("agent.run_stream.abort_drain", {
  description:
    "Outcome of the bounded drain of pending blob/checkpoint work when runStream exits via an error (including user aborts).",
  labelNames: ["outcome"],
})

export interface AbortDrainArgs {
  readonly pendingCheckpoints: Promise<unknown>
  readonly flush: () => Promise<unknown>
  readonly timeoutMs?: number
}

export async function drainPendingWritesOnRunStreamError(ctx: Context, args: AbortDrainArgs): Promise<void> {
  const timeoutMs = args.timeoutMs ?? ABORT_DRAIN_TIMEOUT_MS
  try {
    await withTimeout(
      Promise.all([args.pendingCheckpoints, args.flush()]),
      timeoutMs,
      `Abort drain of pending blob writes timed out after ${timeoutMs}ms`,
    )
    abortDrainOutcomeCounter.increment(ctx, 1, { outcome: "succeeded" })
  } catch (error) {
    // A timeout and a failure are different: one means the writes may still land, the other means they
    // did not.
    const outcome = error instanceof TimeoutError ? "timed_out" : "failed"
    abortDrainOutcomeCounter.increment(ctx, 1, { outcome })
    logger.warn(ctx, "Abort drain of pending blob writes did not complete", { error, outcome, timeoutMs })
  }
}
