export interface McpMetaToolInstructionNames {
  readonly discoveryToolName: string
  readonly invocationToolName: string
  readonly useDynamicToolNamespaces: boolean
  readonly fetchMcpResourceToolName?: string | undefined
  readonly listMcpResourcesToolName?: string | undefined
}

export const MCP_DESCRIPTION_SHORTENING_MARKER = "... [truncated]"
