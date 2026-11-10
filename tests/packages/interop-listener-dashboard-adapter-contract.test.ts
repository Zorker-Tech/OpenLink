import assert from "node:assert/strict"
import { test } from "node:test"

import {
  GetScmConnectionStatusRequest,
  GetSlackInstallUrlRequest,
  GetSlackUserSettingsRequest,
} from "../../source/adapters/interop/proto/generated/aiserver/v1/dashboard_pb.ts"
import { adaptListenerDashboardClient } from "../../source/adapters/interop/slate-backend/listener-integrations-dashboard.ts"

test("listener dashboard reads call their matching counterpart methods with typed empty requests", async () => {
  const calls: Array<[string, object]> = []
  const dashboard = adaptListenerDashboardClient({
    getSlackUserSettings: async request => { calls.push(["slack", request]); return { hasSlackAuth: true } as never },
    getScmConnectionStatus: async request => { calls.push(["scm", request]); return { connected: true } as never },
    getSlackInstallUrl: async request => { calls.push(["install", request]); return { url: "https://slack.invalid/install" } as never },
  })

  assert.deepEqual(await Promise.all([
    dashboard.getSlackUserSettings(),
    dashboard.getScmConnectionStatus(),
    dashboard.getSlackInstallUrl(),
  ]), [
    { hasSlackAuth: true },
    { connected: true },
    { url: "https://slack.invalid/install" },
  ])
  assert.deepEqual(calls.map(([name]) => name), ["slack", "scm", "install"])
  assert.equal(calls[0]?.[1] instanceof GetSlackUserSettingsRequest, true)
  assert.equal(calls[1]?.[1] instanceof GetScmConnectionStatusRequest, true)
  assert.equal(calls[2]?.[1] instanceof GetSlackInstallUrlRequest, true)
})
