/** Encodes Slate's file-catalog view as the counterpart executor's MCP options message. */

import {
  McpDescriptor,
  McpFileSystemOptions,
  McpToolDescriptor,
} from "../proto/generated/agent/v1/mcp_pb.ts"
import type { McpFileSystemOptions as SlateMcpFileSystemOptions } from "../../../packages/local-exec/mcp-file-system-writer.ts"
import { normalizeToolAnnotations } from "../../../packages/local-exec/mcp-tool-annotations.ts"

function annotationsField(annotations: SlateMcpFileSystemOptions["mcpDescriptors"][number]["tools"][number]["annotations"]): { readonly annotationsJson?: string } {
  const normalized = normalizeToolAnnotations(annotations)
  return normalized === undefined ? {} : { annotationsJson: JSON.stringify(normalized) }
}

export function toInteropMcpFileSystemOptions(options: SlateMcpFileSystemOptions): McpFileSystemOptions {
  const mcpDescriptors = options.mcpDescriptors.map(descriptor => new McpDescriptor({
    serverIdentifier: descriptor.serverIdentifier,
    serverName: descriptor.serverName,
    folderPath: descriptor.folderPath,
    ...(descriptor.instructions === undefined ? {} : { serverUseInstructions: descriptor.instructions }),
    ...(descriptor.plugin === undefined ? {} : { plugin: descriptor.plugin }),
    ...(descriptor.marketplace === undefined ? {} : { marketplace: descriptor.marketplace }),
    ...(descriptor.pluginId === undefined ? {} : { pluginDbId: descriptor.pluginId }),
    ...(descriptor.marketplaceId === undefined ? {} : { marketplaceId: descriptor.marketplaceId }),
    tools: descriptor.tools.map(tool => new McpToolDescriptor({
      toolName: tool.toolName,
      definitionPath: tool.definitionPath,
      ...annotationsField(tool.annotations),
    })),
  }))
  return new McpFileSystemOptions({
    enabled: options.enabled,
    workspaceProjectDir: options.workspaceProjectDir,
    mcpDescriptors,
  })
}
