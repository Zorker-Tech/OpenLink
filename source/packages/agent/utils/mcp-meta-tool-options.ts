/**
 * What the MCP meta tool is told about the tools this session actually has.
 *
 * The meta tool's instructions name other tools — the one that discovers schemas, the one that invokes
 * them, the ones that read and list a server's resources — and those names are only known once the tool
 * set has been assembled. So the names are read back out of the assembled set rather than configured,
 * which is what keeps the instructions from naming a tool the session does not have.
 *
 * Two adjustments follow from that. The user-defined tools' descriptor is rewritten with the real
 * names, because it was built before the set existed. And when the session has its own on-demand tools,
 * their descriptor replaces whatever was registered under the reserved namespace, so the namespace
 * describes the tools that are there now.
 */

import { McpDescriptor, type McpDescriptor as McpDescriptorValue } from "../../proto/generated/agent/v1/mcp_pb.ts"
import { CUSTOM_USER_TOOLS_PROVIDER_ID, DYNAMIC_TOOLS_NAMESPACE } from "../../agent-exec/mcp-operations.ts"
import { buildUserDefinedToolsInstructions } from "./mcp-user-defined-tools.ts"

export interface McpSnapshotToolNames {
  readonly discoveryToolName: string
  readonly invocationToolName: string
  readonly useDynamicToolNamespaces: boolean
  readonly fetchMcpResourceToolName?: string | undefined
  readonly listMcpResourcesToolName?: string | undefined
}

export interface McpSnapshotTool {
  readonly name: string
  readonly dynamicToolMetaRole?: string | undefined
}

/** The part of a tool set the snapshot is read from. */
export interface McpSnapshotToolSet {
  getStaticTools(): readonly McpSnapshotTool[]
  getStaticTool(identifier: string): McpSnapshotTool | undefined
  getDynamicToolRegistry(): {
    getMcpDescriptor(toolNames: McpSnapshotToolNames | undefined): McpDescriptorValue | undefined
  } | undefined
}

export interface SnapshotMcpMetaToolOptions {
  readonly enabled: boolean
  readonly mcpDescriptors: readonly McpDescriptorValue[]
  readonly snapshotToolNames?: McpSnapshotToolNames | undefined
}

function patchUserDefinedToolsDescriptor(
  descriptors: readonly McpDescriptorValue[],
  toolNames: McpSnapshotToolNames,
): McpDescriptorValue[] {
  return descriptors.map(descriptor => {
    if (descriptor.serverIdentifier !== CUSTOM_USER_TOOLS_PROVIDER_ID) return descriptor
    return new McpDescriptor({
      ...descriptor,
      serverUseInstructions: buildUserDefinedToolsInstructions(descriptor.tools, toolNames),
    })
  })
}

function isReservedDynamicToolsNamespace(namespace: string): boolean {
  return namespace === DYNAMIC_TOOLS_NAMESPACE
}

function withMcpMetaToolSnapshotToolNames(
  metaToolOptions: SnapshotMcpMetaToolOptions | undefined,
  snapshotToolNames: McpSnapshotToolNames | undefined,
  builtinToolsDescriptor: McpDescriptorValue | undefined,
): SnapshotMcpMetaToolOptions | undefined {
  if (!metaToolOptions) return undefined
  let mcpDescriptors = snapshotToolNames &&
      metaToolOptions.mcpDescriptors.some(descriptor => descriptor.serverIdentifier === CUSTOM_USER_TOOLS_PROVIDER_ID)
    ? patchUserDefinedToolsDescriptor(metaToolOptions.mcpDescriptors, {
      discoveryToolName: snapshotToolNames.discoveryToolName,
      invocationToolName: snapshotToolNames.invocationToolName,
      useDynamicToolNamespaces: snapshotToolNames.useDynamicToolNamespaces,
    })
    : metaToolOptions.mcpDescriptors
  if (builtinToolsDescriptor !== undefined) {
    mcpDescriptors = [
      ...mcpDescriptors.filter(descriptor => !isReservedDynamicToolsNamespace(descriptor.serverIdentifier)),
      builtinToolsDescriptor,
    ]
  }
  return {
    ...metaToolOptions,
    mcpDescriptors,
    ...(snapshotToolNames ? { snapshotToolNames } : {}),
  }
}

/**
 * The names the meta tool's instructions need, or nothing when the session cannot expose on-demand
 * tools at all: without both meta tools the model has no way to reach them, and without a registry
 * there is no namespace to reach them in.
 */
export function getMcpMetaToolSnapshotToolNames(toolSet: McpSnapshotToolSet): McpSnapshotToolNames | undefined {
  const tools = toolSet.getStaticTools()
  const discoveryToolName = tools.find(tool => tool.dynamicToolMetaRole === "discovery")?.name
  const invocationToolName = tools.find(tool => tool.dynamicToolMetaRole === "invocation")?.name
  const fetchMcpResourceToolName = toolSet.getStaticTool("FETCH_MCP_RESOURCE")?.name
  const useDynamicToolNamespaces = toolSet.getDynamicToolRegistry() !== undefined
  if (!discoveryToolName || !invocationToolName || (!useDynamicToolNamespaces && !fetchMcpResourceToolName)) return undefined
  const listMcpResourcesToolName = toolSet.getStaticTool("LIST_MCP_RESOURCES")?.name
  return {
    discoveryToolName,
    invocationToolName,
    useDynamicToolNamespaces,
    ...(fetchMcpResourceToolName ? { fetchMcpResourceToolName } : {}),
    ...(listMcpResourcesToolName ? { listMcpResourcesToolName } : {}),
  }
}

/** The meta tool's options with this session's tool names, and its own on-demand tools, folded in. */
export function withToolSetMcpSnapshot(
  metaToolOptions: SnapshotMcpMetaToolOptions | undefined,
  toolSet: McpSnapshotToolSet,
): SnapshotMcpMetaToolOptions | undefined {
  const toolNames = getMcpMetaToolSnapshotToolNames(toolSet)
  return withMcpMetaToolSnapshotToolNames(
    metaToolOptions,
    toolNames,
    toolSet.getDynamicToolRegistry()?.getMcpDescriptor(toolNames),
  )
}
