/**
 * The schema a plugin's manifest declares, and whether this platform can read it.
 *
 * A manifest names the schema it was written against, and that name is both the identity of the format and where its
 * version can be read from — so a manifest from an older or newer format is recognized as such rather than being read
 * as if it were this one. A plugin and its MCP configuration that declare different versions of the schema disagree
 * about the format, which is worth saying out loud.
 */
export const SUPPORTED_SCHEMA_IDS = new Set(["https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json"]);

/** A path segment that is a version: an optional v, then a dotted number of two or three parts. */
const VERSION_SEGMENT_PATTERN = /^v?(\d+\.\d+(?:\.\d+)?)$/;

/** The value a manifest's schema field carries, or nothing when the field is absent or not a non-empty text. */
function schemaFieldOf(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const schema = (value as Record<string, unknown>)["$schema"];
  return typeof schema === "string" && schema.length > 0 ? schema : undefined;
}

export function readSchemaId(manifest: unknown): string | undefined {
  return schemaFieldOf(manifest);
}

/** The path segments a schema id names: its URL path when it parses as one, and its slash-split otherwise. */
function schemaPathSegments(rawId: string): string[] {
  try {
    return new URL(rawId).pathname.split("/");
  } catch {
    return rawId.split("/");
  }
}

/** The first segment of a schema id's path that is a version, or nothing when none is. */
function versionInSegments(parts: readonly string[]): string | undefined {
  for (const part of parts) {
    const found = VERSION_SEGMENT_PATTERN.exec(part);
    if (found?.[1] !== undefined) return found[1];
  }
  return undefined;
}

export function extractSchemaVersion(schemaId: string): string | undefined {
  return versionInSegments(schemaPathSegments(schemaId));
}

/** What this platform makes of a schema id it can see: the format it declares, or that it is not ours. */
function resolvedSchemaOf(schemaId: string): { kind: "supported"; id: string; version: string } | { kind: "unsupported"; id: string } {
  return SUPPORTED_SCHEMA_IDS.has(schemaId)
    ? { kind: "supported", id: schemaId, version: extractSchemaVersion(schemaId) ?? schemaId }
    : { kind: "unsupported", id: schemaId };
}

export function resolveSchemaVersion(schemaId: string | undefined): { kind: "absent" } | { kind: "supported"; id: string; version: string } | { kind: "unsupported"; id: string } {
  return schemaId === undefined ? { kind: "absent" } : resolvedSchemaOf(schemaId);
}

export function schemaVersionsDisagree(declaredPluginSchema: string | undefined, declaredMcpSchema: string | undefined): boolean {
  if (declaredPluginSchema === undefined || declaredMcpSchema === undefined) return false;
  const pluginVersion = extractSchemaVersion(declaredPluginSchema);
  const mcpVersion = extractSchemaVersion(declaredMcpSchema);
  return pluginVersion !== undefined && mcpVersion !== undefined && pluginVersion !== mcpVersion;
}
