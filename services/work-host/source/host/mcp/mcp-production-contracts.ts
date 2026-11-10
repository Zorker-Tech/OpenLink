import type { HostExtensionContext } from "../extensions/host-extensions.ts"
import type { CapableBox } from "../boxes/box-capabilities.ts"

export interface McpProductionAuth {
  getAccessToken(args: { backendUrl: string }): Promise<string>
  getMachineId(): Promise<string>
  peekAccessToken(): string | null
  subscribeToRenewal(listener: (event: { outcome: string; isFirstCredential?: boolean }) => void): () => void
}

export interface McpProductionDependencies {
  readonly auth: McpProductionAuth
  readonly experiments: { readonly isSparsePluginClonesEnabled: () => boolean }
  readonly "forever-box": { readonly box: CapableBox }
  readonly settings: unknown
  readonly telemetry: {
    readonly logs: {
      readonly reportMcpDiscoveryFailed: (event: unknown) => void
      readonly reportConnectorAuth: (event: unknown) => void
      readonly reportPluginSkillsSync: (event: unknown) => void
      readonly reportSkillPublishEdgeFailed: (event: unknown) => void
    }
  }
}

export type McpProductionContext = HostExtensionContext<{ readonly log: (message: string) => void }> & {
  readonly deps: McpProductionDependencies
}
