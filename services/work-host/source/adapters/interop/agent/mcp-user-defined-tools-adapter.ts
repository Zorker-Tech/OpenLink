/** Build the Agent MCP descriptor that represents the session's user-defined tools. */

import { Value } from "@bufbuild/protobuf"
import {
  McpDescriptor,
  McpMetaToolOptions,
  McpToolDescriptor,
  type McpDescriptor as InteropMcpDescriptor,
} from "../proto/generated/agent/v1/mcp_pb.ts"
import { CUSTOM_USER_TOOLS_PROVIDER_ID } from "../../../packages/agent-exec/mcp-operations.ts"
import {
  buildUserDefinedToolsInstructions,
  type MetaToolInstructionNames,
  type UserDefinedMcpTool,
} from "../../../packages/agent/utils/mcp-user-defined-tools.ts"

function isUserDefinedTool(tool: UserDefinedMcpTool): boolean {
  return tool.providerIdentifier === CUSTOM_USER_TOOLS_PROVIDER_ID
}

function userToolDescriptor(
  tools: readonly UserDefinedMcpTool[],
  names?: MetaToolInstructionNames,
): InteropMcpDescriptor {
  const descriptors = tools.map(tool => new McpToolDescriptor({
    toolName: tool.toolName,
    ...(tool.description === undefined ? {} : { description: tool.description }),
    ...(tool.inputSchema === undefined ? {} : { inputSchema: Value.fromJson(tool.inputSchema as never) }),
  }))
  return new McpDescriptor({
    serverIdentifier: CUSTOM_USER_TOOLS_PROVIDER_ID,
    serverName: CUSTOM_USER_TOOLS_PROVIDER_ID,
    serverUseInstructions: buildUserDefinedToolsInstructions(tools, names),
    tools: descriptors,
  })
}

/** Replace a stale descriptor for these tools while preserving every other server. */
export function mergeUserDefinedToolsIntoMetaToolOptions(
  options: McpMetaToolOptions | undefined,
  tools: readonly UserDefinedMcpTool[],
  names?: MetaToolInstructionNames,
): McpMetaToolOptions | undefined {
  const selected = tools.filter(isUserDefinedTool)
  if (selected.length === 0 || options?.enabled !== true) return options

  const existing = options.mcpDescriptors ?? []
  const otherServers = existing.filter(server => server.serverIdentifier !== CUSTOM_USER_TOOLS_PROVIDER_ID)
  const current = userToolDescriptor(selected, names)
  return new McpMetaToolOptions({ enabled: true, mcpDescriptors: [...otherServers, current] })
}

/** Ensure the meta tool is enabled whenever the model needs the session's user-defined tools. */
export function getMcpMetaToolOptionsWithUserDefinedTools(
  options: McpMetaToolOptions | undefined,
  tools: readonly UserDefinedMcpTool[],
  names?: MetaToolInstructionNames,
): McpMetaToolOptions | undefined {
  if (!tools.some(isUserDefinedTool)) return options
  const enabled = options?.enabled === true
    ? options
    : new McpMetaToolOptions({ enabled: true, mcpDescriptors: options?.mcpDescriptors ?? [] })
  return mergeUserDefinedToolsIntoMetaToolOptions(enabled, tools, names)
}
