/**
 * The MCP catalogue as the prompt shows it: which servers exist, and what each offers.
 *
 * The catalogue is a snapshot taken when the conversation started, and it says so, because the servers
 * behind it change: a tool can appear or disappear, and a server can start needing authentication. So
 * the list is presented with the instruction to check the current state before calling anything.
 *
 * Two shapes again, because the two routes to MCP differ: as servers with tools, or as dynamic
 * namespaces with tools. The namespace form also records where each namespace came from — the platform's
 * own tools or an MCP server — since that changes what the model can expect from it.
 *
 * One filter lives here rather than in the catalogue: a project's workspace mutation tools are removed
 * when the conversation is scoped to a project, because moving the agent to another root is not
 * something a project conversation should be able to do.
 */

import { McpDescriptor, type McpDescriptor as McpDescriptorValue } from "../../proto/generated/agent/v1/mcp_pb.ts"
import { jsx, jsxs, Fragment, type PromptNode } from "../../prompt-jsx/index.ts"
import { DYNAMIC_TOOLS_NAMESPACE } from "../../agent-exec/mcp-operations.ts"

const APP_CONTROL_MCP_SERVER_ID = "cursor-app-control"
const WORKSPACE_MUTATION_TOOLS = new Set([
  "move_agent_to_root",
  "move_agent_to_cloned_root",
  "create_project",
])

function buildMcpMetaToolServerEntries(
  mcpDescriptors: readonly McpDescriptorValue[],
  useDynamicToolNamespaces: boolean,
): string {
  return mcpDescriptors.map(descriptor => {
    const attrs = [`name="${descriptor.serverIdentifier}"`]
    const serverToolNames = descriptor.tools.map(tool => tool.toolName).join(", ")
    if (serverToolNames.length > 0) attrs.push(`tools="${serverToolNames}"`)
    if (useDynamicToolNamespaces) {
      if (descriptor.serverUseInstructions) attrs.push(`namespaceUseInstructions="${descriptor.serverUseInstructions}"`)
      attrs.push(`source="${descriptor.serverIdentifier === DYNAMIC_TOOLS_NAMESPACE ? "platform" : "mcp"}"`)
      return `<namespace ${attrs.join(" ")} />`
    }
    if (descriptor.serverUseInstructions) attrs.push(`serverUseInstructions="${descriptor.serverUseInstructions}"`)
    return `<mcp_meta_tool_server ${attrs.join(" ")} />`
  }).join("\n")
}

export function McpMetaToolServerList(
  mcpDescriptors: readonly McpDescriptor[],
  useDynamicToolNamespaces = false,
): string {
  if (mcpDescriptors.length === 0) return ""
  const serverEntries = buildMcpMetaToolServerEntries(mcpDescriptors, useDynamicToolNamespaces)
  if (useDynamicToolNamespaces) return `<dynamic_tool_namespaces>\n${serverEntries}\n</dynamic_tool_namespaces>`
  return `<mcp_meta_tool_servers>\n${serverEntries}\n</mcp_meta_tool_servers>`
}

function isProjectWorkspaceMutationMcpTool(args: {
  readonly serverIdentifier: string
  readonly toolName: string
}): boolean {
  return args.serverIdentifier.toLowerCase() === APP_CONTROL_MCP_SERVER_ID &&
    WORKSPACE_MUTATION_TOOLS.has(args.toolName.toLowerCase())
}

export function filterProjectWorkspaceMutationMcpDescriptors(
  descriptors: readonly McpDescriptorValue[],
): McpDescriptorValue[] {
  return descriptors.map(descriptor => new McpDescriptor({
    ...descriptor,
    tools: descriptor.tools.filter(tool => !isProjectWorkspaceMutationMcpTool({
      serverIdentifier: descriptor.serverIdentifier,
      toolName: tool.toolName,
    })),
  }))
}

interface SnapshotToolNames {
  readonly discoveryToolName?: string | undefined
  readonly invocationToolName?: string | undefined
  readonly useDynamicToolNamespaces?: boolean | undefined
}

interface McpMetaToolCatalogOptions {
  readonly mcpDescriptors: readonly McpDescriptorValue[]
  readonly snapshotToolNames?: SnapshotToolNames | undefined
}

export function McpMetaToolServersSection({ mcpMetaToolOptions, mcpInfoComplete }: {
  readonly mcpMetaToolOptions: McpMetaToolCatalogOptions
  readonly mcpInfoComplete?: boolean | undefined
}): PromptNode {
  const useDynamicToolNamespaces = mcpMetaToolOptions.snapshotToolNames?.useDynamicToolNamespaces ?? false
  const serverList = McpMetaToolServerList(mcpMetaToolOptions.mcpDescriptors, useDynamicToolNamespaces)
  // Nothing to list and nothing still arriving: no section at all.
  if (serverList.length === 0 && mcpInfoComplete !== false) return null
  return jsxs("section", {
    title: useDynamicToolNamespaces ? "dynamic_tool_catalog" : "mcp_server_catalog",
    children: [
      mcpInfoComplete === false && jsx("p", {
        children: useDynamicToolNamespaces
          ? "Dynamic namespace discovery is still warming. The namespace and tool list may be incomplete."
          : "MCP server discovery is still warming. The server and tool list below may be incomplete; additional servers may become available shortly.",
      }),
      jsxs("p", {
        children: [
          useDynamicToolNamespaces
            ? "These dynamic tool namespaces were available when this conversation started. Availability may have changed, so "
            : "These were the available MCP servers and tools when this conversation started. Tool availability may have changed since then, so ",
          mcpMetaToolOptions.snapshotToolNames
            ? jsxs(Fragment, {
              children: [
                "use `",
                mcpMetaToolOptions.snapshotToolNames.discoveryToolName,
                "` to check current state before calling `",
                mcpMetaToolOptions.snapshotToolNames.invocationToolName,
                "`.",
              ],
            })
            : jsx(Fragment, {
              children: "use the MCP tool-discovery meta tool to check current state before calling the MCP tool-invocation meta tool.",
            }),
        ],
      }),
      serverList,
    ],
  })
}
