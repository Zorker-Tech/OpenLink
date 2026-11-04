/**
 * The browser tools among an MCP tool list.
 *
 * A browser server registers several tools, and the platform needs to know two things about them: which
 * of the available tools belong to a browser at all — a shell command that drives a browser is a
 * different risk from one that does not — and which server they came from, because the provider name is
 * part of the tool name and has to be recovered from it. Which servers count as browsers is decided
 * once, in the exec layer that also knows their identifiers.
 */

import { BROWSER_MCP_PROVIDER_IDS } from "../agent-exec/mcp-operations.ts"

export interface McpToolDescriptor {
  providerIdentifier: string
  name: string
}

export function getBrowserToolNames(mcpTools: readonly McpToolDescriptor[]): string[] {
  return mcpTools
    .filter(tool => BROWSER_MCP_PROVIDER_IDS.has(tool.providerIdentifier))
    .map(tool => tool.name)
}

/** The provider a browser tool came from: the prefix before the tool's own `-browser_` marker. */
export function getBrowserMcpProviderName(browserTools: readonly string[] | undefined): string | undefined {
  if (!browserTools?.length) return undefined
  for (const tool of browserTools) {
    const index = tool.indexOf("-browser_")
    if (index > 0) return tool.substring(0, index)
  }
  return undefined
}
