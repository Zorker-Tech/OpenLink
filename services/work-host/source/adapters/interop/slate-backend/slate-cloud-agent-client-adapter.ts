/** Binds the cloud-agent and dashboard service schemas to Slate's cloud-agent ports. */
import { BackgroundComposerService } from "../proto/generated/aiserver/v1/background_composer_connect.ts"
import { DashboardService } from "../proto/generated/aiserver/v1/dashboard_connect.ts"
import { createSlateBackendClient } from "./slate-backend-client.ts"
import type {
  CloudAgentClient,
  DashboardClient,
  SlateCloudAgentManagerOptions,
} from "../../../host/cloud-agents/cloud-agent-manager-contracts.ts"
import type { SavedEnvironment } from "../../../host/cloud-agents/cloud-agent-watch-policy.ts"

type ClientBindings = Pick<SlateCloudAgentManagerOptions, "getAccessToken" | "getMachineId" | "onRequestId">

interface WireCloudAgentClient {
  getEnvironment(request: { publicId: string }): Promise<{ environment?: Record<string, unknown> }>
  listEnvironments(request: { includeRepositoryScopeEnvironments: true; limit: number }): Promise<{ environments: readonly Record<string, unknown>[] }>
  startBackgroundComposerFromSnapshot(request: Record<string, unknown>): Promise<{ composer?: { bcId?: string } }>
  getBackgroundComposerInfo(request: Record<string, unknown>, options?: { timeoutMs: number }): Promise<{ composer?: Record<string, unknown> }>
  listBackgroundComposers(request: { n: number }): Promise<{ composers: readonly Record<string, unknown>[] }>
  addAsyncFollowupBackgroundComposer(request: Record<string, unknown>): Promise<{ runId?: string }>
  pauseBackgroundComposer(request: Record<string, unknown>): Promise<void>
  renameBackgroundComposer(request: Record<string, unknown>): Promise<void>
  archiveBackgroundComposer(request: Record<string, unknown>): Promise<void>
  deleteBackgroundComposer(request: Record<string, unknown>): Promise<void>
  listBackgroundComposerArtifacts(request: Record<string, unknown>): Promise<{
    artifacts: readonly { absolutePath: string; sizeBytes: number | bigint }[]
  }>
  getBackgroundComposerConversation(request: Record<string, unknown>): Promise<{ conversation: unknown }>
  getPullRequestMergeStatus(request: { prUrl: string }): Promise<{
    isMerged?: boolean
    isClosed?: boolean
    isDraft?: boolean
    state?: string
  }>
  getOptimizedDiffDetails(request: Record<string, unknown>): Promise<{
    diff?: { diffs?: readonly { from: string; to: string; added: number; removed: number }[] }
  }>
}

function clientOptions(bindings: ClientBindings) {
  return {
    getAccessToken: bindings.getAccessToken,
    getMachineId: bindings.getMachineId,
    ...(bindings.onRequestId === undefined ? {} : { onRequestId: bindings.onRequestId }),
  }
}

function wireRequest(request: Record<string, unknown>): Record<string, unknown> {
  const { agentId, ...owned } = request
  return {
    ...owned,
    ...(agentId === undefined ? {} : { bcId: agentId }),
  }
}

/** Projects one external cloud-agent record into Slate's own record, including its nested run. */
function agentRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined
  const { bcId, composer, ...owned } = value as Record<string, unknown>
  const nested = composer === undefined ? undefined : agentRecord(composer)
  return {
    ...owned,
    ...(bcId === undefined ? {} : { agentId: bcId }),
    ...(nested === undefined ? {} : { agent: nested }),
  }
}

function agentEnvelope(response: { composer?: Record<string, unknown> }): { agent?: Record<string, unknown> } {
  if (response.composer === undefined) return {}
  const agent = agentRecord(response.composer)
  return agent === undefined ? {} : { agent }
}

export function createSlateCloudAgentClient(bindings: ClientBindings): CloudAgentClient {
  const wire = createSlateBackendClient(BackgroundComposerService, clientOptions(bindings)) as unknown as WireCloudAgentClient
  return {
    getEnvironment: async request => {
      const response = await wire.getEnvironment(request)
      return response.environment === undefined ? {} : { environment: response.environment as SavedEnvironment }
    },
    listEnvironments: async request => ({
      environments: (await wire.listEnvironments(request)).environments as readonly SavedEnvironment[],
    }),
    launch: async request => {
      const response = await wire.startBackgroundComposerFromSnapshot(wireRequest(request))
      const agentId = response.composer?.bcId
      return agentId === undefined ? {} : { agent: { agentId } }
    },
    get: async (request, options) => agentEnvelope(await wire.getBackgroundComposerInfo(wireRequest(request), options)),
    list: async request => ({
      agents: (await wire.listBackgroundComposers(request)).composers
        .map(agentRecord)
        .filter((agent): agent is Record<string, unknown> => agent !== undefined),
    }),
    reply: request => wire.addAsyncFollowupBackgroundComposer(wireRequest(request)),
    pause: request => wire.pauseBackgroundComposer(wireRequest(request)),
    rename: request => wire.renameBackgroundComposer(wireRequest(request)),
    archive: request => wire.archiveBackgroundComposer(wireRequest(request)),
    delete: request => wire.deleteBackgroundComposer(wireRequest(request)),
    listArtifacts: request => wire.listBackgroundComposerArtifacts(wireRequest(request)),
    getConversation: request => wire.getBackgroundComposerConversation(wireRequest(request)),
    getPullRequestMergeStatus: request => wire.getPullRequestMergeStatus(request),
    getDiffDetails: request => wire.getOptimizedDiffDetails(wireRequest(request)),
  }
}

export function createSlateCloudAgentDashboardClient(bindings: ClientBindings): DashboardClient {
  return createSlateBackendClient(DashboardService, clientOptions(bindings)) as unknown as DashboardClient
}
