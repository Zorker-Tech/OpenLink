/** Project the assembled tool set into the generated MCP options sent with an Agent action. */

import {
  McpDescriptor,
  McpMetaToolOptions,
  McpToolDescriptor,
  type McpDescriptor as InteropMcpDescriptor,
} from "../proto/generated/agent/v1/mcp_pb.ts"
import { Value } from "@bufbuild/protobuf"
import { CUSTOM_USER_TOOLS_PROVIDER_ID, DYNAMIC_TOOLS_NAMESPACE } from "../../../packages/agent-exec/mcp-operations.ts"
import { createSlateMcpMetaToolOptions, type McpToolForMeta } from "../../../host/runner/tools/mcp-meta-tools.ts"
import { buildUserDefinedToolsInstructions } from "../../../packages/agent/utils/mcp-user-defined-tools.ts"
import { createInteropMcpDescriptor } from "./mcp-builtins-adapter.ts"
import type { SlateMcpDescriptor } from "../../../packages/agent/tools/mcp/builtin-tools.ts"

function schemaValue(value: unknown): Value | undefined {
  if (value === undefined) return undefined
  return value instanceof Value ? value : Value.fromJson(value as never)
}

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
    getMcpDescriptor(toolNames: McpSnapshotToolNames | undefined): SlateMcpDescriptor | undefined
  } | undefined
}

export interface SnapshotMcpMetaToolOptions {
  readonly enabled: boolean
  readonly mcpDescriptors: readonly InteropMcpDescriptor[]
  readonly snapshotToolNames?: McpSnapshotToolNames | undefined
}

function patchUserDefinedToolsDescriptor(
  descriptors: readonly InteropMcpDescriptor[],
  toolNames: McpSnapshotToolNames,
): InteropMcpDescriptor[] {
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
  options: SnapshotMcpMetaToolOptions | undefined,
  names: McpSnapshotToolNames | undefined,
  builtinTools: InteropMcpDescriptor | undefined,
): SnapshotMcpMetaToolOptions | undefined {
  if (!options) return undefined
  let descriptors = names && options.mcpDescriptors.some(descriptor => descriptor.serverIdentifier === CUSTOM_USER_TOOLS_PROVIDER_ID)
    ? patchUserDefinedToolsDescriptor(options.mcpDescriptors, {
      discoveryToolName: names.discoveryToolName,
      invocationToolName: names.invocationToolName,
      useDynamicToolNamespaces: names.useDynamicToolNamespaces,
    })
    : options.mcpDescriptors
  if (builtinTools !== undefined) {
    descriptors = [
      ...descriptors.filter(descriptor => !isReservedDynamicToolsNamespace(descriptor.serverIdentifier)),
      builtinTools,
    ]
  }
  return { ...options, mcpDescriptors: descriptors, ...(names ? { snapshotToolNames: names } : {}) }
}

/** Find the discovery/invocation names and resource tools available to this session. */
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

/** Add current tool names and on-demand descriptors to the outgoing Agent options. */
export function withToolSetMcpSnapshot(
  options: SnapshotMcpMetaToolOptions | undefined,
  toolSet: McpSnapshotToolSet,
): SnapshotMcpMetaToolOptions | undefined {
  const names = getMcpMetaToolSnapshotToolNames(toolSet)
  const slateBuiltins = toolSet.getDynamicToolRegistry()?.getMcpDescriptor(names)
  const interopBuiltins = slateBuiltins === undefined ? undefined : createInteropMcpDescriptor(slateBuiltins)
  return withMcpMetaToolSnapshotToolNames(options, names, interopBuiltins)
}

/** Project the Slate tool catalog into the generated message consumed by the Agent meta tool. */
export function projectTurnToolsIntoInteropMetaOptions(tools: readonly McpToolForMeta[]): McpMetaToolOptions {
  const slateOptions = createSlateMcpMetaToolOptions(tools)
  return new McpMetaToolOptions({
    enabled: slateOptions.enabled,
    mcpDescriptors: slateOptions.mcpDescriptors.map(descriptor => new McpDescriptor({
      serverIdentifier: descriptor.serverIdentifier,
      serverName: descriptor.serverName,
      ...(typeof descriptor.plugin === "string" ? { plugin: descriptor.plugin } : {}),
      ...(typeof descriptor.marketplace === "string" ? { marketplace: descriptor.marketplace } : {}),
      ...(descriptor.pluginDbId == null ? {} : { pluginDbId: descriptor.pluginDbId }),
      ...(descriptor.marketplaceId == null ? {} : { marketplaceId: descriptor.marketplaceId }),
      tools: descriptor.tools.map(tool => {
        const inputSchema = schemaValue(tool.inputSchema)
        return new McpToolDescriptor({
          toolName: tool.toolName,
          ...(tool.description == null ? {} : { description: tool.description }),
          ...(inputSchema === undefined ? {} : { inputSchema }),
        })
      }),
    })),
  })
}
