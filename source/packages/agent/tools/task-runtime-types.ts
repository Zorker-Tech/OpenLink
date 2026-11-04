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

export type LegacyTaskTargetArgs = {
  readonly environment?: TaskEnvironment | undefined
  readonly cloud_base_branch?: string | undefined
  readonly cloud_requested_environment_build_id?: string | undefined
}

export type TaskTargetValidationArgs = LegacyTaskTargetArgs & {
  readonly machine?: TaskTargetMachine
}

export type CloudSubagentPersistedStateArgs = {
  readonly bcId: string
  readonly transcriptPath?: string
  readonly modelId?: string
  readonly machine: TaskTargetMachine
}
