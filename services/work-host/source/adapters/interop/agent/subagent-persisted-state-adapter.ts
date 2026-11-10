import {
  CloudSubagentReference,
  SubagentExecutionEnvironment,
  SubagentPersistedState,
} from "../proto/generated/agent/v1/agent_pb.ts"
import type {
  SlateSubagentCloudAgent,
  SlateSubagentPersistedState,
} from "../../../packages/agent/subagent-persisted-state.ts"
import {
  createSlateSubagentPersistedState,
  type SlateSubagentConversationSnapshot,
} from "../../../packages/agent/subagent-persisted-state.ts"
import { slateSubagentTypeFromInterop, subagentTypeToInterop } from "./subagent-type-adapter.ts"
import {
  fromInteropTaskConversationState,
  toInteropTaskConversationState,
} from "./task-conversation-state-adapter.ts"
import {
  targetMachineFromProtoInterop,
  targetMachineToProtoInterop,
} from "./task-runtime-protocol-adapter.ts"

function environmentFromInterop(value: number): SlateSubagentPersistedState["executionEnvironment"] {
  switch (value) {
    case SubagentExecutionEnvironment.UNSPECIFIED: return "unspecified"
    case SubagentExecutionEnvironment.LOCAL: return "local"
    case SubagentExecutionEnvironment.CLOUD: return "cloud"
    default: return "unspecified"
  }
}

function environmentToInterop(value: SlateSubagentPersistedState["executionEnvironment"]): number {
  switch (value) {
    case "unspecified": return SubagentExecutionEnvironment.UNSPECIFIED
    case "local": return SubagentExecutionEnvironment.LOCAL
    case "cloud": return SubagentExecutionEnvironment.CLOUD
  }
}

/** Imports a generated state into Slate's own resume record. */
export function fromInteropSubagentPersistedState(
  value: SubagentPersistedState,
  privacyMode?: Parameters<typeof fromInteropTaskConversationState>[1],
): SlateSubagentPersistedState {
  const cloudAgent: SlateSubagentCloudAgent | undefined = value.cloudSubagent === undefined
    ? undefined
    : {
        agentId: value.cloudSubagent.bcId,
        ...(value.cloudSubagent.transcriptPath === undefined ? {} : { transcriptUri: value.cloudSubagent.transcriptPath }),
      }
  return createSlateSubagentPersistedState({
    createdAtMs: value.createdTimestampMs ?? BigInt(0),
    lastUsedAtMs: value.lastUsedTimestampMs ?? BigInt(0),
    executionEnvironment: environmentFromInterop(value.environment),
    ...(value.conversationState === undefined
      ? {}
      : { conversationSnapshot: fromInteropTaskConversationState(value.conversationState, privacyMode) }),
    ...(value.subagentType === undefined ? {} : { subagentType: slateSubagentTypeFromInterop(value.subagentType) }),
    ...(value.modelId === undefined ? {} : { modelId: value.modelId }),
    ...(cloudAgent === undefined ? {} : { cloudAgent }),
    ...(value.firstClassBcId === undefined ? {} : { firstClassAgentId: value.firstClassBcId }),
    ...(value.cloudRequestedEnvironmentBuildId === undefined
      ? {}
      : { requestedRuntimeBuildId: value.cloudRequestedEnvironmentBuildId }),
    ...(value.machine === undefined ? {} : { targetMachine: targetMachineFromProtoInterop(value.machine) }),
  })
}

/** Projects a Slate resume record only at the current runner/checkpoint edge. */
export function toInteropSubagentPersistedState(
  value: SlateSubagentPersistedState,
): SubagentPersistedState {
  const environment = environmentToInterop(value.executionEnvironment)
  return new SubagentPersistedState({
    createdTimestampMs: value.createdAtMs,
    lastUsedTimestampMs: value.lastUsedAtMs,
    environment,
    ...(value.conversationSnapshot === undefined
      ? {}
      : { conversationState: toInteropTaskConversationState(value.conversationSnapshot) }),
    ...(value.subagentType === undefined ? {} : { subagentType: subagentTypeToInterop(value.subagentType)! }),
    ...(value.modelId === undefined ? {} : { modelId: value.modelId }),
    ...(value.cloudAgent === undefined
      ? {}
      : { cloudSubagent: new CloudSubagentReference({
          bcId: value.cloudAgent.agentId,
          ...(value.cloudAgent.transcriptUri === undefined ? {} : { transcriptPath: value.cloudAgent.transcriptUri }),
        }) }),
    ...(value.firstClassAgentId === undefined ? {} : { firstClassBcId: value.firstClassAgentId }),
    ...(value.requestedRuntimeBuildId === undefined
      ? {}
      : { cloudRequestedEnvironmentBuildId: value.requestedRuntimeBuildId }),
    ...(value.targetMachine === undefined ? {} : { machine: targetMachineToProtoInterop(value.targetMachine) }),
  })
}
