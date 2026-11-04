import { McpDescriptor, type McpDescriptor as McpDescriptorValue } from "../proto/generated/agent/v1/mcp_pb.ts"

const EXTERNAL_APP_CONTROL_SERVER_ID = "cursor-app-control"
const EXTERNAL_WORKSPACE_MUTATION_TOOL_NAMES = new Set([
  "move_agent_to_root",
  "move_agent_to_cloned_root",
  "create_project",
])

/** Removes counterpart-owned root-changing tools before descriptors enter Slate's prompt model. */
export function filterInteropProjectWorkspaceMutationMcpDescriptors(
  descriptors: readonly McpDescriptorValue[],
): McpDescriptorValue[] {
  return descriptors.map(descriptor => {
    if (descriptor.serverIdentifier.toLowerCase() !== EXTERNAL_APP_CONTROL_SERVER_ID) return descriptor
    return new McpDescriptor({
      ...descriptor,
      tools: descriptor.tools.filter(tool => !EXTERNAL_WORKSPACE_MUTATION_TOOL_NAMES.has(tool.toolName.toLowerCase())),
    })
  })
}
