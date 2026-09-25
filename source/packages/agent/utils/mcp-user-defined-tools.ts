/**
 * The tools a user brought with them, presented as a server of their own.
 *
 * A user-defined tool is not compiled into the platform and does not come from an MCP server: it is
 * defined per session, and the model has to be told about it like any other tool. So it is presented
 * as a server — one descriptor, one entry per tool, and instructions that say how to reach it — which
 * means everything downstream (discovery, invocation, approval, rendering) treats it like the rest
 * without a second code path.
 *
 * The instructions differ depending on how the platform exposes tools in this session: with a dynamic
 * tool registry the tools are reached by namespace, and without one by server. The caller passes the
 * names it actually has, and this writes the sentence that matches them.
 */

import { Value } from "@bufbuild/protobuf"

import { McpDescriptor, McpMetaToolOptions, McpToolDescriptor, type McpDescriptor as McpDescriptorValue } from "../../proto/generated/agent/v1/mcp_pb.ts"
import { CUSTOM_USER_TOOLS_PROVIDER_ID } from "../../agent-exec/mcp-operations.ts"

export interface DescribedTool {
  readonly toolName: string
  readonly description?: string | undefined
}

export interface UserDefinedMcpTool extends DescribedTool {
  readonly providerIdentifier: string
  readonly inputSchema?: unknown
}

/** The meta tool names a session exposes, and whether its tools are reached by namespace. */
export interface MetaToolInstructionNames {
  readonly discoveryToolName: string
  readonly invocationToolName: string
  readonly useDynamicToolNamespaces: boolean
}

function isUserDefinedMcpTool(tool: UserDefinedMcpTool): boolean {
  return tool.providerIdentifier === CUSTOM_USER_TOOLS_PROVIDER_ID
}

/** How the model is told to reach a user-defined tool, and what is available. */
export function buildUserDefinedToolsInstructions(
  userTools: readonly DescribedTool[],
  toolNames?: MetaToolInstructionNames,
): string {
  const toolLines = userTools.map(tool => {
    const description = typeof tool.description === "string" && tool.description.length > 0
      ? tool.description
      : "(no description provided)"
    return `- ${tool.toolName}: ${description}`
  }).join("\n")
  const discoveryInvocationLine = toolNames
    ? `Discover tool schemas with \`${toolNames.discoveryToolName}\`, then invoke via \`${toolNames.invocationToolName}\` with ${toolNames.useDynamicToolNamespaces ? "namespace" : "server"} "${CUSTOM_USER_TOOLS_PROVIDER_ID}".`
    : `Discover tool schemas via MCP meta-tool discovery for server "${CUSTOM_USER_TOOLS_PROVIDER_ID}", then invoke via the MCP invocation meta-tool with that server.`
  return `User-defined tools for this session. ${discoveryInvocationLine}

Available tools:
${toolLines}`
}

function buildUserDefinedToolsDescriptor(
  userTools: readonly UserDefinedMcpTool[],
  toolNames?: MetaToolInstructionNames,
): McpDescriptorValue {
  const toolDescriptors = userTools.map(tool => new McpToolDescriptor({
    toolName: tool.toolName,
    ...(tool.description !== undefined ? { description: tool.description } : {}),
    ...(tool.inputSchema !== undefined ? { inputSchema: Value.fromJson(tool.inputSchema as never) } : {}),
  }))
  return new McpDescriptor({
    serverIdentifier: CUSTOM_USER_TOOLS_PROVIDER_ID,
    serverName: CUSTOM_USER_TOOLS_PROVIDER_ID,
    serverUseInstructions: buildUserDefinedToolsInstructions(userTools, toolNames),
    tools: toolDescriptors,
  })
}

/**
 * Adding the user-defined tools to the meta tool's options, replacing whatever descriptor was there
 * for them: the session's definitions are the current ones, and a stale descriptor would describe
 * tools that no longer exist.
 */
export function mergeUserDefinedToolsIntoMetaToolOptions(
  metaToolOptions: McpMetaToolOptions | undefined,
  mcpTools: readonly UserDefinedMcpTool[],
  instructionToolNames?: MetaToolInstructionNames,
): McpMetaToolOptions | undefined {
  const userTools = mcpTools.filter(isUserDefinedMcpTool)
  if (userTools.length === 0 || metaToolOptions?.enabled !== true) return metaToolOptions
  const existingDescriptors = metaToolOptions.mcpDescriptors ?? []
  const descriptor = buildUserDefinedToolsDescriptor(userTools, instructionToolNames)
  const otherDescriptors = existingDescriptors.filter(candidate => candidate.serverIdentifier !== CUSTOM_USER_TOOLS_PROVIDER_ID)
  return new McpMetaToolOptions({
    enabled: true,
    mcpDescriptors: [...otherDescriptors, descriptor],
  })
}

/**
 * The meta tool's options with the user-defined tools merged in, turning the meta tool on when a
 * session has them: a tool the model is not told about is a tool the model cannot call.
 */
export function getMcpMetaToolOptionsWithUserDefinedTools(
  metaToolOptions: McpMetaToolOptions | undefined,
  mcpTools: readonly UserDefinedMcpTool[],
  instructionToolNames?: MetaToolInstructionNames,
): McpMetaToolOptions | undefined {
  const hasUserTools = mcpTools.some(isUserDefinedMcpTool)
  if (!hasUserTools) return metaToolOptions
  const baseOptions = metaToolOptions?.enabled === true
    ? metaToolOptions
    : new McpMetaToolOptions({
      enabled: true,
      mcpDescriptors: metaToolOptions?.mcpDescriptors ?? [],
    })
  return mergeUserDefinedToolsIntoMetaToolOptions(baseOptions, mcpTools, instructionToolNames)
}
