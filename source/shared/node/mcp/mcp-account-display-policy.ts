import { normalizeMcpAccountLabel } from "../../mcp.ts"
import { SlateMcpConfigError } from "./mcp-config-error.ts"
import type { SlateMcpAccountDisplay, SlateMcpDisplayRow, SlateMcpServerConfig } from "./mcp-display-contracts.ts"

export function normalizeAccountLabel(raw: string): string {
  const normalized = normalizeMcpAccountLabel(raw)
  if (normalized.length === 0) throw new SlateMcpConfigError("MCP account label is required.")
  return normalized
}

export function projectAccountRuntimeConfig(
  display: SlateMcpAccountDisplay | null,
): { mcpServers: Record<string, SlateMcpServerConfig> } | null {
  if (display === null) return null

  const mcpServers: Record<string, SlateMcpServerConfig> = {}
  for (const server of display.servers) {
    if (server.serverIdentifier == null || server.disabledByTeamAdminPolicy) continue
    mcpServers[server.serverIdentifier] = server.config
  }
  return { mcpServers }
}

export function parseMarketplacePluginIdentifier(raw: string): string {
  const identifier = raw.trim()
  if (!/^\d+$/.test(identifier)) throw new SlateMcpConfigError(`Invalid marketplace plugin id "${raw}".`)
  return identifier
}

export function projectPluginAttribution(server: SlateMcpDisplayRow): Record<string, unknown> {
  return {
    ...(server.pluginId == null ? {} : { pluginId: server.pluginId }),
    ...(server.isRequired === true ? { isRequired: true } : {}),
    ...(server.managedByTeamPluginPolicy === true ? { managedByTeamPluginPolicy: true } : {}),
  }
}
