/** Projects external MCP descriptor messages into Slate's call-index contract. */
import type { McpFileSystemOptions, McpMetaToolOptions } from "../proto/generated/agent/v1/mcp_pb.ts"
import {
  indexMcpDescriptors,
  type McpDescriptorIndex,
  type McpServerDescriptor,
} from "../../../packages/agent/tools/mcp/mcp-call-options.ts"

export function indexInteropMcpDescriptors(input: {
  readonly mcpMetaToolEnabled: boolean
  readonly mcpMetaToolOptions?: unknown
  readonly mcpFileSystemOptions?: unknown
  readonly allowInteractiveMcpAuth?: boolean | undefined
}): McpDescriptorIndex {
  const mcpMetaToolOptions = input.mcpMetaToolOptions as McpMetaToolOptions | undefined
  const mcpFileSystemOptions = input.mcpFileSystemOptions as McpFileSystemOptions | undefined
  const externalDescriptors = input.mcpMetaToolEnabled
    ? mcpMetaToolOptions?.mcpDescriptors ?? []
    : mcpFileSystemOptions?.mcpDescriptors ?? []
  const descriptors: McpServerDescriptor[] = externalDescriptors.map(descriptor => ({
    serverIdentifier: descriptor.serverIdentifier,
    ...(descriptor.serverName === undefined ? {} : { serverName: descriptor.serverName }),
    ...(descriptor.folderPath === undefined ? {} : { folderPath: descriptor.folderPath }),
    tools: descriptor.tools.map(tool => ({
      toolName: tool.toolName,
      ...(tool.definitionPath === undefined ? {} : { definitionPath: tool.definitionPath }),
    })),
  }))
  return indexMcpDescriptors({ descriptors, allowInteractiveMcpAuth: input.allowInteractiveMcpAuth })
}

export function mcpMetaToolEnabledInterop(value: unknown): boolean {
  return (value as McpMetaToolOptions | undefined)?.enabled === true
}

export function mcpWorkspaceProjectDirInterop(value: unknown): string | undefined {
  const directory = (value as McpFileSystemOptions | undefined)?.workspaceProjectDir
  return typeof directory === "string" ? directory : undefined
}

export function projectMcpFileSystemSettingsInterop(value: unknown): { readonly enabled: boolean; readonly workspaceProjectDir: string } | undefined {
  if (value === undefined || value === null || typeof value !== "object") return undefined
  const options = value as McpFileSystemOptions
  if (typeof options.workspaceProjectDir !== "string") return undefined
  return { enabled: options.enabled === true, workspaceProjectDir: options.workspaceProjectDir }
}
