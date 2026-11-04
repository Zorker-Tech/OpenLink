/**
 * The single path token Slate uses for an MCP server.
 *
 * Server identifiers come from external configuration and may contain path separators, whitespace or
 * arbitrary Unicode. Descriptor writing and prompt rendering must agree on the same safe token.
 */

const UNSUPPORTED_SERVER_NAME_CHARACTERS = /[^a-zA-Z0-9_.-]/g
const SERVER_NAME_WHITESPACE = /\s/g
const SERVER_NAME_DOT_RUNS = /\.+/g
const FALLBACK_SERVER_FOLDER = "_"

export function sanitizeMcpServerFolder(serverIdentifier: string): string {
  const withoutUnsupported =
    serverIdentifier.replace(SERVER_NAME_WHITESPACE, "_").replace(UNSUPPORTED_SERVER_NAME_CHARACTERS, "")
  const collapsedDots = withoutUnsupported.replace(SERVER_NAME_DOT_RUNS, ".")
  return collapsedDots.length === 0 || collapsedDots === "."
    ? FALLBACK_SERVER_FOLDER
    : collapsedDots
}
