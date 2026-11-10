/**
 * The instruction that tells an agent how to authenticate an MCP server.
 *
 * Authentication is a step a user has to complete, so the wording carries the whole policy: do it
 * when a server asks for it or a call fails for authorization, do it once, inspect the server again
 * afterwards, and never run two authentications at the same time — a browser prompt that arrives
 * twice is indistinguishable from a phishing attempt.
 */

export const MCP_AUTH_INSTRUCTION =
  "Use `mcp_auth` only after a server requests sign-in or an MCP call reports an authorization failure. Authenticate one server at a time, check that server's state once the flow completes, and repeat the original call if the credentials resolved the problem. Skip authentication for servers that are merely present in the list; if the flow fails, stop instead of prompting again."
