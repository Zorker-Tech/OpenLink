import assert from "node:assert/strict"
import { test } from "node:test"

import { createMcpAccountWriterAdapters } from "../../source/adapters/interop/agent/mcp-catalog-install-adapter.ts"

test("the MCP account adapter maps Slate string ids to remote integer ids", async () => {
  const calls: Array<{ readonly method: string; readonly value: unknown }> = []
  const remote = {
    async getConfigForEdit() {
      return { config: { mcpServers: { search: { url: "https://search.test" } } }, serverIdsByName: { search: 41n } }
    },
    async setConfig(config: { mcpServers: Record<string, unknown> }, serverIdsByName: Readonly<Record<string, bigint>>) {
      calls.push({ method: "setConfig", value: { config, serverIdsByName } })
    },
    async installPlugin(args: { pluginId: bigint; variables?: Readonly<Record<string, string>> }) {
      calls.push({ method: "installPlugin", value: args })
    },
    async uninstallPlugin(args: { pluginId: bigint }) {
      calls.push({ method: "uninstallPlugin", value: args })
    },
    async updatePluginInstall(args: { pluginId: bigint; variables: Readonly<Record<string, string>> }) {
      calls.push({ method: "updatePluginInstall", value: args })
    },
  }

  const ports = createMcpAccountWriterAdapters(remote)
  assert.deepEqual(await ports.accountWriter.getConfigForEdit(), {
    config: { mcpServers: { search: { url: "https://search.test" } } },
    serverIdsByName: { search: "41" },
  })

  await ports.accountWriter.setConfig({ mcpServers: { search: { url: "https://search.test" } } }, { search: "42" })
  await ports.accountWriter.uninstallPlugin({ pluginId: "43" })
  await ports.catalogInstallPort.installPlugin({ pluginId: "44" })
  await ports.catalogInstallPort.installPlugin({ pluginId: "45", values: { token: "x" } })
  await ports.catalogInstallPort.updatePluginInstall({ pluginId: "46", values: { token: "y" } })

  assert.deepEqual(calls, [
    { method: "setConfig", value: { config: { mcpServers: { search: { url: "https://search.test" } } }, serverIdsByName: { search: 42n } } },
    { method: "uninstallPlugin", value: { pluginId: 43n } },
    { method: "installPlugin", value: { pluginId: 44n } },
    { method: "installPlugin", value: { pluginId: 45n, variables: { token: "x" } } },
    { method: "updatePluginInstall", value: { pluginId: 46n, variables: { token: "y" } } },
  ])
})
