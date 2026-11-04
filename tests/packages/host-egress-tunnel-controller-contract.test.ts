import assert from "node:assert/strict"
import { test } from "node:test"

import {
  ANYRUN_NETWORK_TOKEN_HEADER,
  configFromEnv,
  configsEqual,
  EgressTunnelController,
  OFF_STATUS,
  type EgressTunnelClient,
  type EgressTunnelStatus,
} from "../../source/shared/node/egress-tunnel/egress-tunnel-controller.ts"
import type { TunnelConfig } from "../../source/shared/node/egress-tunnel/box-connection.ts"

interface RecordedClient extends EgressTunnelClient {
  starts: number
  stops: number
  emit(status: EgressTunnelStatus): void
}

function harness(env: NodeJS.ProcessEnv = {}) {
  const created: Array<{ config: TunnelConfig; client: RecordedClient }> = []
  const published: EgressTunnelStatus[] = []
  const controller = new EgressTunnelController({
    env,
    onStatus: status => published.push(status),
    createClient: ({ config, onStatus }) => {
      const client: RecordedClient = {
        starts: 0,
        stops: 0,
        emit: onStatus,
        start() { this.starts += 1 },
        stop() { this.stops += 1 },
      }
      created.push({ config, client })
      return client
    },
  })
  return { controller, created, published }
}

const boxConfig = (overrides: Partial<TunnelConfig> = {}): TunnelConfig => ({
  url: "wss://box.example/egress",
  bearer: "box-token",
  allowPrivateTargets: false,
  ...overrides,
})

test("environment settings require both credentials and limit private access to the explicit switch", () => {
  assert.equal(configFromEnv({ SLATE_EGRESS_TUNNEL_URL: "wss://relay.example" }), null)
  assert.equal(configFromEnv({ SLATE_EGRESS_TUNNEL_BEARER: "token" }), null)
  assert.deepEqual(configFromEnv({
    SLATE_EGRESS_TUNNEL_URL: "wss://relay.example",
    SLATE_EGRESS_TUNNEL_BEARER: "token",
    SLATE_EGRESS_TUNNEL_NETWORK_TOKEN: "network-token",
    SLATE_EGRESS_TUNNEL_ALLOW_PRIVATE: "true",
  }), {
    url: "wss://relay.example",
    bearer: "token",
    headers: { [ANYRUN_NETWORK_TOKEN_HEADER]: "network-token" },
    allowPrivateTargets: false,
  })
  assert.equal(configFromEnv({
    SLATE_EGRESS_TUNNEL_URL: "wss://relay.example",
    SLATE_EGRESS_TUNNEL_BEARER: "token",
    SLATE_EGRESS_TUNNEL_ALLOW_PRIVATE: "1",
  })?.allowPrivateTargets, true)
})

test("configuration equality compares header maps by content rather than insertion order", () => {
  const first = boxConfig({ headers: { authorization: "one", "x-slate-network-token": "two" } })
  const sameValuesDifferentOrder = boxConfig({ headers: { "x-slate-network-token": "two", authorization: "one" } })
  assert.equal(configsEqual(null, null), true)
  assert.equal(configsEqual(first, sameValuesDifferentOrder), true)
  assert.equal(configsEqual(first, boxConfig({ ...first, bearer: "different" })), false)
  assert.equal(configsEqual(first, boxConfig({ ...first, allowPrivateTargets: true })), false)
  assert.equal(configsEqual(first, boxConfig({ ...first, headers: { authorization: "changed" } })), false)
})

test("a tunnel waits for both enablement and a usable configuration, then reports client status", () => {
  const { controller, created, published } = harness()
  controller.setEnabled(true)
  assert.equal(created.length, 0)

  const config = boxConfig()
  controller.setBoxConnection(config)
  assert.equal(created.length, 1)
  assert.equal(created[0]?.client.starts, 1)
  assert.deepEqual(created[0]?.config, config)

  const connected: EgressTunnelStatus = { state: "connected", relayedStreams: 3, activeStreams: 1 }
  created[0]?.client.emit(connected)
  assert.equal(controller.getStatus(), connected)
  assert.equal(published.at(-1), connected)
})

test("equivalent settings keep the current client while a meaningful change replaces it", () => {
  const { controller, created } = harness()
  const first = boxConfig({ headers: { authorization: "one", "x-slate-network-token": "two" } })
  controller.setBoxConnection(first)
  controller.setEnabled(true)

  controller.setBoxConnection(boxConfig({
    headers: { "x-slate-network-token": "two", authorization: "one" },
  }))
  assert.equal(created.length, 1)
  assert.equal(created[0]?.client.stops, 0)

  controller.setBoxConnection(boxConfig({ bearer: "new-token" }))
  assert.equal(created.length, 2)
  assert.equal(created[0]?.client.stops, 1)
  assert.equal(created[1]?.client.starts, 1)
})

test("environment settings override a box and removing them falls back to the current box", () => {
  const env: NodeJS.ProcessEnv = {
    SLATE_EGRESS_TUNNEL_URL: "wss://environment.example/relay",
    SLATE_EGRESS_TUNNEL_BEARER: "environment-token",
  }
  const { controller, created } = harness(env)
  controller.setBoxConnection(boxConfig())
  controller.setEnabled(true)
  assert.equal(created[0]?.config.url, "wss://environment.example/relay")
  assert.equal(created[0]?.config.bearer, "environment-token")

  delete env.SLATE_EGRESS_TUNNEL_URL
  delete env.SLATE_EGRESS_TUNNEL_BEARER
  controller.setBoxConnection(boxConfig({ url: "wss://updated-box.example/egress" }))
  assert.equal(created.length, 2)
  assert.equal(created[0]?.client.stops, 1)
  assert.equal(created[1]?.config.url, "wss://updated-box.example/egress")
})

test("disabling or disposing stops the active client and publishes the off status", () => {
  const { controller, created, published } = harness()
  controller.setBoxConnection(boxConfig())
  controller.setEnabled(true)
  controller.setEnabled(false)
  assert.equal(created[0]?.client.stops, 1)
  assert.equal(controller.getStatus(), OFF_STATUS)
  assert.equal(published.at(-1), OFF_STATUS)

  controller.setEnabled(true)
  controller.dispose()
  assert.equal(created[1]?.client.stops, 1)
  assert.equal(controller.getStatus(), OFF_STATUS)
})
