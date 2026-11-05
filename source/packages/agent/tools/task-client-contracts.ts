import type {
  SubagentBackgroundReason,
  SubagentContinuationConfig,
  SubagentExecutionArgs,
} from "../../agent-exec/subagent.ts"
import type { TaskEnvironment } from "./task-runtime-types.ts"

export type SlateTaskClientContinuationConfig = SubagentContinuationConfig

/** First-party request the task tool hands to the subagent executor in the owning turn. */
export interface SlateTaskClientSubagentRequest extends SubagentExecutionArgs {
  readonly toolCallId: string
  readonly subagentType: string
  readonly modelId: string
  readonly prompt: string
  readonly readonly: boolean
  readonly environment: TaskEnvironment
}

/** Result view consumed by task-result policy after the local executor has finished. */
export type SlateTaskClientSubagentRunView =
  | { readonly kind: "error"; readonly error: string }
  | {
      readonly kind: "success"
      readonly agentId?: string
      readonly finalMessage?: string
      readonly backgroundReason: SubagentBackgroundReason
      readonly transcriptPath?: string
    }
  | { readonly kind: "unknown" }
