/**
 * The instruction that tells an agent how to authenticate an MCP server.
 *
 * Authentication is a step a user has to complete, so the wording carries the whole policy: do it
 * when a server asks for it or a call fails for authorization, do it once, inspect the server again
 * afterwards, and never run two authentications at the same time — a browser prompt that arrives
 * twice is indistinguishable from a phishing attempt.
 */

export const MCP_AUTH_INSTRUCTION =
  "If a relevant server is marked as needing authentication, or if an MCP tool call fails with an authentication/authorization error, call `mcp_auth` for that server, then inspect that server again and retry the original request if appropriate. Do not call `mcp_auth` just because it is listed, and do not repeatedly call it if authentication did not fix the failure. Do not call `mcp_auth` in parallel; authenticate only one server at a time."
