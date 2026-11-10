import type { SlateBackgroundTaskCompletion } from "./actions/background-task-completion-contracts.ts"

/** The execution environments Slate keeps for a subagent run. */
export type SlateSubagentExecutionEnvironment = "unspecified" | "local" | "cloud"

/** Every lifecycle state the durable run record can carry, including pre-completion states. */
export type SlateSubagentRunStatus =
  | "unspecified"
  | "running"
  | "backgrounded"
  | "success"
  | "error"
  | "aborted"

export type SlateSubagentCompletionReason = NonNullable<SlateBackgroundTaskCompletion["reason"]>

/** A Slate-owned durable record of one subagent run started by a parent tool call. */
export interface SlateSubagentRunState {
  readonly parentToolCallId: string
  readonly subagentId?: string | undefined
  readonly environment: SlateSubagentExecutionEnvironment
  readonly status: SlateSubagentRunStatus
  readonly title?: string | undefined
  readonly detail?: string | undefined
  readonly transcriptPath?: string | undefined
  readonly outputPath?: string | undefined
  readonly completedTimestampMs?: bigint | undefined
  readonly completionReason?: SlateSubagentCompletionReason | undefined
}

export interface SlateSubagentRunCompletionUpdate {
  readonly completion: SlateBackgroundTaskCompletion
  readonly parentToolCallId: string
  readonly subagentId?: string | undefined
  readonly environment?: SlateSubagentExecutionEnvironment | undefined
  readonly transcriptPath?: string | undefined
  readonly existingRun?: SlateSubagentRunState | undefined
  readonly completedTimestampMs: bigint
}

function trimmed(value: string | undefined): string | undefined {
  const normalized = value?.trim()
  return normalized === undefined || normalized.length === 0 ? undefined : normalized
}

function statusFor(
  completion: SlateBackgroundTaskCompletion,
  existingRun: SlateSubagentRunState | undefined,
): SlateSubagentRunStatus {
  if (completion.status !== "unknown") return completion.status
  return existingRun?.status ?? "unspecified"
}

/**
 * Applies a completion to Slate's durable run record.
 *
 * A progress event and an unknown terminal status do not erase values already learned about the run.
 * Explicit completion metadata wins over the previous record, while absent values stay absent.
 */
export function updateSlateSubagentRun(
  input: SlateSubagentRunCompletionUpdate,
): SlateSubagentRunState {
  const { completion, existingRun } = input
  const subagentId = trimmed(input.subagentId)
  const environment = input.environment === undefined || input.environment === "unspecified"
    ? existingRun?.environment ?? "unspecified"
    : input.environment
  const title = trimmed(completion.title) ?? existingRun?.title
  const detail = trimmed(completion.detail) ?? existingRun?.detail
  const transcriptPath = trimmed(input.transcriptPath) ?? existingRun?.transcriptPath
  const outputPath = trimmed(completion.outputPath) ?? existingRun?.outputPath
  const completionReason = completion.reason ?? existingRun?.completionReason

  return {
    parentToolCallId: input.parentToolCallId,
    ...(subagentId === undefined ? {} : { subagentId }),
    environment,
    status: statusFor(completion, existingRun),
    ...(title === undefined ? {} : { title }),
    ...(detail === undefined ? {} : { detail }),
    ...(transcriptPath === undefined ? {} : { transcriptPath }),
    ...(outputPath === undefined ? {} : { outputPath }),
    completedTimestampMs: input.completedTimestampMs,
    ...(completionReason === undefined ? {} : { completionReason }),
  }
}
