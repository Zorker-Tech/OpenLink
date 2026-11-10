import { parse } from "jsonc-parser";
import { parseExternalPluginMcpConfig } from "../../adapters/interop/plugin-marketplace/plugin-mcp-config-adapter.ts";
import { readSchemaId, resolveSchemaVersion, schemaVersionsDisagree } from "./schema-version.ts";
import { expandPluginMcpConfig } from "./mcp-parser-expansion.ts";
import type { McpParserOptions } from "./mcp-parser-contracts.ts";
import { noopPluginMetricsLogger } from "./types.ts";
import type { McpConfig, McpServerConfig } from "./types.ts";

const METADATA_SHAPE_CHECKS: Readonly<Record<string, (metadata: Record<string, unknown>) => boolean>> = {
  author: (metadata) => typeof metadata.name === "string",
  owner: (metadata) => typeof metadata.name === "string",
  source: (metadata) => ["source", "repo", "path", "ref", "sha"].some((field) => typeof metadata[field] === "string"),
  metadata: (metadata) => ["description", "version", "pluginRoot"].some((field) => typeof metadata[field] === "string"),
};

function isMetadataEntry(key: string, value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  return METADATA_SHAPE_CHECKS[key.toLowerCase()]?.(value as Record<string, unknown>) ?? false;
}

function isServerEntry(value: unknown): boolean {
  return typeof value === "object" && value !== null && ("command" in value || "url" in value);
}

function warnAboutSchema(data: unknown, options?: McpParserOptions): void {
  const schemaId = readSchemaId(data);
  if (schemaId === undefined) return;

  const logger = options?.log ?? noopPluginMetricsLogger;
  if (resolveSchemaVersion(schemaId).kind === "unsupported") {
    logger.log("warn", `mcp.json declares an unrecognized $schema, loading anyway: ${schemaId}`);
    return;
  }
  if (schemaVersionsDisagree(options?.pluginSchemaId, schemaId)) {
    logger.log("warn", `mcp.json $schema ${schemaId} disagrees with plugin.json $schema ${options?.pluginSchemaId}, loading anyway`);
  }
}

function parseWrappedServers(data: unknown): McpConfig | null {
  const parsed = parseExternalPluginMcpConfig(data);
  return parsed.success && parsed.data.mcpServers !== undefined && Object.keys(parsed.data.mcpServers).length > 0
    ? parsed.data
    : null;
}

function parseRootServerMap(data: unknown): McpConfig | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;

  const candidates = Object.fromEntries(Object.entries(data).filter(([key, value]) =>
    key !== "mcpServers" && !isMetadataEntry(key, value) && isServerEntry(value),
  ));
  if (Object.keys(candidates).length === 0) return null;

  const parsed = parseExternalPluginMcpConfig({ mcpServers: candidates });
  return parsed.success ? parsed.data : null;
}

/** Read the wrapped and legacy root forms without allowing an invalid server to yield a partial config. */
export function parsePluginMcpDocument(content: string, installPath: string, options?: McpParserOptions): McpConfig | null {
  try {
    const data: unknown = parse(content);
    warnAboutSchema(data, options);

    const parsed = parseWrappedServers(data) ?? parseRootServerMap(data);
    if (parsed === null) return null;
    return options?.skipExpansion === true ? parsed : expandPluginMcpConfig(parsed, installPath, options);
  } catch {
    return null;
  }
}

export type { McpServerConfig };
