import { DashboardService } from "../proto/generated/aiserver/v1/dashboard_connect.ts"
import { GetTeamsRequest, PublishPluginRequest, UnpublishPluginRequest } from "../proto/generated/aiserver/v1/dashboard_pb.ts"
import { createSlateBackendClient, getSlateInferenceBackendUrl } from "../slate-backend/slate-backend-client.ts"
import type {
  PublishedSkillResult,
  SkillPublishClient,
  SkillPublishPayload,
  SkillPublishTeam,
  UnpublishSkillRequest,
} from "../../../host/skills/skill-publish-contracts.ts"
import { SKILL_PUBLISH_REQUEST_TIMEOUT_MS, SKILL_PUBLISH_TARGETS_TIMEOUT_MS } from "../../../host/skills/skill-publish-contracts.ts"

interface DashboardSkillWireClient {
  getTeams(request: GetTeamsRequest, options: { timeoutMs: number }): Promise<{ teams: readonly SkillPublishTeam[] }>
  publishPlugin(request: PublishPluginRequest, options: { timeoutMs: number }): Promise<{ pluginId: string | number | bigint; commitSha: string }>
  unpublishPlugin(request: UnpublishPluginRequest, options: { timeoutMs: number }): Promise<unknown>
}

/** Binds the service's first-party publish vocabulary to the dashboard wire messages. */
export function adaptDashboardSkillPublishClient(wire: DashboardSkillWireClient): SkillPublishClient {
  return {
    async getTeams() {
      const response = await wire.getTeams(
        new GetTeamsRequest({ activeOnly: true }),
        { timeoutMs: SKILL_PUBLISH_TARGETS_TIMEOUT_MS },
      )
      return { teams: response.teams.map(team => ({ id: team.id, isDirectMember: team.isDirectMember, name: team.name })) }
    },
    async publishPlugin(payload: SkillPublishPayload): Promise<PublishedSkillResult> {
      const response = await wire.publishPlugin(new PublishPluginRequest({
        teamId: payload.teamId,
        name: payload.name,
        displayName: payload.displayName,
        description: payload.description,
        pluginTarGz: new Uint8Array(payload.pluginArchive),
      }), { timeoutMs: SKILL_PUBLISH_REQUEST_TIMEOUT_MS })
      return { pluginId: response.pluginId.toString(), commitSha: response.commitSha }
    },
    async unpublishPlugin(request: UnpublishSkillRequest) {
      return await wire.unpublishPlugin(new UnpublishPluginRequest({
        pluginId: BigInt(request.pluginId),
        teamId: request.teamId,
      }), { timeoutMs: SKILL_PUBLISH_REQUEST_TIMEOUT_MS })
    },
  }
}

export function createSlateSkillPublishClient(deps: {
  readonly auth: {
    getAccessToken(args: { backendUrl: string }): Promise<string>
    getMachineId(): Promise<string>
  }
}): SkillPublishClient {
  const wire = createSlateBackendClient(DashboardService, {
    getAccessToken: async () => await deps.auth.getAccessToken({ backendUrl: getSlateInferenceBackendUrl() }),
    getMachineId: deps.auth.getMachineId,
  }) as unknown as DashboardSkillWireClient
  return adaptDashboardSkillPublishClient(wire)
}
