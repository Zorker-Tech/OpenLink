import assert from "node:assert/strict"
import test from "node:test"

import { GetTeamsRequest, PublishPluginRequest, UnpublishPluginRequest } from "../../source/adapters/interop/proto/generated/aiserver/v1/dashboard_pb.ts"
import { adaptDashboardSkillPublishClient } from "../../source/adapters/interop/agent/skill-publish-dashboard-adapter.ts"

test("the first-party skill-publish client is projected to dashboard RPC messages at the boundary", async () => {
  const seen: Array<{ readonly method: string; readonly request: unknown; readonly timeoutMs: number }> = []
  const client = adaptDashboardSkillPublishClient({
    async getTeams(request, options) {
      seen.push({ method: "teams", request, timeoutMs: options.timeoutMs })
      return { teams: [{ id: 7, name: "Team Seven", isDirectMember: true }] }
    },
    async publishPlugin(request, options) {
      seen.push({ method: "publish", request, timeoutMs: options.timeoutMs })
      return { pluginId: 42n, commitSha: "commit-a" }
    },
    async unpublishPlugin(request, options) {
      seen.push({ method: "unpublish", request, timeoutMs: options.timeoutMs })
      return { accepted: true }
    },
  })

  assert.deepEqual(await client.getTeams(), { teams: [{ id: 7, name: "Team Seven", isDirectMember: true }] })
  assert.deepEqual(await client.publishPlugin({
    teamId: 7,
    name: "skill-one",
    displayName: "Skill One",
    description: "Does one thing",
    pluginArchive: new Uint8Array([1, 2, 3]),
  }), { pluginId: "42", commitSha: "commit-a" })
  assert.deepEqual(await client.unpublishPlugin({ pluginId: "42", teamId: 7 }), { accepted: true })

  const teamsRequest = seen[0]?.request
  const publishRequest = seen[1]?.request
  const unpublishRequest = seen[2]?.request
  assert.equal(teamsRequest instanceof GetTeamsRequest, true)
  assert.equal((teamsRequest as GetTeamsRequest).activeOnly, true)
  assert.equal(publishRequest instanceof PublishPluginRequest, true)
  assert.equal((publishRequest as PublishPluginRequest).pluginTarGz.byteLength, 3)
  assert.equal(unpublishRequest instanceof UnpublishPluginRequest, true)
  assert.equal((unpublishRequest as UnpublishPluginRequest).pluginId, 42n)
  assert.deepEqual(seen.map(entry => entry.timeoutMs), [10_000, 60_000, 60_000])
})
