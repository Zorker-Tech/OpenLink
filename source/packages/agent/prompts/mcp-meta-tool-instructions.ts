import { McpMetaToolServerList } from "./mcp-catalog.ts"
import type { UserInfoMcpDescriptor } from "./user-info-data-contracts.ts"
import type { McpMetaToolInstructionNames } from "./mcp-meta-tool-instruction-contracts.ts"
import { dynamicNamespaceInstructions } from "./mcp-meta-tool-dynamic-instructions.ts"
import { mcpResourceAccessSection } from "./mcp-meta-tool-resource-access.ts"
import { serverInstructions } from "./mcp-meta-tool-server-instructions.ts"

export function McpMetaToolInstructions(
  mcpDescriptors: readonly UserInfoMcpDescriptor[],
  toolNames: McpMetaToolInstructionNames,
): string {
  if (mcpDescriptors.length === 0) return ""

  const namespaceRoute = toolNames.useDynamicToolNamespaces
  const catalog = McpMetaToolServerList(mcpDescriptors, namespaceRoute)
  const resourceAccess = mcpResourceAccessSection(toolNames)
  return namespaceRoute
    ? dynamicNamespaceInstructions(toolNames, catalog, resourceAccess)
    : serverInstructions(toolNames, catalog, resourceAccess)
}
