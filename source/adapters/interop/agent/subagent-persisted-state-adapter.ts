import {
  CloudSubagentReference,
  SubagentPersistedState,
} from "../proto/generated/agent/v1/agent_pb.ts"
import type {
  SlateSubagentCloudReference,
  SlateSubagentPersistedState,
} from "../../../packages/agent/subagent-persisted-state.ts"
import {
  fromInteropTaskConversationState,
  toInteropTaskConversationState,
} from "./task-conversation-state-adapter.ts"
import {
  slateSubagentEnvironmentFromInterop,
  toInteropSubagentEnvironment,
} from "./subagent-run-state-adapter.ts"
import {
  targetMachineFromProtoInterop,
  targetMachineToProtoInterop,
} from "./task-runtime-protocol-adapter.ts"
import type { SlateSubagentTypeLike } from "../../../packages/agent/subagent-type.ts"
import { PrivacyMode, type PrivacyMode as PrivacyModeValue } from "../../../packages/redaction/privacy-mode.ts"

function cloudReferenceFromInterop(
  value: SubagentPersistedState["cloudSubagent"],
): SlateSubagentCloudReference | undefined {
  if (value === undefined) return undefined
  return {
    bcId: value.bcId,
    ...(value.transcriptPath === undefined ? {} : { transcriptPath: value.transcriptPath }),
  }
}

function cloudReferenceToInterop(
  value: SlateSubagentCloudReference | undefined,
): CloudSubagentReference | undefined {
  if (value === undefined) return undefined
  return new CloudSubagentReference({
    bcId: value.bcId,
    ...(value.transcriptPath === undefined ? {} : { transcriptPath: value.transcriptPath }),
  })
}

/** Projects the legacy persisted subagent record into Slate's own metadata and snapshot model. */
export function fromInteropSubagentPersistedState(
  value: SubagentPersistedState,
  privacyMode: PrivacyModeValue = PrivacyMode.UNSPECIFIED,
): SlateSubagentPersistedState {
  const cloudSubagent = cloudReferenceFromInterop(value.cloudSubagent)
  const machine = targetMachineFromProtoInterop(value.machine)
  return {
    createdTimestampMs: value.createdTimestampMs ?? BigInt(0),
    lastUsedTimestampMs: value.lastUsedTimestampMs ?? BigInt(0),
    environment: slateSubagentEnvironmentFromInterop(value.environment) ?? "unspecified",
    ...(value.conversationState === undefined
      ? {}
      : { conversationState: fromInteropTaskConversationState(value.conversationState, privacyMode) }),
    ...(value.subagentType === undefined
      ? {}
      : { subagentType: value.subagentType as SlateSubagentTypeLike }),
    ...(value.modelId === undefined ? {} : { modelId: value.modelId }),
    ...(cloudSubagent === undefined ? {} : { cloudSubagent }),
    ...(value.firstClassBcId === undefined ? {} : { firstClassBcId: value.firstClassBcId }),
    ...(value.cloudRequestedEnvironmentBuildId === undefined
      ? {}
      : { cloudRequestedEnvironmentBuildId: value.cloudRequestedEnvironmentBuildId }),
    ...(machine === undefined ? {} : { machine }),
  }
}

/** Encodes Slate's persisted subagent record only for the existing conversation-state format. */
export function toInteropSubagentPersistedState(
  value: SlateSubagentPersistedState,
): SubagentPersistedState {
  const cloudSubagent = cloudReferenceToInterop(value.cloudSubagent)
  return new SubagentPersistedState({
    createdTimestampMs: value.createdTimestampMs,
    lastUsedTimestampMs: value.lastUsedTimestampMs,
    environment: toInteropSubagentEnvironment(value.environment),
    ...(value.conversationState === undefined
      ? {}
      : { conversationState: toInteropTaskConversationState(value.conversationState) }),
    ...(value.subagentType === undefined ? {} : { subagentType: value.subagentType as never }),
    ...(value.modelId === undefined ? {} : { modelId: value.modelId }),
    ...(cloudSubagent === undefined ? {} : { cloudSubagent }),
    ...(value.firstClassBcId === undefined ? {} : { firstClassBcId: value.firstClassBcId }),
    ...(value.cloudRequestedEnvironmentBuildId === undefined
      ? {}
      : { cloudRequestedEnvironmentBuildId: value.cloudRequestedEnvironmentBuildId }),
    ...(value.machine === undefined
      ? {}
      : { machine: targetMachineToProtoInterop(value.machine) }),
  })
}
