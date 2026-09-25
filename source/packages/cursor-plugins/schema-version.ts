/**
 * The schema a plugin's manifest declares, and whether this platform can read it.
 *
 * A manifest names the schema it was written against, and that name is both the identity of the format and where its
 * version can be read from — so a manifest from an older or newer format is recognized as such rather than being read
 * as if it were this one. A plugin and its MCP configuration that declare different versions of the schema disagree
 * about the format, which is worth saying out loud.
 */
export const SUPPORTED_SCHEMA_IDS = new Set(["https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json"]);
const VERSION_SEGMENT_PATTERN = /^v?(\d+\.\d+(?:\.\d+)?)$/;
export function readSchemaId(data: unknown): string | undefined { if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined; const schema = (data as Record<string, unknown>)["$schema"]; return typeof schema === "string" && schema.length > 0 ? schema : undefined; }
export function extractSchemaVersion(id: string): string | undefined { let segments: string[]; try { segments = new URL(id).pathname.split("/"); } catch { segments = id.split("/"); } for (const segment of segments) { const match = VERSION_SEGMENT_PATTERN.exec(segment); if (match?.[1] !== undefined) return match[1]; } return undefined; }
export function resolveSchemaVersion(id: string | undefined): { kind: "absent" } | { kind: "supported"; id: string; version: string } | { kind: "unsupported"; id: string } { if (id === undefined) return { kind: "absent" }; return SUPPORTED_SCHEMA_IDS.has(id) ? { kind: "supported", id, version: extractSchemaVersion(id) ?? id } : { kind: "unsupported", id }; }
export function schemaVersionsDisagree(pluginSchemaId: string | undefined, mcpSchemaId: string | undefined): boolean { if (pluginSchemaId === undefined || mcpSchemaId === undefined) return false; const plugin = extractSchemaVersion(pluginSchemaId), mcp = extractSchemaVersion(mcpSchemaId); return plugin !== undefined && mcp !== undefined && plugin !== mcp; }
