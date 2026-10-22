/**
 * The name an MCP server is registered under.
 *
 * A server's name comes from its configuration and may contain anything; the registry needs a name that is a single
 * token, so whitespace and unsupported characters are replaced, and a name that would be empty or a dot-path becomes
 * something usable instead.
 */

/** The characters a registry name may keep: letters, digits, underscore, dot and dash. */
const UNSUPPORTED_NAME_CHARACTERS = /[^a-zA-Z0-9_.-]/g;

/** Any whitespace in a name becomes an underscore. */
const WHITESPACE = /\s/g;

/** A run of dots becomes a single dot. */
const DOT_RUNS = /\.+/g;

/** The name a server falls back to when nothing usable is left. */
const FALLBACK_SERVER_NAME = "_";

/** A name with its whitespace underscored and everything the registry cannot hold taken out. */
function stripUnsupportedCharacters(name: string): string {
  return name.replace(WHITESPACE, "_").replace(UNSUPPORTED_NAME_CHARACTERS, "");
}

/** The name an MCP server is registered under: one token, and never empty or a dot-path. */
export function sanitizeServerName(name: string): string {
  const collapsed = stripUnsupportedCharacters(name).replace(DOT_RUNS, ".");
  if (collapsed === ".") return FALLBACK_SERVER_NAME;
  return collapsed.length === 0 ? FALLBACK_SERVER_NAME : collapsed;
}
