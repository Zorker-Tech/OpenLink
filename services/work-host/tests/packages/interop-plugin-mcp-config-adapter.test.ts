import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { parseExternalPluginMcpConfig } from "../../source/adapters/interop/plugin-marketplace/plugin-mcp-config-adapter.ts"

describe("the plugin MCP configuration interop adapter", () => {
  it("reads external server entries into the host's plugin connection values", () => {
    const parsed = parseExternalPluginMcpConfig({
      mcpServers: {
        local: {
          command: "node",
          args: ["serve"],
          env: { REGION: "west" },
          enabledTools: ["read"],
          ignoredBySlate: true,
        },
        remote: { url: "https://mcp.example", headers: { authorization: "token" } },
      },
    })

    assert.equal(parsed.success, true)
    if (!parsed.success) return
    assert.deepEqual(parsed.data, {
      mcpServers: {
        local: { command: "node", args: ["serve"], env: { REGION: "west" }, enabledTools: ["read"] },
        remote: { url: "https://mcp.example", headers: { authorization: "token" } },
      },
    })
  })

  it("rejects invalid external server fields rather than returning a partial configuration", () => {
    assert.equal(parseExternalPluginMcpConfig({ mcpServers: { local: { command: "node", args: "not-a-list" } } }).success, false)
    assert.equal(parseExternalPluginMcpConfig({ mcpServers: "not-a-server-map" }).success, false)
  })
})
