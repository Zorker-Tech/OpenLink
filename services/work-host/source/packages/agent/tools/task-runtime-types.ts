/** A task placement after the request has been normalized into Slate-owned terms. */
export type TaskEnvironment = "cloud" | "local" | undefined

/** Slate's placement decision; legacy model and protobuf spellings are translated at adapters. */
export type TaskTargetMachine =
  | { readonly kind: "same-device" }
  | {
      readonly kind: "cloud-machine"
      readonly baseBranch?: string
      readonly environmentBuildId?: string
    }
  | { readonly kind: "hosted-worker"; readonly workerId: string }
  | {
      readonly kind: "worker-pool"
      readonly pool?: string
      readonly labels?: Readonly<Record<string, string>>
    }

/** The current model tool schema's placement shape, accepted only at its ingress adapter. */
export type LegacyTaskTargetMachine =
  | { readonly type: "same_machine" }
  | { readonly type: "new_cloud_vm"; readonly base_branch?: string; readonly environment_build_id?: string }
  | { readonly type: "self_hosted_worker"; readonly worker_id: string }
  | { readonly type: "self_hosted_pool"; readonly pool?: string; readonly labels?: Readonly<Record<string, string>> }

/** Copies placement values at state and request handoffs so caller-owned labels cannot mutate them later. */
export function cloneTaskTargetMachine(value: TaskTargetMachine): TaskTargetMachine {
  switch (value.kind) {
    case "same-device":
      return { kind: value.kind }
    case "cloud-machine":
      return {
        kind: value.kind,
        ...(value.baseBranch === undefined ? {} : { baseBranch: value.baseBranch }),
        ...(value.environmentBuildId === undefined ? {} : { environmentBuildId: value.environmentBuildId }),
      }
    case "hosted-worker":
      return { kind: value.kind, workerId: value.workerId }
    case "worker-pool":
      return {
        kind: value.kind,
        ...(value.pool === undefined ? {} : { pool: value.pool }),
        ...(value.labels === undefined ? {} : {
          labels: Object.fromEntries(Object.entries(value.labels).sort(([left], [right]) =>
            left < right ? -1 : left > right ? 1 : 0,
          )),
        }),
      }
  }
}

export function taskEnvironmentForTargetMachine(placement: TaskTargetMachine): Exclude<TaskEnvironment, undefined> {
  return placement.kind === "same-device" ? "local" : "cloud"
}

/** Slate's normalized request from the model-facing delegated-task tool. */
export interface SlateTaskRequest {
  readonly description?: string
  readonly prompt: string
  readonly model?: string
  readonly resume?: string
  readonly subagentType?: string
  readonly fileAttachments?: readonly string[]
  readonly environment?: TaskEnvironment
  readonly cloudBaseBranch?: string
  readonly requestedRuntimeBuildId?: string
  readonly targetMachine?: TaskTargetMachine
  readonly runInBackground?: boolean
  readonly interrupt?: boolean
}

/** Slate's prepared task arguments, before the runtime adapter encodes the runner message. */
export interface SlatePreparedTaskRawArgs {
  readonly description: string
  readonly prompt: string
  readonly model?: string
  readonly subagentType: string
  readonly resume?: string
  readonly runInBackground?: boolean
  readonly attachments: readonly string[]
  readonly environment: TaskEnvironment
  readonly cloudBaseBranch?: string
  readonly requestedRuntimeBuildId?: string
  readonly targetMachine: TaskTargetMachine
}

export type LegacyTaskTargetArgs = {
  readonly environment?: TaskEnvironment | undefined
  readonly cloud_base_branch?: string | undefined
  readonly cloud_requested_environment_build_id?: string | undefined
}

export type TaskTargetValidationArgs = LegacyTaskTargetArgs & {
  readonly machine?: LegacyTaskTargetMachine
}

export type CloudSubagentPersistedStateArgs = {
  readonly agentId: string
  readonly transcriptUri?: string
  readonly modelId?: string
  readonly targetMachine: TaskTargetMachine
}
