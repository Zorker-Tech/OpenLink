import type { SpawnOptions } from "node:child_process"

export type HelperNetworkPolicy = {
  readonly version: 1
  readonly default?: "allow" | "deny"
  readonly allow?: readonly string[]
  readonly deny?: readonly string[]
  readonly logging?: unknown
  readonly [key: string]: unknown
}

export type HelperSandboxPolicy = {
  readonly type: "workspace_readwrite" | "workspace_readonly" | "insecure_none"
  readonly networkPolicy?: HelperNetworkPolicy
  readonly networkPolicyStrict?: boolean
}

export type HelperShellOptions = {
  readonly cwd?: string
  readonly env?: NodeJS.ProcessEnv
  readonly shell?: boolean | string
  readonly stdio?: SpawnOptions["stdio"]
}

export type HelperPolicyEnvelope = {
  readonly sandbox: unknown
  readonly networkPolicy?: HelperNetworkPolicy
  readonly networkPolicyStrict?: false
}
