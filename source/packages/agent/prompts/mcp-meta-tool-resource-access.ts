import type { McpMetaToolInstructionNames } from "./mcp-meta-tool-instruction-contracts.ts"

export function mcpResourceAccessSection(names: McpMetaToolInstructionNames): string {
  const fetchName = names.fetchMcpResourceToolName
  if (!fetchName) return ""

  const resourceTools = names.listMcpResourcesToolName
    ? `\`${names.listMcpResourcesToolName}\` and \`${fetchName}\``
    : `\`${fetchName}\``
  return `## MCP Resource Access\n\nResources are available through ${resourceTools}.`
}
