/** Resolve a plugin's MCP files and manifest declarations into server configs with source ownership. */
import {
  PLUGIN_MCP_CONFIG_FILE_NAMES,
  type McpFileReader,
  type McpParserOptions,
  type ResolvedMcpConfig,
  type ResolveMcpOptions,
} from "./mcp-parser-contracts.ts";
import { parsePluginMcpDocument } from "./mcp-parser-document.ts";
import { findPluginManifest, readManifestServerSet, recordMcpServers, type McpServerSet } from "./mcp-parser-resolution.ts";
import type { McpServerConfig } from "./types.ts";

export { PLUGIN_MCP_CONFIG_FILE_NAMES };
export type { McpFileReader, McpParserOptions, ResolvedMcpConfig, ResolveMcpOptions };

export function resolvePluginMcpConfigPaths(pluginPath?: string): string[] {
  const root = pluginPath !== undefined && pluginPath.length > 0 ? pluginPath.replace(/\/+$/, "") : undefined;
  return PLUGIN_MCP_CONFIG_FILE_NAMES.map((name) => root === undefined ? name : `${root}/${name}`);
}

function collectResolvedConfig(servers: McpServerSet): ResolvedMcpConfig | null {
  if (servers.size === 0) return null;

  const mcpServers: Record<string, McpServerConfig> = {};
  const mcpServerSourcePaths: Record<string, string> = {};
  for (const [name, record] of servers) {
    mcpServers[name] = record.config;
    mcpServerSourcePaths[name] = record.sourcePath;
  }
  return { mcpServers, ...(Object.keys(mcpServerSourcePaths).length > 0 ? { mcpServerSourcePaths } : {}) };
}

export async function resolvePluginMcpConfigFromReader(
  readFileContent: McpFileReader,
  manifestMcpServers: unknown,
  manifestSourcePath: string | undefined,
  options: ResolveMcpOptions = {},
): Promise<ResolvedMcpConfig | null> {
  const toSourcePath = options.toSourcePath ?? ((path: string) => path);
  const installPath = options.installPathForExpansion ?? "";
  const resolved: McpServerSet = new Map();

  for (const fileName of options.fallbackFileNames ?? PLUGIN_MCP_CONFIG_FILE_NAMES) {
    const content = await readFileContent(fileName);
    if (content === null) continue;

    const config = parsePluginMcpDocument(content, installPath, options.parserOptions);
    if (config?.mcpServers !== undefined) recordMcpServers(resolved, config.mcpServers, toSourcePath(fileName), "first");
  }

  if (manifestMcpServers !== undefined) {
    const fromManifest = await readManifestServerSet(manifestMcpServers, readFileContent, {
      toSourcePath,
      manifestSourcePath,
      installPathForExpansion: installPath,
      parserOptions: options.parserOptions,
    });
    const precedence = options.manifestPrecedence ?? "override";
    for (const [name, record] of fromManifest) {
      if (precedence === "fill" && resolved.has(name)) continue;
      resolved.set(name, record);
    }
  }

  return collectResolvedConfig(resolved);
}

export async function resolvePluginMcpConfigWithManifestLookup(
  readFileContent: McpFileReader,
  options: ResolveMcpOptions = {},
): Promise<ResolvedMcpConfig | null> {
  const toSourcePath = options.toSourcePath ?? ((path: string) => path);
  const manifest = await findPluginManifest(readFileContent, toSourcePath);
  const parserOptions: McpParserOptions | undefined = manifest.schemaId === undefined
    ? options.parserOptions
    : { ...options.parserOptions, pluginSchemaId: manifest.schemaId };

  return resolvePluginMcpConfigFromReader(readFileContent, manifest.value, manifest.sourcePath, {
    ...options,
    parserOptions,
  });
}
