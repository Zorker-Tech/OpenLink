import { isPathSafe, parsePluginManifest, PLUGIN_MANIFEST_PATHS } from "./manifest-parser.ts";
import { readSchemaId } from "./schema-version.ts";
import { parsePluginMcpDocument } from "./mcp-parser-document.ts";
import type { McpFileReader, McpParserOptions, ResolveMcpOptions } from "./mcp-parser-contracts.ts";
import type { McpServerConfig } from "./types.ts";

export interface ResolvedMcpServer {
  readonly config: McpServerConfig;
  readonly sourcePath: string;
}

export type McpServerSet = Map<string, ResolvedMcpServer>;

export function recordMcpServers(
  target: McpServerSet,
  servers: Readonly<Record<string, McpServerConfig>>,
  sourcePath: string,
  mode: "first" | "last" = "last",
): void {
  for (const [name, config] of Object.entries(servers)) {
    if (mode === "first" && target.has(name)) continue;
    target.set(name, { config, sourcePath });
  }
}

function mcpServersOf(content: string, installPath: string, options?: McpParserOptions): Record<string, McpServerConfig> | undefined {
  const config = parsePluginMcpDocument(content, installPath, options);
  return config?.mcpServers;
}

export async function readManifestServerSet(
  manifestValue: unknown,
  readFileContent: McpFileReader,
  options: ResolveMcpOptions & { manifestSourcePath?: string | undefined } = {},
): Promise<McpServerSet> {
  const sourceFor = options.toSourcePath ?? ((path: string) => path);
  const installPath = options.installPathForExpansion ?? "";
  const manifestServers: McpServerSet = new Map();

  const readReferencedFile = async (rawPath: string): Promise<void> => {
    const relativePath = rawPath.replace(/^\.\//, "");
    if (!isPathSafe(relativePath)) return;

    const content = await readFileContent(relativePath);
    if (content === null) return;
    const servers = mcpServersOf(content, installPath, options.parserOptions);
    if (servers !== undefined && Object.keys(servers).length > 0) {
      recordMcpServers(manifestServers, servers, sourceFor(relativePath));
    }
  };

  const readInlineValue = (value: object): void => {
    const servers = mcpServersOf(JSON.stringify(value), installPath, options.parserOptions);
    if (servers !== undefined && Object.keys(servers).length > 0) {
      recordMcpServers(manifestServers, servers, options.manifestSourcePath ?? "manifest");
    }
  };

  if (typeof manifestValue === "string") {
    await readReferencedFile(manifestValue);
  } else if (Array.isArray(manifestValue)) {
    for (const entry of manifestValue) {
      if (typeof entry === "string") await readReferencedFile(entry);
      else if (typeof entry === "object" && entry !== null) readInlineValue(entry);
    }
  } else if (typeof manifestValue === "object" && manifestValue !== null) {
    readInlineValue(manifestValue);
  }

  return manifestServers;
}

export async function findPluginManifest(
  readFileContent: McpFileReader,
  toSourcePath: (path: string) => string,
): Promise<{ readonly value: unknown; readonly sourcePath?: string | undefined; readonly schemaId?: string | undefined }> {
  let lastReadableSchemaId: string | undefined;
  for (const relativePath of PLUGIN_MANIFEST_PATHS) {
    const content = await readFileContent(relativePath);
    if (content === null) continue;

    let rawValue: unknown;
    try {
      rawValue = JSON.parse(content);
    } catch {
      continue;
    }

    lastReadableSchemaId = readSchemaId(rawValue);
    const parsed = parsePluginManifest(content);
    if (!parsed.success) continue;
    return {
      value: parsed.data.mcpServers,
      ...(parsed.data.mcpServers === undefined ? {} : { sourcePath: toSourcePath(relativePath) }),
      schemaId: lastReadableSchemaId,
    };
  }
  return { value: undefined, schemaId: lastReadableSchemaId };
}
