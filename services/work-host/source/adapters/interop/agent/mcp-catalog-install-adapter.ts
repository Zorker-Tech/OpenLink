import { parseAccountMcpConfigJson, type createAccountMcpWriter } from "../slate-backend/account-mcp.ts"
import type { McpAccountWriterPort } from "../../../shared/node/mcp/mcp-manager.ts"
import type { McpCatalogInstallPort } from "../../../shared/node/mcp/mcp-catalog-flow.ts"

type RemoteAccountWriter = ReturnType<typeof createAccountMcpWriter>

function remoteIds(ids: Readonly<Record<string, string>>): Record<string, bigint> {
  return Object.fromEntries(Object.entries(ids).map(([name, id]) => [name, BigInt(id)]))
}

function slateIds(ids: Readonly<Record<string, bigint>>): Record<string, string> {
  return Object.fromEntries(Object.entries(ids).map(([name, id]) => [name, id.toString()]))
}

function remoteConfig(config: { readonly mcpServers: Readonly<Record<string, unknown>> }) {
  const parsed = parseAccountMcpConfigJson(JSON.stringify(config))
  if (parsed === null) throw new TypeError("MCP account configuration is not valid for the account service.")
  return parsed
}

/** Keep account-service integer ids and config encoding at the interoperability edge. */
export function createMcpAccountWriterAdapters(writer: RemoteAccountWriter): {
  readonly accountWriter: McpAccountWriterPort
  readonly catalogInstallPort: McpCatalogInstallPort
} {
  return {
    accountWriter: {
      async getConfigForEdit() {
        const result = await writer.getConfigForEdit()
        return {
          config: { mcpServers: { ...result.config.mcpServers } },
          serverIdsByName: slateIds(result.serverIdsByName),
        }
      },
      async setConfig(config, serverIdsByName) {
        await writer.setConfig(remoteConfig(config), remoteIds(serverIdsByName))
      },
      async uninstallPlugin({ pluginId }) {
        await writer.uninstallPlugin({ pluginId: BigInt(pluginId) })
      },
    },
    catalogInstallPort: {
      async installPlugin({ pluginId, values }) {
        const variables = values == null || Object.keys(values).length === 0 ? undefined : { ...values }
        await writer.installPlugin({ pluginId: BigInt(pluginId), ...(variables === undefined ? {} : { variables }) })
      },
      async updatePluginInstall({ pluginId, values }) {
        await writer.updatePluginInstall({ pluginId: BigInt(pluginId), variables: { ...values } })
      },
    },
  }
}
