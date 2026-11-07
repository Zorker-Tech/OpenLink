/** Maps Slate task values to the current runner message shape at the migration boundary. */

import {
  NewCloudVmTarget,
  SameMachineTarget,
  SelfHostedPoolTarget,
  SelfHostedWorkerLabel,
  SelfHostedWorkerTarget,
  SubagentBackgroundReason,
  SubagentExecutionEnvironment,
  TargetMachine,
} from "../proto/generated/agent/v1/agent_pb.ts"
import { TaskMode } from "../proto/generated/agent/v1/subagents_pb.ts"
import type { TaskTargetMachine } from "../../../packages/agent/tools/task-runtime-types.ts"
import type {
  SlateTaskExecutionEnvironment,
  SlateTaskMode,
  SlateTaskToolBackgroundReason,
} from "../../../packages/agent/task-tool-call-state.ts"
import { SlateTaskBackgroundReason, type SlateTaskBackgroundReason as SlateTaskBackgroundReasonValue } from "../../../packages/agent/tools/task-result-state.ts"

export function taskModeFromInterop(value: unknown): SlateTaskMode | undefined {
  switch (value) {
    case TaskMode.UNSPECIFIED: return "unspecified"
    case TaskMode.AGENT: return "agent"
    case TaskMode.PLAN: return "plan"
    default: return undefined
  }
}

export function taskModeToInterop(value: SlateTaskMode): TaskMode {
  switch (value) {
    case "unspecified": return TaskMode.UNSPECIFIED
    case "agent": return TaskMode.AGENT
    case "plan": return TaskMode.PLAN
  }
}

export function taskExecutionEnvironmentFromInterop(value: unknown): SlateTaskExecutionEnvironment | undefined {
  switch (value) {
    case SubagentExecutionEnvironment.UNSPECIFIED: return "unspecified"
    case SubagentExecutionEnvironment.LOCAL: return "local"
    case SubagentExecutionEnvironment.CLOUD: return "cloud"
    default: return undefined
  }
}

export function taskExecutionEnvironmentToInterop(value: SlateTaskExecutionEnvironment): SubagentExecutionEnvironment {
  switch (value) {
    case "unspecified": return SubagentExecutionEnvironment.UNSPECIFIED
    case "local": return SubagentExecutionEnvironment.LOCAL
    case "cloud": return SubagentExecutionEnvironment.CLOUD
  }
}

export function taskBackgroundReasonFromInterop(value: unknown): SlateTaskBackgroundReasonValue {
  switch (value) {
    case SubagentBackgroundReason.AGENT_REQUEST: return SlateTaskBackgroundReason.AGENT_REQUEST
    case SubagentBackgroundReason.USER_REQUEST: return SlateTaskBackgroundReason.USER_REQUEST
    case SubagentBackgroundReason.QUEUED_FOLLOW_UP: return SlateTaskBackgroundReason.QUEUED_FOLLOW_UP
    case SubagentBackgroundReason.UNSPECIFIED: return SlateTaskBackgroundReason.UNSPECIFIED
    default: return typeof value === "number" && Number.isInteger(value) && value >= -2_147_483_648 && value <= 2_147_483_647
      ? `unknown-${value}`
      : SlateTaskBackgroundReason.UNKNOWN
  }
}

/** Imports only the background reasons represented by Slate's durable task contract. */
export function slateTaskBackgroundReasonFromInterop(value: unknown): SlateTaskToolBackgroundReason | undefined {
  switch (value) {
    case SubagentBackgroundReason.AGENT_REQUEST: return SlateTaskBackgroundReason.AGENT_REQUEST
    case SubagentBackgroundReason.USER_REQUEST: return SlateTaskBackgroundReason.USER_REQUEST
    case SubagentBackgroundReason.QUEUED_FOLLOW_UP: return SlateTaskBackgroundReason.QUEUED_FOLLOW_UP
    case SubagentBackgroundReason.UNSPECIFIED: return SlateTaskBackgroundReason.UNSPECIFIED
    default: return undefined
  }
}

export function taskBackgroundReasonToInterop(value: SlateTaskBackgroundReasonValue): SubagentBackgroundReason {
  switch (value) {
    case SlateTaskBackgroundReason.AGENT_REQUEST: return SubagentBackgroundReason.AGENT_REQUEST
    case SlateTaskBackgroundReason.USER_REQUEST: return SubagentBackgroundReason.USER_REQUEST
    case SlateTaskBackgroundReason.QUEUED_FOLLOW_UP: return SubagentBackgroundReason.QUEUED_FOLLOW_UP
    case SlateTaskBackgroundReason.UNSPECIFIED:
    case SlateTaskBackgroundReason.UNKNOWN:
      return SubagentBackgroundReason.UNSPECIFIED
    default: {
      const unknown = /^unknown-(-?\d+)$/.exec(value)
      return unknown === null ? SubagentBackgroundReason.UNSPECIFIED : Number(unknown[1]) as SubagentBackgroundReason
    }
  }
}

export function targetMachineToProtoInterop(placement: TaskTargetMachine): TargetMachine {
  switch (placement.kind) {
    case "same-device":
      return new TargetMachine({ machine: { case: "sameMachine", value: new SameMachineTarget() } })
    case "cloud-machine":
      return new TargetMachine({
        machine: {
          case: "newCloudVm",
          value: new NewCloudVmTarget({
            ...(placement.environmentBuildId === undefined ? {} : { environmentBuildId: placement.environmentBuildId }),
            ...(placement.baseBranch === undefined ? {} : { baseBranch: placement.baseBranch }),
          }),
        },
      })
    case "hosted-worker":
      return new TargetMachine({ machine: { case: "selfHostedWorker", value: new SelfHostedWorkerTarget({ workerId: placement.workerId }) } })
    case "worker-pool":
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
      return { kind: "same-device" }
    case "newCloudVm":
      return {
        kind: "cloud-machine",
        ...(wire.machine.value.environmentBuildId === undefined ? {} : { environmentBuildId: wire.machine.value.environmentBuildId }),
        ...(wire.machine.value.baseBranch === undefined ? {} : { baseBranch: wire.machine.value.baseBranch }),
      }
    case "selfHostedWorker":
      return { kind: "hosted-worker", workerId: wire.machine.value.workerId }
    case "selfHostedPool":
      return {
        kind: "worker-pool",
        ...(wire.machine.value.pool === undefined ? {} : { pool: wire.machine.value.pool }),
        ...(wire.machine.value.labels.length === 0 ? {} : { labels: Object.fromEntries(wire.machine.value.labels.map(({ key, value: labelValue }) => [key, labelValue])) }),
      }
    default:
      return undefined
  }
}
