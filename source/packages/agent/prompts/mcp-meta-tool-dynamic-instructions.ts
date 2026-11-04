import type { McpMetaToolInstructionNames } from "./mcp-meta-tool-instruction-contracts.ts"
import { MCP_DESCRIPTION_SHORTENING_MARKER } from "./mcp-meta-tool-instruction-contracts.ts"

export function dynamicNamespaceInstructions(
  names: McpMetaToolInstructionNames,
  namespaceCatalog: string,
  resourceAccess: string,
): string {
  return `<dynamic_tools>
Dynamic namespaces expose tools on demand. Use \`${names.discoveryToolName}\` to inspect their schemas and \`${names.invocationToolName}\` to run a selected tool.

## Finding a tool

Choose a namespace lookup when you know where the capability lives, or use a pattern search when you do not. A namespace-wide lookup returns every tool and its complete schema; a one-tool lookup returns only the named tool with its complete schema. Pattern search and the full catalog shorten long descriptions with the marker "${MCP_DESCRIPTION_SHORTENING_MARKER}".

The discovery input accepts these forms:

1. \`{"namespace":"<id>"}\` for all tools in one namespace.
2. \`{"namespace":"<id>","toolName":"<name>"}\` for one named tool.
3. \`{"pattern":"<regex>"}\` across namespaces.
4. \`{"namespace":"<id>","pattern":"<regex>"}\` within one namespace.
5. No arguments for the full catalog.

Inspect the schema before each invocation. Keep the round-trip short: one discovery followed by one tool call is usually enough. If a request depends on a service represented by a namespace, inspect that namespace before answering.

${namespaceCatalog}

${resourceAccess}

If a namespace requires sign-in, use \`${names.invocationToolName}\` to call \`mcp_auth\`, then rediscover the namespace and retry when appropriate. Do not authenticate before a tool requires it.

If the current tools cannot complete the request, do the supported portion and say what remains. Do not use browser automation to replace an unavailable tool unless the user explicitly asks for browser use.
</dynamic_tools>`
}
