/** Converts external MCP dashboard and manager responses to the host service's own port shapes. */

import type { McpBackendExecPort } from "../../../shared/node/mcp/mcp-manager.ts"
import type { CatalogField, CatalogPlugin, EffectivePlugin, McpServerSummary, ServerState } from "../../../host/mcp/mcp-service-contracts.ts"
import type { createDashboardSlateBackendMcpExec } from "../cursor-backend/backend-mcp-exec.ts"

/** One account server as the host-facing management port returns it. */
export function toInstalledServer(summary: McpServerSummary): Record<string, unknown> {
  return {
    id: summary.id,
    name: summary.name,
    serverIdentifier: summary.serverIdentifier,
    accountKey: summary.accountKey,
    ...(summary.pluginId == null ? {} : { pluginId: summary.pluginId }),
    isTeamServer: summary.isTeamServer,
    status: summary.status,
    ...(summary.statusDetail == null ? {} : { statusDetail: summary.statusDetail }),
    transport: summary.transport,
    toolCount: summary.toolCount,
    ...(summary.disabledToolCount == null ? {} : { disabledToolCount: summary.disabledToolCount }),
    customInstructions: summary.customInstructions,
  }
}

export function toInstalledServers(state: ServerState): Record<string, unknown>[] {
  return state.servers.map(toInstalledServer)
}

/** Optional marketplace field flags become explicit values in the host form model. */
export function toCatalogFields(fields?: readonly CatalogField[] | null): Array<Required<CatalogField>> {
  return (fields ?? []).map(field => ({
    key: field.key,
    label: field.label,
    hint: field.hint,
    isRequired: field.isRequired === true,
    isSecret: field.isSecret === true,
  }))
}

/** Dashboard auth statuses are normalized to the outcome names the host exposes. */
export function toAuthResult(result: { status: string; serverName: string; authorizationUrl?: string; message?: string }): Record<string, unknown> {
  if (result.status === "started") return { kind: "started", authorizationUrl: result.authorizationUrl, serverName: result.serverName }
  if (result.status === "already-authenticated") return { kind: "already-authenticated", serverName: result.serverName }
  if (result.status === "not-configured") return { kind: "not-configured", serverName: result.serverName }
  return { kind: result.status, message: result.message, serverName: result.serverName }
}

export const catalogViewsOf = (views: readonly unknown[]): CatalogPlugin[] => views as CatalogPlugin[]
export const serverStateFromManager = (state: unknown): ServerState => state as ServerState
export const authOutcomeFromManager = (result: unknown): { status: string; serverName: string; authorizationUrl?: string; message?: string } =>
  result as { status: string; serverName: string; authorizationUrl?: string; message?: string }

/** The backend's numeric connector id becomes the decimal string accepted by the host MCP manager. */
export function asMcpBackendExecPort(exec: ReturnType<typeof createDashboardSlateBackendMcpExec>): McpBackendExecPort {
  const withDecimalId = <T extends { serverId: number }>(args: T): Omit<T, "serverId"> & { serverId: string } => ({ ...args, serverId: String(args.serverId) })
  return {
    listTools: async identifiers => (await exec.listTools(identifiers)).map(entry => {
      const { status, ...rest } = entry
      return { ...rest, ...(typeof status === "string" ? { status } : {}) }
    }),
    checkAuthStatus: args => exec.checkAuthStatus(withDecimalId(args)),
    logoutAccount: args => exec.logoutAccount(args),
    renameAccount: args => exec.renameAccount(withDecimalId(args)),
    deleteAccount: args => exec.deleteAccount(withDecimalId(args)),
  }
}
