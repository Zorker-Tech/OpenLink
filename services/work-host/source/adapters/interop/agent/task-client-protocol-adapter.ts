import {
  SubagentPersistedState,
  TaskError,
  TaskResult,
  TaskToolCall,
  ToolCall,
} from "../proto/generated/agent/v1/agent_pb.ts"
import { fromRedactedSelectedContext } from "../redacted-protos/generated/agent/v1/selected_context_redacted.ts"
import { isSlateSelectedContextState } from "../../../packages/agent/context/selected-context-state.ts"
import { RedactedString } from "../../../packages/redaction/redacted-values.ts"
import type { PrivacyCapability } from "../../../packages/redaction/classification.ts"

export type {
  SlateTaskClientContinuationConfig as TaskClientContinuationConfigInput,
  SlateTaskClientSubagentRequest as TaskClientSubagentRequest,
  SlateTaskClientSubagentRunView as TaskClientSubagentRunView,
} from "../../../packages/agent/tools/task-client-contracts.ts"
export {
  createSlateTaskClientContinuationConfig,
  createSlateTaskClientSuccessResult,
  requestSlateSubagentBackgroundHandoff,
  runClientSubagent,
} from "../../../packages/agent/tools/task-client-execution.ts"

export function createTaskToolCallInterop(value: unknown): unknown {
  return new ToolCall({ tool: { case: "taskToolCall", value: value as TaskToolCall } })
}

export function createSerializedTaskToolCallErrorInterop(error: string): unknown {
  return createTaskToolCallInterop(new TaskToolCall({
    result: new TaskResult({ result: { case: "error", value: new TaskError({ error }) } }),
  }))
}

export function getVideoPathsFromRedactedSelectedContextInterop(
  selectedContext: unknown,
  capability: PrivacyCapability,
): string[] {
  if (isSlateSelectedContextState(selectedContext)) {
    return selectedContext.media.videos.map(video =>
      video.path instanceof RedactedString ? video.path.unwrap(capability) : video.path,
    )
  }
  const context = fromRedactedSelectedContext(selectedContext, capability, {})
  return context.selectedVideos.map(({ path }) => path)
}

export function isCloudSubagentEnvironment(environment: unknown): boolean {
  return environment === "cloud"
}

export function createLocalSubagentPersistedStateInterop(modelId: string): unknown {
  return new SubagentPersistedState({ modelId })
}
