import {
  CloudSubagentReference,
  ConversationAction,
  NewCloudVmTarget,
  SameMachineTarget,
  SelfHostedPoolTarget,
  SelfHostedWorkerLabel,
  SelfHostedWorkerTarget,
  SubagentExecutionEnvironment,
  SubagentPersistedState,
  TargetMachine,
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

export type ConversationTurnView =
  | { readonly kind: "agent"; readonly stepBlobIds: readonly Uint8Array[] }
  | { readonly kind: "other" }

export interface ConversationStepView {
  readonly value: SlateConversationStep
  readonly kind: "assistant" | "tool-call" | "other"
  readonly assistantText?: string
}

export type TaskInitialActionInterop = ConversationAction
export type CloudSubagentPersistedStateInterop = SubagentPersistedState

export function isReadonlySubagentPermissionModeInterop(permissionMode: number): boolean {
  return permissionMode === CustomSubagentPermissionMode.READONLY
}

export function createTaskInitialUserActionInterop(input: {
  readonly message: SlateUserMessage
}): TaskInitialActionInterop {
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
  return placement.type === "same_machine"
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

export function targetMachineToProtoInterop(placement: TaskTargetMachine): TargetMachine {
  switch (placement.type) {
    case "same_machine":
      return new TargetMachine({ machine: { case: "sameMachine", value: new SameMachineTarget() } })
    case "new_cloud_vm":
      return new TargetMachine({
        machine: {
          case: "newCloudVm",
          value: new NewCloudVmTarget({
            ...(placement.environment_build_id === undefined ? {} : { environmentBuildId: placement.environment_build_id }),
            ...(placement.base_branch === undefined ? {} : { baseBranch: placement.base_branch }),
          }),
        },
      })
    case "self_hosted_worker":
      return new TargetMachine({ machine: { case: "selfHostedWorker", value: new SelfHostedWorkerTarget({ workerId: placement.worker_id }) } })
    case "self_hosted_pool":
      return new TargetMachine({
        machine: {
          case: "selfHostedPool",
          value: new SelfHostedPoolTarget({
            ...(placement.pool === undefined ? {} : { pool: placement.pool }),
            labels: Object.entries(placement.labels ?? {}).map(([key, value]) => new SelfHostedWorkerLabel({ key, value })),
          }),
        },
      })
  }
}

export function targetMachineFromProtoInterop(value: unknown): TaskTargetMachine | undefined {
  const wire = value as TargetMachine | undefined
  switch (wire?.machine.case) {
    case "sameMachine":
      return { type: "same_machine" }
    case "newCloudVm":
      return {
        type: "new_cloud_vm",
        ...(wire.machine.value.environmentBuildId === undefined ? {} : { environment_build_id: wire.machine.value.environmentBuildId }),
        ...(wire.machine.value.baseBranch === undefined ? {} : { base_branch: wire.machine.value.baseBranch }),
      }
    case "selfHostedWorker":
      return { type: "self_hosted_worker", worker_id: wire.machine.value.workerId }
    case "selfHostedPool":
      return {
        type: "self_hosted_pool",
        ...(wire.machine.value.pool === undefined ? {} : { pool: wire.machine.value.pool }),
        ...(wire.machine.value.labels.length === 0 ? {} : { labels: Object.fromEntries(wire.machine.value.labels.map(({ key, value: labelValue }) => [key, labelValue])) }),
      }
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
