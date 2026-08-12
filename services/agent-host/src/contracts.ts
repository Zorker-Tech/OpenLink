import type { CommandSpec } from './pi-rpc.js'
import type { ProjectRuntimeDescriptor } from './project-runtime.js'

export type RuntimeKind = 'local-sandbox-runtime' | 'remote-opensandbox'

export interface LocalExecutionTarget {
  kind: 'local'
  workspaceRoot: string
  storageRoot: string
}

export interface SshExecutionTarget {
  kind: 'ssh'
  id: string
  host: string
  user: string
  port: number
  remoteRoot: string
}

export type ExecutionTarget = LocalExecutionTarget | SshExecutionTarget

export interface AgentPolicy {
  allowedDomains: string[]
  deniedDomains: string[]
  allowWrite: string[]
  denyWrite: string[]
  denyRead: string[]
  allowUnixSockets: string[]
}

/** Account-selected provider configuration supplied by the authenticated BFF. */
export interface AgentProviderRuntimeConfiguration {
  providerId: string
  modelId: string
  /** Empty only for providers that use ambient credentials (AWS/GCP). */
  apiKey: string
  baseUrl: string
  revision: string
}

/** Pi-native append-only session materialized from the Cloud PostgreSQL authority. */
export interface AgentNativeSessionSnapshot {
  header: Record<string, unknown>
  entries: Array<Record<string, unknown>>
}

/** Response to a Pi extension UI request while a prompt is active. */
export interface AgentExtensionUiResponse {
  id: string
  confirmed?: boolean
  value?: string
  cancelled?: true
}

export interface AgentLaunchSpec {
  userId: string
  workspaceId: string
  projectId: string
  sessionId: string
  target: ExecutionTarget
  workspaceRoot: string
  storageRoot: string
  piEntrypoint: string
  sessionDir: string
  model?: string
  environment: Record<string, string>
  policy: AgentPolicy
  browser?: BrowserAgentBinding
}

export interface BrowserAgentBinding {
  hostUrl: string
  sessionId: string
  controlToken: string
  extensionPath: string
}

export interface AgentEvent {
  type: 'stdout' | 'stderr' | 'exit' | 'error'
  data?: string
  code?: number | null
  message?: string
}

export interface AgentProcess {
  readonly command: CommandSpec
  readonly events: AsyncIterable<AgentEvent>
  send(data: string): Promise<void>
  stop(reason?: string): Promise<void>
}

export interface ProvisionedEnvironment {
  readonly runtime: RuntimeKind
  readonly workspaceRoot: string
  readonly storageRoot: string
  launchPi(spec: AgentLaunchSpec): Promise<AgentProcess>
  cleanup(): Promise<void>
}

export interface SandboxBackend {
  readonly runtime: RuntimeKind
  provision(spec: AgentLaunchSpec, projectRuntime?: ProjectRuntimeDescriptor): Promise<ProvisionedEnvironment>
}
