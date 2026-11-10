/** Give transcript writes a short chance to finish after a run fails or is cancelled. */
import { createLogger } from "../context/logging.ts";
import type { Context } from "../context/context.ts";
import { createCounter } from "../metrics/index.ts";
import { TimeoutError, withTimeout } from "../utils/promise-tools.ts";

const logger = createLogger("agent/abort-drain");
const DEFAULT_ABORT_DRAIN_TIMEOUT_MS = 5_000;

const abortDrainOutcomeCounter = createCounter("agent.run_stream.abort_drain", {
  description: "Result of waiting for pending transcript writes after a run stops.",
  labelNames: ["outcome"],
});

export interface AbortDrainArgs {
  readonly pendingCheckpoints: Promise<unknown>;
  readonly flush: () => Promise<unknown>;
  readonly timeoutMs?: number;
}

type DrainAttempt =
  | { readonly outcome: "succeeded" }
  | { readonly outcome: "timed_out" | "failed"; readonly error: unknown };

async function attemptBoundedDrain(args: AbortDrainArgs, timeoutMs: number): Promise<DrainAttempt> {
  try {
    await withTimeout(
      Promise.all([args.pendingCheckpoints, args.flush()]),
      timeoutMs,
      `Pending transcript writes did not finish within ${timeoutMs}ms`,
    );
    return { outcome: "succeeded" };
  } catch (error) {
    return { outcome: error instanceof TimeoutError ? "timed_out" : "failed", error };
  }
}

export async function drainPendingWritesOnRunStreamError(ctx: Context, args: AbortDrainArgs): Promise<void> {
  const timeoutMs = args.timeoutMs ?? DEFAULT_ABORT_DRAIN_TIMEOUT_MS;
  const attempt = await attemptBoundedDrain(args, timeoutMs);

  abortDrainOutcomeCounter.increment(ctx, 1, { outcome: attempt.outcome });
  if (attempt.outcome !== "succeeded") {
    logger.warn(ctx, "Pending transcript writes did not finish before run shutdown", {
      error: attempt.error,
      outcome: attempt.outcome,
      timeoutMs,
    });
  }
}
