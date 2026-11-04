import type { EnvLookup } from "./env-expansion.ts";
import type { McpConfig, McpServerConfig, PluginMetricsLogger } from "./types.ts";

/** The source files a plugin may use for its MCP server declarations, in preference order. */
export const PLUGIN_MCP_CONFIG_FILE_NAMES = [".mcp.json", "mcp.json"] as const;

export interface McpParserOptions {
  cloudAgentEnvLookup?: EnvLookup | undefined;
  configuredVariables?: Readonly<Record<string, unknown>> | undefined;
  log?: PluginMetricsLogger | undefined;
  pluginSchemaId?: string | undefined;
  skipExpansion?: boolean | undefined;
}

export type McpFileReader = (path: string) => Promise<string | null>;

export interface ResolvedMcpConfig extends McpConfig {
  mcpServers: Record<string, McpServerConfig>;
  mcpServerSourcePaths?: Record<string, string> | undefined;
}

export interface ResolveMcpOptions {
  toSourcePath?: ((path: string) => string) | undefined;
  installPathForExpansion?: string | undefined;
  fallbackFileNames?: readonly string[] | undefined;
  manifestPrecedence?: "override" | "fill" | undefined;
  parserOptions?: McpParserOptions | undefined;
}
