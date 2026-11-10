import type { CloudAgentImage } from "./cloud-agent-images.ts"
import type { slateQuietWorkOriginKey } from "../slate-quiet-work-origin.ts"

/** Locations accepted by the agent tool. */
export type CloudAgentEnvironment =
  | { readonly type: "cloud" }
  | { readonly type: "pool"; readonly name?: string; readonly team_id?: number }
  | { readonly type: "machine"; readonly name: string; readonly team_id?: number }
  | { readonly type: "environment"; readonly id?: string; readonly name?: string }

export type CloudAgentAction =
  | "launch"
  | "list"
  | "models"
  | "get"
  | "dump"
  | "watch"
  | "reply"
  | "rename"
  | "cancel"
  | "archive"
  | "unarchive"
  | "delete"
  | "list_artifacts"

/** The action payload shared by the tool schema and its host-side handlers. */
export interface CloudAgentToolArgs {
  readonly action: CloudAgentAction
  readonly prompt?: string
  readonly images?: readonly { readonly url: string }[]
  readonly repo_url?: string
  readonly starting_ref?: string
  readonly model?: string
  readonly model_params?: Readonly<Record<string, string>>
  readonly title?: string
  readonly environment?: CloudAgentEnvironment
  readonly interrupt?: boolean
  readonly agent_id?: string
  readonly scope?: "launched" | "all"
  readonly include_archived?: boolean
  readonly limit?: number
  readonly confirm?: boolean
}

/** A selectable value exposed by the host's model catalog. */
export interface CloudModelParam {
  readonly id: string
  readonly values: readonly { readonly value: string }[]
  readonly incompatibleWith?: Readonly<Record<string, readonly string[]>>
}

export interface CloudModelCatalogEntry {
  readonly id: string
  readonly displayName?: string
  readonly aliases: readonly string[]
  readonly params: readonly CloudModelParam[]
  readonly incompatibilities?: readonly string[]
}

export interface CloudAgentSummary {
  readonly agentId: string
  readonly name: string
  readonly status: string
  readonly isArchived: boolean
  readonly branchName: string
  readonly prUrl: string
  readonly url: string
}

export interface CloudAgentDetail extends CloudAgentSummary {
  readonly filesChanged: number
  readonly linesAdded: number
  readonly linesRemoved: number
  readonly error?: string
}

/** Requests passed from the tool layer to the Slate cloud-agent manager. */
export interface CloudAgentLaunchRequest {
  readonly prompt: string
  readonly repoUrl: string | undefined
  readonly startingRef: string | undefined
  readonly modelId: string | undefined
  readonly modelParams: Readonly<Record<string, string>> | undefined
  readonly images: readonly CloudAgentImage[]
  readonly title: string | undefined
  readonly environment: CloudAgentRuntimeEnvironment | undefined
}

export interface CloudAgentReplyRequest {
  readonly agentId: string
  readonly prompt: string
  readonly modelId: string | undefined
  readonly modelParams: Readonly<Record<string, string>> | undefined
  readonly images: readonly CloudAgentImage[]
  readonly interrupt: boolean
}

/** Canonical environment object accepted by the Slate manager. */
export type CloudAgentRuntimeEnvironment =
  | { readonly type: "cloud" }
  | { readonly type: "pool" | "machine"; readonly name: string | undefined; readonly teamId: number | undefined }
  | { readonly type: "environment"; readonly publicId: string | undefined; readonly name: string | undefined }

export interface CloudAgentApi {
  launch(args: CloudAgentLaunchRequest): Promise<{ agentId: string; url: string }>
  list(args: { limit?: number; includeArchived?: boolean }): Promise<CloudAgentSummary[]>
  listModels(): Promise<CloudModelCatalogEntry[]>
  get(id: string): Promise<CloudAgentDetail | null>
  getTranscriptDump(args: { agentId: string }): Promise<{ status: string; lineCount: number; jsonl: string } | null>
  reply(args: CloudAgentReplyRequest): Promise<{ runId: string }>
  rename(id: string, title: string): Promise<unknown>
  cancel(id: string): Promise<unknown>
  setArchived(id: string, archived: boolean): Promise<unknown>
  delete(id: string): Promise<unknown>
  listArtifacts(id: string): Promise<readonly { path: string; sizeBytes: number }[]>
}

export interface CloudAgentToolContext {
  readonly signal: AbortSignal
  get(key: typeof slateQuietWorkOriginKey): unknown
}

export interface CloudAgentToolDeps {
  readonly api: CloudAgentApi
  readonly launchedIds: Set<string>
  readonly agentDir: string
  readonly readBoxFile?: (ctx: CloudAgentToolContext, path: string) => Promise<Uint8Array>
  readonly writeBoxFile: (ctx: CloudAgentToolContext, path: string, data: Uint8Array) => Promise<unknown>
  readonly toolCallId?: string
  readonly reviewAction?: (input: {
    readonly args: CloudAgentToolArgs
    readonly toolCallId: string
    readonly images: readonly CloudAgentImage[]
    readonly signal?: AbortSignal
  }) => Promise<{ allowed: boolean; reason: string }>
  readonly watch?: (id: string, options: { quietOrigin: unknown; afterFollowup?: boolean }) => void
  readonly onLaunched?: (event: { agentId: string; model?: string }) => void
  readonly onFollowupSent?: (event: { agentId: string; interrupt: boolean; model?: string }) => void
}
