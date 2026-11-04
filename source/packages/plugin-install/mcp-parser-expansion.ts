import { expandEnvVarsWithLookup, type EnvLookup } from "./env-expansion.ts";
import { expandPluginVariables } from "./plugin-variables.ts";
import type { McpParserOptions } from "./mcp-parser-contracts.ts";
import type { McpConfig, McpServerConfig } from "./types.ts";

function configuredEnvironmentLookup(options?: McpParserOptions): EnvLookup {
  if (options?.cloudAgentEnvLookup !== undefined) return options.cloudAgentEnvLookup;

  return (key) => {
    const fromProcess = process.env[key];
    if (fromProcess !== undefined) return fromProcess;

    const configured = options?.configuredVariables?.[key];
    if (configured === undefined || configured === null) return undefined;
    return typeof configured === "string" ? configured : String(configured);
  };
}

function expandPluginPathFields(server: McpServerConfig, pluginPath: string): McpServerConfig {
  const result: McpServerConfig = { ...server };
  if (typeof server.command === "string") result.command = expandPluginVariables(server.command, pluginPath);
  if (typeof server.args !== "undefined") {
    result.args = server.args.map((argument) => expandPluginVariables(argument, pluginPath));
  }
  if (server.env !== undefined) {
    result.env = Object.fromEntries(Object.entries(server.env).map(([name, value]) => [name, expandPluginVariables(value, pluginPath)]));
  }
  if (typeof server.cwd === "string") result.cwd = expandPluginVariables(server.cwd, pluginPath);
  return result;
}

/** Resolve the install-root spelling first, then expand environment placeholders across the complete config. */
export function expandPluginMcpConfig(config: McpConfig, pluginPath: string, options?: McpParserOptions): McpConfig {
  if (config.mcpServers === undefined) return config;

  const servers = Object.fromEntries(Object.entries(config.mcpServers).map(([name, server]) => [
    name,
    expandPluginPathFields(server, pluginPath),
  ]));
  const withPluginPaths = { ...config, mcpServers: servers };
  return expandEnvVarsWithLookup(withPluginPaths, configuredEnvironmentLookup(options));
}
