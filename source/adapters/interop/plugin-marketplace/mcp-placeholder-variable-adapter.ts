/**
 * The variables a plugin's MCP configuration expects someone to fill in.
 *
 * A plugin's configuration refers to values only the person installing it knows — a host, a token — and those are
 * spelled as placeholders. They are collected from the configuration itself, so the form a user is shown is exactly the
 * values the plugin asks for: each one named, described by what it is used for, given its default when it has one, and
 * marked write-only when its name says it holds a secret. The two variables the loader fills in itself are not the
 * user's to provide and are left out.
 */
import { isSecretPluginVariableName } from "../../../packages/plugin-install/secret-variable-names.ts";
const PLACEHOLDER = /\$\{([A-Z][A-Z0-9_]*)(?::-([^}]*))?\}/g;
const LOADER_PROVIDED = new Set(["CURSOR_PLUGIN_ROOT", "CLAUDE_PLUGIN_ROOT"]);
const ACRONYMS = new Set(["api", "aws", "db", "dd", "gcp", "http", "https", "id", "mcp", "ssl", "tls", "uri", "url"]);
const humanize = (name: string): string => name.split("_").filter(Boolean).map((word) => ACRONYMS.has(word.toLowerCase()) ? word.toUpperCase() : word.charAt(0).toUpperCase() + word.toLowerCase().slice(1)).join(" ");
function collectFromStrings(value: unknown, into: Map<string, string | undefined>): void {
  if (typeof value === "string") { for (const match of value.matchAll(PLACEHOLDER)) { const name = match[1]; if (name !== undefined && !LOADER_PROVIDED.has(name) && !into.has(name)) into.set(name, match[2]); } return; }
  if (Array.isArray(value)) { for (const item of value) collectFromStrings(item, into); return; }
  if (value !== null && typeof value === "object") for (const nested of Object.values(value)) collectFromStrings(nested, into);
}
export interface PlaceholderProperty { type: "string"; title: string; description: string; writeOnly?: true }
export function inferMcpPlaceholderVariables(config: { mcpServers?: unknown } | null | undefined): { type: "object"; properties: Record<string, PlaceholderProperty> } | undefined {
  if (config?.mcpServers === undefined) return undefined; const placeholders = new Map<string, string | undefined>(); collectFromStrings(config.mcpServers, placeholders); if (placeholders.size === 0) return undefined;
  const properties: Record<string, PlaceholderProperty> = {};
  for (const name of [...placeholders.keys()].sort()) { const fallback = placeholders.get(name); properties[name] = { type: "string", title: humanize(name), description: fallback === undefined || fallback.length === 0 ? `Referenced as \`\${${name}}\` in this plugin's MCP configuration.` : `Referenced as \`\${${name}}\` in this plugin's MCP configuration. Defaults to \`${fallback}\` when left blank.`, ...(isSecretPluginVariableName(name) ? { writeOnly: true } : {}) }; }
  return { type: "object", properties };
}
