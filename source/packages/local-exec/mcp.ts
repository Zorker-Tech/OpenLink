/**
 * The name an MCP server is registered under.
 *
 * A server's name comes from its configuration and may contain anything; the registry needs a name that is a single
 * token, so whitespace and unsupported characters are replaced, and a name that would be empty or a dot-path becomes
 * something usable instead.
 */
const logger = { name: "local-exec:mcp" };

export function sanitizeServerName(name: string): string {
  const sanitized = name.replace(/\s/g, "_").replace(/[^a-zA-Z0-9_.-]/g, "");
  const normalizedDots = sanitized.replace(/\.+/g, ".");
  if (normalizedDots === "." || normalizedDots === "..") return normalizedDots.replace(/\./g, "_");
  return normalizedDots.length === 0 ? "_" : normalizedDots;
}
