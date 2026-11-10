/**
 * How long a tool call to an MCP server may take in total.
 *
 * The two names are the same limit: the second is the one earlier callers were written against, and it is kept so a
 * caller that still uses it is not silently given a different timeout.
 */
export const DEFAULT_MCP_TOOL_CALL_MAX_TOTAL_TIMEOUT_MS = 60 * 60_000;
export const LEGACY_MCP_TOOL_CALL_TIMEOUT_MS = 60 * 60_000;
