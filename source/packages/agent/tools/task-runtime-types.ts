/** A task placement after the request has been normalized into Slate-owned terms. */
export type TaskEnvironment = "cloud" | "local" | undefined

export type TaskTargetMachine =
  | { readonly type: "same_machine" }
  | {
      readonly type: "new_cloud_vm"
      readonly base_branch?: string
      readonly environment_build_id?: string
    }
  | { readonly type: "self_hosted_worker"; readonly worker_id: string }
  | {
      readonly type: "self_hosted_pool"
      readonly pool?: string
      readonly labels?: Readonly<Record<string, string>>
    }

export function taskEnvironmentForTargetMachine(placement: TaskTargetMachine): Exclude<TaskEnvironment, undefined> {
  return placement.type === "same_machine" ? "local" : "cloud"
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
  readonly machine?: TaskTargetMachine
}

export type CloudSubagentPersistedStateArgs = {
  readonly agentId: string
  readonly transcriptUri?: string
  readonly modelId?: string
  readonly targetMachine: TaskTargetMachine
}
