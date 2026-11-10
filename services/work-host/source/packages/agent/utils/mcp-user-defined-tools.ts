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
