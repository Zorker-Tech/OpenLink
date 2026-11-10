import assert from "node:assert/strict"
import test from "node:test"

import { HOST_ACCOUNT_SLOT } from "../../source/coordinator/gateway/gateway-client.ts"
import {
  applyCoordinatorTransportSignal,
  routeCoordinatorGatewayNotice,
  seedCoordinatorAgentRoster,
} from "../../source/coordinator/main-gateway-events.ts"

test("gateway notices go to only the ports that own them", () => {
  const seen: unknown[][] = []
  const listeners = new Set([(pending: unknown) => seen.push(["authorization", pending])])
  const ports = {
    authorizationListeners: listeners,
    echoRecorder: { recordSendEcho: (key: unknown) => seen.push(["echo", key]) },
    toolRelay: { accept: (payload: unknown) => seen.push(["tool", payload]) },
    controlEvents: { postEvent: (family: string, payload: unknown) => seen.push(["control", family, payload]) },
    rendererEvents: { postEvent: (family: string, payload: unknown) => seen.push(["renderer", family, payload]) },
  }

  routeCoordinatorGatewayNotice({
    channel: "mcp-oauth-pending",
    payload: { serverName: "search", redirectUrl: "https://auth.test", state: "s-1" },
  }, ports)
  routeCoordinatorGatewayNotice({
    channel: "transcript",
    payload: { type: "appended", entry: { kind: "message", role: "user", clientNonce: "n-1" } },
  }, ports)
  routeCoordinatorGatewayNotice({ channel: "agents", payload: { id: "a-1" } }, ports)
  routeCoordinatorGatewayNotice({ channel: "agent-upserted", payload: { id: "a-2" } }, ports)
  routeCoordinatorGatewayNotice({ channel: "client-side-tool-v2", payload: { id: "tool-1" } }, ports)

  assert.deepEqual(seen, [
    ["authorization", { serverName: "search", redirectUrl: "https://auth.test", state: "s-1" }],
    ["echo", { accountSlot: HOST_ACCOUNT_SLOT, clientNonce: "n-1" }],
    ["renderer", "transcript", { type: "appended", entry: { kind: "message", role: "user", clientNonce: "n-1" } }],
    ["control", "agents-event", { kind: "agents", event: { id: "a-1" } }],
    ["renderer", "agents", { id: "a-1" }],
    ["control", "agents-event", { kind: "agent-upserted", event: { id: "a-2" } }],
    ["renderer", "agent-upserted", { id: "a-2" }],
    ["tool", { id: "tool-1" }],
  ])
})

test("transport transitions update the control and renderer views and refresh only when connected", () => {
  const seen: unknown[][] = []
  const ports = {
    controlEvents: { postEvent: (family: string, payload: unknown) => seen.push(["control", family, payload]) },
    invalidateHealth: () => seen.push(["invalidate"]),
    refreshLocalExec: async () => { seen.push(["refresh"]); return undefined },
    seedAgentRoster: async () => { seen.push(["seed"]); return undefined },
    rendererEvents: { postEvent: (family: string, payload: unknown) => seen.push(["renderer", family, payload]) },
  }

  assert.equal(applyCoordinatorTransportSignal(null, ports), undefined)
  assert.equal(applyCoordinatorTransportSignal({ family: "transport-down", payload: { retrying: true } }, ports), false)
  assert.equal(applyCoordinatorTransportSignal({ family: "transport-up", payload: { retrying: false } }, ports), true)

  assert.deepEqual(seen, [
    ["control", "transport-down", { retrying: true }],
    ["invalidate"],
    ["renderer", "coordinator-transport-state", { state: "down" }],
    ["control", "transport-up", { retrying: false }],
    ["refresh"],
    ["seed"],
    ["renderer", "coordinator-transport-state", { state: "connected" }],
  ])
})

test("the agent roster is seeded when available and a read failure is only reported", async () => {
  const seen: unknown[][] = []
  const post = (family: string, payload: unknown) => seen.push(["post", family, payload])
  const report = (message: string) => seen.push(["warning", message])

  await seedCoordinatorAgentRoster(async () => [{ id: "a-1" }], post, report)
  await seedCoordinatorAgentRoster(async () => { throw new Error("offline") }, post, report)

  assert.deepEqual(seen, [
    ["post", "agents-roster-seed", { agents: [{ id: "a-1" }] }],
    ["warning", "agents roster seed skipped: Error: offline"],
  ])
})
