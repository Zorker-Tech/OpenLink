/** Binds the external dashboard service behind the account-MCP and backend-MCP host ports. */

import { DashboardService } from "../proto/generated/aiserver/v1/dashboard_connect.ts"
import type { AccountMcpClient } from "./account-mcp.ts"
import type { DashboardMcpExecClient } from "./backend-mcp-exec.ts"
import { createSlateBackendClient } from "./slate-backend-client.ts"

export interface McpDashboardCredentials {
  getAccessToken(options?: { backendUrl?: string }): Promise<string>
  getMachineId(): Promise<string>
}

export function createMcpDashboardClient(credentials: McpDashboardCredentials): AccountMcpClient & DashboardMcpExecClient {
  return createSlateBackendClient(DashboardService, {
    getAccessToken: options => credentials.getAccessToken({ backendUrl: options.backendUrl }),
    getMachineId: credentials.getMachineId,
  }) as unknown as AccountMcpClient & DashboardMcpExecClient
}
