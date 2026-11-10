import {
  CloudSubagentReference,
  ConversationAction,
  SubagentExecutionEnvironment,
  SubagentPersistedState,
  UserMessageAction,
} from "../proto/generated/agent/v1/agent_pb.ts"
import { CustomSubagentPermissionMode } from "../proto/generated/agent/v1/subagents_pb.ts"
import type {
  CloudSubagentPersistedStateArgs,
  TaskEnvironment,
  TaskTargetMachine,
} from "../../../packages/agent/tools/task-runtime-types.ts"
import type { SlateUserMessage } from "../../../packages/agent/user-message-state.ts"
import type { SlateConversationStep } from "../../../packages/agent/conversation-step-state.ts"
import { PrivacyCapability } from "../../../packages/redaction/classification.ts"
import { RedactedString } from "../../../packages/redaction/redacted-values.ts"
import { PrivacyMode } from "../../../packages/redaction/privacy-mode.ts"
import { toInteropUserMessage } from "./user-message-action-protocol-adapter.ts"
import { createSlateConversationStepSerde } from "./agent-state-message-serdes-adapter.ts"
import { slateConversationTurnSerde } from "./agent-conversation-state-serdes-adapter.ts"
import { targetMachineFromProtoInterop, targetMachineToProtoInterop } from "./task-operation-protocol-adapter.ts"

export { targetMachineFromProtoInterop, targetMachineToProtoInterop } from "./task-operation-protocol-adapter.ts"

export type ConversationTurnView =
  | { readonly kind: "agent"; readonly stepBlobIds: readonly Uint8Array[] }
  | { readonly kind: "other" }

export interface ConversationStepView {
  readonly value: SlateConversationStep
  readonly kind: "assistant" | "tool-call" | "other"
  readonly assistantText?: string
}

export type TaskUserMessageActionInterop = ConversationAction
export type CloudSubagentPersistedStateInterop = SubagentPersistedState

export function isReadonlySubagentPermissionModeInterop(permissionMode: number): boolean {
  return permissionMode === CustomSubagentPermissionMode.READONLY
}

export function createTaskUserMessageActionInterop(input: {
  readonly message: SlateUserMessage
}): TaskUserMessageActionInterop {
  const userMessage = toInteropUserMessage(input.message)
  return new ConversationAction({
    action: { case: "userMessageAction", value: new UserMessageAction({ userMessage }) },
  })
}

export function conversationTurnFromBlobInterop(bytes: Uint8Array): ConversationTurnView {
  try {
    const turn = slateConversationTurnSerde.deserialize(bytes)
    return turn.kind === "agent"
      ? { kind: "agent", stepBlobIds: turn.stepBlobIds }
      : { kind: "other" }
  } catch (error) {
    if (error instanceof Error && error.message === "Invalid ConversationTurnStructure: missing turn case") {
      return { kind: "other" }
    }
    throw error
  }
}

const taskResultConversationStepSerde = createSlateConversationStepSerde(PrivacyMode.UNSPECIFIED)

export function conversationStepFromBlobInterop(bytes: Uint8Array): ConversationStepView {
  return conversationStepViewInterop(taskResultConversationStepSerde.deserialize(bytes))
}

export function conversationStepViewInterop(step: SlateConversationStep): ConversationStepView {
  if (step.kind === "assistant-message") {
    return {
      value: step,
      kind: "assistant",
      assistantText: step.text instanceof RedactedString
        ? step.text.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED)
        : step.text,
    }
  }
  return { value: step, kind: step.kind === "tool-call" ? "tool-call" : "other" }
}

export function taskEnvironmentToProtoInterop(environment: TaskEnvironment): number {
  switch (environment) {
    case "cloud":
      return SubagentExecutionEnvironment.CLOUD
    case "local":
      return SubagentExecutionEnvironment.LOCAL
    default:
      return SubagentExecutionEnvironment.UNSPECIFIED
  }
}

export function taskEnvironmentForTargetMachineInterop(placement: TaskTargetMachine): number {
  return placement.kind === "same-device"
    ? SubagentExecutionEnvironment.LOCAL
    : SubagentExecutionEnvironment.CLOUD
}

export function taskEnvironmentFromProtoInterop(environment: unknown): TaskEnvironment {
  switch (environment) {
    case SubagentExecutionEnvironment.CLOUD:
      return "cloud"
    case SubagentExecutionEnvironment.LOCAL:
      return "local"
    default:
      return undefined
  }
}

export function buildCloudSubagentPersistedStateInterop(
  input: CloudSubagentPersistedStateArgs,
): CloudSubagentPersistedStateInterop {
  return new SubagentPersistedState({
    environment: SubagentExecutionEnvironment.CLOUD,
    cloudSubagent: new CloudSubagentReference({
      bcId: input.agentId,
      ...(input.transcriptUri === undefined ? {} : { transcriptPath: input.transcriptUri }),
    }),
    ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
    machine: targetMachineToProtoInterop(input.targetMachine),
  })
}
