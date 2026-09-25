/**
 * Pausing a tool call's timeout while something outside the call is in progress.
 *
 * A tool that waits for the user — an approval, a question — is not slow, it is blocked on a person,
 * and counting that time against its own timeout would kill work that is going exactly as intended.
 * The suspension is carried on the context so a nested tool can suspend the enclosing call's timer
 * without knowing anything about it, and the remaining time is what is paused: whatever was already
 * spent stays spent.
 */

import { createKey, type Context } from "../../context/context.ts"

export interface ToolExecutionTimeoutSuspension {
  /** Suspends the timeout; the returned function resumes it. Calling it twice is harmless. */
  suspend(): () => void
}

export const toolExecutionTimeoutSuspensionKey = createKey<ToolExecutionTimeoutSuspension | undefined>(
  Symbol("toolExecutionTimeoutSuspension"),
  undefined,
)

export async function withToolExecutionTimeoutSuspended<T>(ctx: Context, fn: () => T | Promise<T>): Promise<T> {
  const suspension = ctx.get(toolExecutionTimeoutSuspensionKey)
  if (suspension === undefined) return await fn()
  const resume = suspension.suspend()
  try {
    return await fn()
  } finally {
    resume()
  }
}
