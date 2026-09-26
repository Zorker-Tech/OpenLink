import { test } from "node:test"
import assert from "node:assert/strict"

import { normalizeEffectiveUserPluginsResponse } from "../../source/packages/cursor-plugins/backend-marketplace-client.ts"

// What a backend says a user has is normalized before it is used, since the response is written by a
// service that may be older or newer than the client.

test("a response with no plugins is handed back as it was", () => {
  // Nothing to normalize, so nothing is added: an empty answer stays an empty answer.
  assert.deepEqual(normalizeEffectiveUserPluginsResponse({}), {})
  assert.deepEqual(normalizeEffectiveUserPluginsResponse({ plugins: null }), { plugins: null })
  assert.deepEqual(normalizeEffectiveUserPluginsResponse({ plugins: [] }), { plugins: [] })
})


test("the entries a response carries are read into the shape the platform works with", () => {
  const response = normalizeEffectiveUserPluginsResponse({
    plugins: [
      { name: "my-plugin", pluginId: "p1", marketplaceId: "m1", marketplaceName: "Acme", gitUrl: "https://github.com/acme/plugins.git", gitRef: "main", enabled: true },
      { name: "no-marketplace", pluginId: "p2" },
    ],
    marketplaces: [{ id: "m1", name: "Acme" }],
  })

  assert.equal(response.plugins.length, 2)
  const first = response.plugins[0] as Record<string, unknown>
  assert.equal(first.name, "my-plugin")
  assert.equal(first.pluginId, "p1")
  // What the service did not say is not invented.
  const second = response.plugins[1] as Record<string, unknown>
  assert.equal(second.name, "no-marketplace")
  assert.equal(second.marketplaceId, undefined)
  assert.deepEqual(response.marketplaces, [{ id: "m1", name: "Acme" }])
})

test("a plugin's configured variables are read out of the shape they arrived in", () => {
  // A service may send them as its own message type, which has to be turned into plain data before the rest
  // of the platform reads it.
  const protoVariables = { toJson: () => ({ TOKEN: "abc" }) }
  const fromProto = normalizeEffectiveUserPluginsResponse({ plugins: [{ name: "mine", configuredVariables: protoVariables }] })
  assert.deepEqual((fromProto.plugins[0] as Record<string, unknown>).configuredVariables, { TOKEN: "abc" })

  // Variables that are already plain data, and a message that cannot be read, are left as they were.
  const plain = normalizeEffectiveUserPluginsResponse({ plugins: [{ name: "mine", configuredVariables: { TOKEN: "abc" } }] })
  assert.deepEqual((plain.plugins[0] as Record<string, unknown>).configuredVariables, { TOKEN: "abc" })
  const broken = { toJson: () => { throw new Error("cannot read"); } }
  const kept = normalizeEffectiveUserPluginsResponse({ plugins: [{ name: "mine", configuredVariables: broken }] })
  assert.equal((kept.plugins[0] as Record<string, unknown>).configuredVariables, broken)

  // A plugin that carries none at all is handed back as it was.
  const none = normalizeEffectiveUserPluginsResponse({ plugins: [{ name: "mine" }] })
  assert.deepEqual(none.plugins[0], { name: "mine" })
})

