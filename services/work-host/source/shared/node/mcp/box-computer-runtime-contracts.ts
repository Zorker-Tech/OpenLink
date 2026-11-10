import type { SlateMcpServerConfig } from "./mcp-display-runtime.ts"

export interface BoxComputerRuntimePlan {
  readonly shared: boolean
  readonly containerName: string
  readonly dockerHost: string | undefined
  readonly dockerPath: "docker"
}

export type BoxComputerServerDefinition = Extract<SlateMcpServerConfig, { command: string }> & { readonly type: "stdio" }
