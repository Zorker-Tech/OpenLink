import { MCP_AUTH_INSTRUCTION } from "../utils/mcp-auth-instruction.ts"
import type { McpMetaToolInstructionNames } from "./mcp-meta-tool-instruction-contracts.ts"
import { MCP_DESCRIPTION_SHORTENING_MARKER } from "./mcp-meta-tool-instruction-contracts.ts"

export function serverInstructions(
  names: McpMetaToolInstructionNames,
  serverCatalog: string,
  resourceAccess: string,
): string {
  return `<mcp_meta_tools>
MCP servers are discovered with \`${names.discoveryToolName}\`; invoke the selected tool with \`${names.invocationToolName}\`. Inspect a service when the request relies on it instead of waiting for an explicit MCP instruction.

## Choosing a discovery query

The discovery tool accepts four forms:

1. A server id to retrieve its tools and complete schemas.
2. A server id plus a tool name to retrieve one complete schema.
3. A pattern across server and tool names. Patterns use RE2 and do not support backreferences, lookaround, or other backtracking-only syntax.
4. No arguments to list every server. Use this only when you do not know what to search for; prefer a server id or a pattern when possible.

Pattern and full-catalog results may shorten long descriptions with the marker "${MCP_DESCRIPTION_SHORTENING_MARKER}". Server-specific and one-tool lookup results contain the complete schema and description.

MANDATORY: discover and inspect a tool's schema before invoking it. When the server is known, query it directly rather than listing the entire catalog. Aim for one discovery call followed by one invocation.

${serverCatalog}

${resourceAccess}

${MCP_AUTH_INSTRUCTION}

If the available tools cover only part of the request, complete that part and state the missing capability. Use browser automation to fill a gap only when the user explicitly asks for browser use.
</mcp_meta_tools>`
}
