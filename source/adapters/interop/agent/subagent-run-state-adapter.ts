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
  SlateSubagentRunCompatibility,
  SlateSubagentExecutionEnvironment,
  SlateSubagentRunState,
  SlateSubagentRunStatus,
} from "../../../packages/agent/subagent-run-state.ts"

function environmentFromInterop(
  environment: SubagentExecutionEnvironment | undefined,
): { readonly value: SlateSubagentExecutionEnvironment; readonly legacyCode?: number } {
  switch (environment) {
    case SubagentExecutionEnvironment.LOCAL: return { value: "local" }
    case SubagentExecutionEnvironment.CLOUD: return { value: "cloud" }
    case SubagentExecutionEnvironment.UNSPECIFIED: return { value: "unspecified" }
    default: return { value: "unspecified", ...(environment === undefined ? {} : { legacyCode: environment }) }
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

function statusFromInterop(status: SubagentRunStatus): { readonly value: SlateSubagentRunStatus; readonly legacyCode?: number } {
  switch (status) {
    case SubagentRunStatus.RUNNING: return { value: "running" }
    case SubagentRunStatus.BACKGROUNDED: return { value: "backgrounded" }
    case SubagentRunStatus.SUCCESS: return { value: "success" }
    case SubagentRunStatus.ERROR: return { value: "error" }
    case SubagentRunStatus.ABORTED: return { value: "aborted" }
    case SubagentRunStatus.UNSPECIFIED: return { value: "unspecified" }
    default: return { value: "unspecified", legacyCode: status }
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
): { readonly value?: SlateSubagentCompletionReason; readonly legacyCode?: number } {
  switch (reason) {
    case BackgroundTaskCompletionReason.TASK_PROGRESS: return { value: "task-progress" }
    case BackgroundTaskCompletionReason.WORKER_REPARENTED: return { value: "worker-reparented" }
    case undefined: return {}
    default: return { legacyCode: reason }
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
  const compatibility: SlateSubagentRunCompatibility = {
    ...(environment.legacyCode === undefined ? {} : { legacyEnvironmentCode: environment.legacyCode }),
    ...(status.legacyCode === undefined ? {} : { legacyStatusCode: status.legacyCode }),
    ...(completionReason.legacyCode === undefined ? {} : { legacyCompletionReasonCode: completionReason.legacyCode }),
  }
  return {
    parentToolCallId: state.parentToolCallId,
    ...(subagentId === undefined ? {} : { subagentId }),
    environment: environment.value,
    status: status.value,
    ...(title === undefined ? {} : { title }),
    ...(detail === undefined ? {} : { detail }),
    ...(transcriptPath === undefined ? {} : { transcriptPath }),
    ...(outputPath === undefined ? {} : { outputPath }),
    ...(state.completedTimestampMs === undefined ? {} : { completedTimestampMs: state.completedTimestampMs }),
    ...(completionReason.value === undefined ? {} : { completionReason: completionReason.value }),
    ...(Object.keys(compatibility).length === 0 ? {} : { compatibility }),
  }
}

/** Encodes a Slate run record only when writing the legacy-compatible conversation state. */
export function toInteropSubagentRunState(
  state: SlateSubagentRunState,
): AgentSubagentRunStateInterop {
  return createAgentSubagentRunStateInterop({
    parentToolCallId: state.parentToolCallId,
    ...(state.subagentId === undefined ? {} : { subagentId: state.subagentId }),
    environment: state.compatibility?.legacyEnvironmentCode ?? toInteropSubagentEnvironment(state.environment),
    status: state.compatibility?.legacyStatusCode ?? statusToInterop(state.status),
    ...(state.title === undefined ? {} : { title: state.title }),
    ...(state.detail === undefined ? {} : { detail: state.detail }),
    ...(state.transcriptPath === undefined ? {} : { transcriptPath: state.transcriptPath }),
    ...(state.outputPath === undefined ? {} : { outputPath: state.outputPath }),
    ...(state.completedTimestampMs === undefined ? {} : { completedTimestampMs: state.completedTimestampMs }),
    ...(state.compatibility?.legacyCompletionReasonCode === undefined
      ? state.completionReason === undefined ? {} : { completionReason: reasonToInterop(state.completionReason) }
      : { completionReason: state.compatibility.legacyCompletionReasonCode as BackgroundTaskCompletionReason }),
  })
}

/** Reads the network-facing environment code once, at the state restoration boundary. */
export function slateSubagentEnvironmentFromInterop(
  environment: SubagentExecutionEnvironment | undefined,
): SlateSubagentExecutionEnvironment | undefined {
  const projected = environmentFromInterop(environment).value
  return projected === "unspecified" ? undefined : projected
}
