import type { Context } from "../context/context.ts"
import type { Executor } from "./executor-resources.ts"
import type { RemoteExecManager } from "./executor-resources.ts"
import { createResource, type ControlledExecManager } from "./resource-provider.ts"

export type SlateSubagentAwaitRequest =
  | { readonly agentId: string; readonly bounded: false }
  | { readonly agentId: string; readonly bounded: true; readonly timeoutMs: number }

export type SlateSubagentAwaitResult =
  | {
      readonly kind: "complete"
      readonly agentId: string
      /** False when no usable path was found and the caller should try its fallback. */
      readonly transcriptPathKnown: boolean
      readonly transcriptPath?: string
    }
  | { readonly kind: "still-running"; readonly agentId: string }
  | { readonly kind: "not-found"; readonly agentId: string }
  | { readonly kind: "error"; readonly agentId: string; readonly error: string }

/** Local only: all subagent runs and their completion state belong to the owning turn runtime. */
export const slateSubagentAwaitExecutorResource = createResource<
  Executor<SlateSubagentAwaitRequest, SlateSubagentAwaitResult>,
  RemoteExecManager,
  ControlledExecManager
>(
  () => ({
    async execute(): Promise<SlateSubagentAwaitResult> {
      throw new Error("The Slate subagent await resource is only available in its owning turn")
    },
  }),
  () => {
    throw new Error("The Slate subagent await resource is only registered in its owning turn")
  },
)

/** Attaches the runtime's completion wait to the executor port used by the Await tool. */
export function createSlateSubagentAwaitExecutor(
  waitForSubagent: (
    request: SlateSubagentAwaitRequest,
    signal: AbortSignal,
  ) => Promise<SlateSubagentAwaitResult>,
): Executor<SlateSubagentAwaitRequest, SlateSubagentAwaitResult> {
  return {
    execute(context: Context, request: SlateSubagentAwaitRequest) {
      return waitForSubagent(request, context.signal)
    },
  }
}
