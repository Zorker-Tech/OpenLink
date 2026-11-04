/** The desktop client that completes a sign-in for a connector. */
export const MCP_OAUTH_EXTENSION_ID = "slate.mcp"
export const MCP_OAUTH_RETURN_PATH = "/oauth/return"
export const MCP_OAUTH_DESKTOP_RETURN_URL = `slate://${MCP_OAUTH_EXTENSION_ID}${MCP_OAUTH_RETURN_PATH}`
export const MCP_OAUTH_LOOPBACK_CALLBACK_URL = "http://localhost:8787/callback"
