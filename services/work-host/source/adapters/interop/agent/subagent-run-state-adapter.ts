import {
  SubagentExecutionEnvironment,
  SubagentRunStatus,
  BackgroundTaskCompletionReason,
} from "../proto/generated/agent/v1/agent_pb.ts"
import {
  createAgentSubagentRunStateInterop,
  type AgentSubagentRunStateInterop,
} from "./agent-state-message-serdes-adapter.ts"
import type {
  SlateSubagentCompletionReason,
  SlateSubagentExecutionEnvironment,
  SlateSubagentRunState,
  SlateSubagentRunStatus,
} from "../../../packages/agent/subagent-run-state.ts"

function environmentFromInterop(
  environment: SubagentExecutionEnvironment | undefined,
): SlateSubagentExecutionEnvironment {
  switch (environment) {
    case SubagentExecutionEnvironment.LOCAL: return "local"
    case SubagentExecutionEnvironment.CLOUD: return "cloud"
    case SubagentExecutionEnvironment.UNSPECIFIED: return "unspecified"
    default: return "unspecified"
  }
}

export function toInteropSubagentEnvironment(
  environment: SlateSubagentExecutionEnvironment,
): SubagentExecutionEnvironment {
  switch (environment) {
    case "local": return SubagentExecutionEnvironment.LOCAL
    case "cloud": return SubagentExecutionEnvironment.CLOUD
    case "unspecified": return SubagentExecutionEnvironment.UNSPECIFIED
  }
}

function statusFromInterop(status: SubagentRunStatus): SlateSubagentRunStatus {
  switch (status) {
    case SubagentRunStatus.RUNNING: return "running"
    case SubagentRunStatus.BACKGROUNDED: return "backgrounded"
    case SubagentRunStatus.SUCCESS: return "success"
    case SubagentRunStatus.ERROR: return "error"
    case SubagentRunStatus.ABORTED: return "aborted"
    case SubagentRunStatus.UNSPECIFIED: return "unspecified"
    default: return "unspecified"
  }
}

function statusToInterop(status: SlateSubagentRunStatus): SubagentRunStatus {
  switch (status) {
    case "running": return SubagentRunStatus.RUNNING
    case "backgrounded": return SubagentRunStatus.BACKGROUNDED
    case "success": return SubagentRunStatus.SUCCESS
    case "error": return SubagentRunStatus.ERROR
    case "aborted": return SubagentRunStatus.ABORTED
    case "unspecified": return SubagentRunStatus.UNSPECIFIED
  }
}

function reasonFromInterop(
  reason: BackgroundTaskCompletionReason | undefined,
): SlateSubagentCompletionReason | undefined {
  switch (reason) {
    case BackgroundTaskCompletionReason.TASK_PROGRESS: return "task-progress"
    case BackgroundTaskCompletionReason.WORKER_REPARENTED: return "worker-reparented"
    default: return undefined
  }
}

function reasonToInterop(
  reason: SlateSubagentCompletionReason,
): BackgroundTaskCompletionReason {
  switch (reason) {
    case "task-progress": return BackgroundTaskCompletionReason.TASK_PROGRESS
    case "worker-reparented": return BackgroundTaskCompletionReason.WORKER_REPARENTED
  }
}

function optionalText(value: string | undefined): string | undefined {
  return value === undefined || value.length === 0 ? undefined : value
}

/** Projects one persisted external run record into Slate's durable run vocabulary. */
export function fromInteropSubagentRunState(
  state: AgentSubagentRunStateInterop,
): SlateSubagentRunState {
  const subagentId = optionalText(state.subagentId)
  const title = optionalText(state.title)
  const detail = optionalText(state.detail)
  const transcriptPath = optionalText(state.transcriptPath)
  const outputPath = optionalText(state.outputPath)
  const environment = environmentFromInterop(state.environment)
  const status = statusFromInterop(state.status)
  const completionReason = reasonFromInterop(state.completionReason)
  return {
    parentToolCallId: state.parentToolCallId,
    ...(subagentId === undefined ? {} : { subagentId }),
    environment,
    status,
    ...(title === undefined ? {} : { title }),
    ...(detail === undefined ? {} : { detail }),
    ...(transcriptPath === undefined ? {} : { transcriptPath }),
    ...(outputPath === undefined ? {} : { outputPath }),
    ...(state.completedTimestampMs === undefined ? {} : { completedTimestampMs: state.completedTimestampMs }),
    ...(completionReason === undefined ? {} : { completionReason }),
  }
}

/** Encodes a Slate run record only when writing the legacy-compatible conversation state. */
export function toInteropSubagentRunState(
  state: SlateSubagentRunState,
): AgentSubagentRunStateInterop {
  return createAgentSubagentRunStateInterop({
    parentToolCallId: state.parentToolCallId,
    ...(state.subagentId === undefined ? {} : { subagentId: state.subagentId }),
    environment: toInteropSubagentEnvironment(state.environment),
    status: statusToInterop(state.status),
    ...(state.title === undefined ? {} : { title: state.title }),
    ...(state.detail === undefined ? {} : { detail: state.detail }),
    ...(state.transcriptPath === undefined ? {} : { transcriptPath: state.transcriptPath }),
    ...(state.outputPath === undefined ? {} : { outputPath: state.outputPath }),
    ...(state.completedTimestampMs === undefined ? {} : { completedTimestampMs: state.completedTimestampMs }),
    ...(state.completionReason === undefined ? {} : { completionReason: reasonToInterop(state.completionReason) }),
  })
}

/** Reads the network-facing environment code once, at the state restoration boundary. */
export function slateSubagentEnvironmentFromInterop(
  environment: SubagentExecutionEnvironment | undefined,
): SlateSubagentExecutionEnvironment | undefined {
  const projected = environmentFromInterop(environment)
  return projected === "unspecified" ? undefined : projected
}
