import type { Context } from "../context/context.ts"
import type { HookContextEntry } from "../hooks-carriers/hook-additional-context.ts"

/** The runtime this operation would have run in is gone; the caller should not retry into it. */
export class ControlledExecDisposedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ControlledExecDisposedError"
  }
}

/** An executor operation that returns one result after it has completed. */
export interface ControlledExecutor<Args, Result> {
  execute(ctx: Context, args: Args, options: {
    execId?: string | undefined
    hookContextCollector: HookContextEntry[]
    deliverAgentStoreConflictNotices: boolean
  }): Promise<Result>
}

/** An executor operation that returns a sequence of results. */
export interface ControlledStreamExecutor<Args, Event> {
  execute(ctx: Context, args: Args, options: {
    execId?: string | undefined
    hookContextCollector: HookContextEntry[]
    deliverAgentStoreConflictNotices: boolean
  }): AsyncIterable<Event>
}
