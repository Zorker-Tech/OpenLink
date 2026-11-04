import { SLATE_BUILTIN_MCP_SERVERS, availableBuiltinMcpServers, selectBoxComputerRuntime } from "./builtin-mcp.ts";
import type { SlateMcpServerConfig } from "./mcp-display-runtime.ts";
import { EMPTY_MCP_CONFIG, type McpRuntimeConfig } from "./mcp-definition-source-contracts.ts";

export function visibleServerNames(
  config: McpRuntimeConfig | null,
  transport: "url" | "command",
): string[] | undefined {
  if (config == null) return undefined;
  return Object.entries(config.mcpServers)
    .filter(([name, server]) => !SLATE_BUILTIN_MCP_SERVERS.has(name) && transport in server)
    .map(([name]) => name);
}

export async function accountServerConfigs(
  current: Promise<McpRuntimeConfig | null>,
): Promise<Record<string, SlateMcpServerConfig>> {
  const account = await current ?? EMPTY_MCP_CONFIG;
  const visible: Record<string, SlateMcpServerConfig> = {};
  for (const [name, config] of Object.entries(account.mcpServers)) {
    if (!SLATE_BUILTIN_MCP_SERVERS.has(name)) visible[name] = config;
  }
  return visible;
}

export async function stdioServerConfigs(
  current: Promise<McpRuntimeConfig | null>,
): Promise<Record<string, SlateMcpServerConfig & { command: string }>> {
  const result: Record<string, SlateMcpServerConfig & { command: string }> = {};
  for (const [name, config] of Object.entries(await accountServerConfigs(current))) {
    if ("command" in config) result[name] = config;
  }
  return result;
}

export async function serverUrlForIdentifier(
  current: Promise<McpRuntimeConfig | null>,
  lastKnown: McpRuntimeConfig | null,
  identifier: string,
): Promise<string | undefined> {
  const account = await current ?? lastKnown;
  const server = account?.mcpServers[identifier];
  return server != null && "url" in server ? server.url : undefined;
}

export async function serverDefinitions(
  current: Promise<McpRuntimeConfig | null>,
  includeBuiltins: boolean,
): Promise<Array<{ identifier: string; serverConfig: SlateMcpServerConfig; source: "builtin" | "account" }>> {
  const builtins = includeBuiltins ? availableBuiltinMcpServers(selectBoxComputerRuntime(false)) : {};
  const builtinRows = Object.entries(builtins).map(([identifier, serverConfig]) => ({ identifier, serverConfig, source: "builtin" as const }));
  const account = await accountServerConfigs(current);
  const accountRows = Object.entries(account)
    .filter(([identifier, config]) => !(identifier in builtins) && "url" in config)
    .map(([identifier, serverConfig]) => ({ identifier, serverConfig, source: "account" as const }));
  return [...builtinRows, ...accountRows];
}
