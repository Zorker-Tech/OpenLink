/** Names and statuses emitted by the remote MCP provider, kept at the boundary where they are interpreted. */
export const APP_CONTROL_MCP_SERVER_ID = "cursor-app-control"
export const BROWSER_EXTENSION_MCP_PROVIDER_ID = "cursor-browser-extension"
export const IDE_BROWSER_MCP_PROVIDER_ID = "cursor-ide-browser"
export const ENVIRONMENT_CONTROL_MCP_PROVIDER_ID = "cursor-dev-control"
export const CUSTOM_USER_TOOLS_PROVIDER_ID = "custom-user-tools"

export const NON_AUTHENTICATABLE_MCP_PROVIDER_IDS = new Set([
  "cursor-app-control",
  "slate-backend-control",
  BROWSER_EXTENSION_MCP_PROVIDER_ID,
  IDE_BROWSER_MCP_PROVIDER_ID,
  ENVIRONMENT_CONTROL_MCP_PROVIDER_ID,
  CUSTOM_USER_TOOLS_PROVIDER_ID,
  "fsd",
])

export const BROWSER_MCP_PROVIDER_IDS = new Set([
  ENVIRONMENT_CONTROL_MCP_PROVIDER_ID,
  IDE_BROWSER_MCP_PROVIDER_ID,
])

export const McpLeaseChangeReason = {
  Snapshots: "cursor_mcp_lease_snapshot_store",
  Status: "cursor_mcp_lease_server_status",
  Settings: "cursor_mcp_lease_settings",
  Providers: "cursor_mcp_lease_providers",
  Unknown: "cursor_mcp_lease_unknown",
} as const

export type McpLeaseChangeReason = (typeof McpLeaseChangeReason)[keyof typeof McpLeaseChangeReason]

export function supportsInteractiveMcpAuth(serverIdentifier: string): boolean {
  return !NON_AUTHENTICATABLE_MCP_PROVIDER_IDS.has(serverIdentifier)
}

export type SlateMcpServerAvailability = "authentication-required" | "discovery-failed" | "loading" | "available"

export function projectMcpServerAvailability(status: string): SlateMcpServerAvailability {
  switch (status) {
    case "needsAuth": return "authentication-required"
    case "error": return "discovery-failed"
    case "loading": return "loading"
    default: return "available"
  }
}
