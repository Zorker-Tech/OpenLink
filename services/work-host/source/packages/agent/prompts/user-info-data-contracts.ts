import type { PromptRuleDescriptor } from "./rule-sections-contracts.ts"

/** Small, prompt-facing skill facts after request-context data has crossed the interop boundary. */
export interface UserInfoSkill {
  readonly fullPath: string
  readonly content?: string | undefined
  readonly description?: string | undefined
  readonly globs?: readonly string[] | undefined
  readonly environments?: readonly string[] | undefined
  readonly disabledEnvironments?: readonly string[] | undefined
  readonly disableModelInvocation?: boolean | undefined
}

export interface UserInfoGitRepository {
  readonly path: string
  readonly status: string
  readonly remoteUrl?: string | undefined
}

export type UserInfoMountedStoreKind = "unspecified" | "self" | "peer" | "share" | "principal"

export interface UserInfoMountedStore {
  readonly path: string
  readonly kind: UserInfoMountedStoreKind
  readonly alias?: string | undefined
  readonly readOnly: boolean
}

/** Only the machine facts the first-message context actually renders. */
export interface UserInfoEnvironment {
  readonly osVersion: string
  readonly shell?: string | undefined
  readonly workspacePaths: readonly string[]
  readonly projectFolder?: string | undefined
  readonly timeZone?: string | undefined
  readonly processWorkingDirectory?: string | undefined
  readonly agentTranscriptsFolder?: string | undefined
  readonly isWorkingDirHomeDir?: boolean | undefined
  readonly mountedAgentStores?: readonly UserInfoMountedStore[] | undefined
}

export interface UserInfoMcpTool {
  readonly toolName: string
}

export interface UserInfoMcpDescriptor {
  readonly serverName?: string | undefined
  readonly serverIdentifier: string
  readonly folderPath?: string | undefined
  readonly serverUseInstructions?: string | undefined
  readonly tools: readonly UserInfoMcpTool[]
}

export interface UserInfoMcpInstructions {
  readonly serverName?: string | undefined
  readonly instructions: string
}

export interface UserInfoMcpSnapshotToolNames {
  readonly discoveryToolName?: string | undefined
  readonly invocationToolName?: string | undefined
  readonly useDynamicToolNamespaces?: boolean | undefined
  readonly fetchMcpResourceToolName?: string | undefined
  readonly listMcpResourcesToolName?: string | undefined
}

export interface UserInfoMcpMetaToolOptions {
  readonly enabled: boolean
  readonly mcpDescriptors: readonly UserInfoMcpDescriptor[]
  readonly snapshotToolNames?: UserInfoMcpSnapshotToolNames | undefined
}

export interface UserInfoMcpFileSystemOptions {
  readonly enabled: boolean
  readonly workspaceProjectDir: string
  readonly mcpDescriptors: readonly UserInfoMcpDescriptor[]
}

export type UserInfoRule = PromptRuleDescriptor
