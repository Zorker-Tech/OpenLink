import type { SlateMcpServerConfig } from "./mcp-display-runtime.ts";

export interface McpRuntimeConfig {
  mcpServers: Record<string, SlateMcpServerConfig>;
}

export type McpAccountConfigProvider = () => Promise<McpRuntimeConfig | null>;

export const EMPTY_MCP_CONFIG: McpRuntimeConfig = { mcpServers: {} };
