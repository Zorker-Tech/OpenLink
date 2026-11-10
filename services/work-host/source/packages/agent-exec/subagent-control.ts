import type { Executor } from "./executor-resources.ts"
import type { RemoteExecManager } from "./executor-resources.ts"
import { createResource, type ControlledExecManager } from "./resource-provider.ts"

export interface SlateSubagentBackgroundHandoffArgs {
  readonly toolCallId: string
}

export type SlateSubagentBackgroundHandoffResult =
  | { readonly status: "accepted" }
  | { readonly status: "not-found" }

/** A turn-local control resource; a remote fallback would target an unrelated process. */
export const slateSubagentBackgroundHandoffExecutorResource = createResource<
  Executor<SlateSubagentBackgroundHandoffArgs, SlateSubagentBackgroundHandoffResult>,
  RemoteExecManager,
  ControlledExecManager
>(
  () => ({
    async execute(): Promise<SlateSubagentBackgroundHandoffResult> {
      throw new Error("The Slate subagent handoff is only available in its owning turn")
    },
  }),
  () => {
    throw new Error("The Slate subagent handoff is only registered in its owning turn")
  },
)

/** Turns the owning runtime's live-call lookup into the executor contract used by task execution. */
export function createSlateSubagentBackgroundHandoffExecutor(
  hasRunningToolCall: (toolCallId: string) => boolean,
): Executor<SlateSubagentBackgroundHandoffArgs, SlateSubagentBackgroundHandoffResult> {
  return {
    async execute(_context, request) {
      return hasRunningToolCall(request.toolCallId)
        ? { status: "accepted" }
        : { status: "not-found" }
    },
  }
}
