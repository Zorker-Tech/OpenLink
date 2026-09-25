/**
 * The MCP tools a session runs with, assembled into one set.
 *
 * A session needs two of them to be able to reach a server at all: the tool that discovers what is there
 * and the tool that calls what was found. The second is always built here; the first is only built when the
 * caller supplied the descriptor options it needs, and it is otherwise expected to arrive through the tools
 * the caller already had — which is what lets discovery be owned by whoever knows the session's servers
 * while invocation stays here.
 *
 * The set is what the agent's action handlers consume, so the tools are handed over as one: the caller's
 * existing tools first, then discovery if it was built, then the call tool.
 */

import { ToolSetHandle } from "../tool-execution.ts"
import {
  createCallMcpTool,
  type CreateCallMcpToolOptions,
} from "./mcp.ts"
import { createGetMcpToolsTool } from "./get-mcp-tools.ts"

export interface McpToolRegistryOptions extends CreateCallMcpToolOptions {
  readonly existingTools?: readonly Record<string, unknown>[] | undefined
  readonly projectDir?: string | undefined
}

/**
 * Installs the MCP invocation tool into the same ToolSetHandle consumed by agent action handlers. Discovery
 * remains an independently owned factory; callers may add it through existingTools when that owner is
 * available.
 */
export function createMcpToolRegistry(
  options: McpToolRegistryOptions,
): ToolSetHandle {
  const { existingTools = [], projectDir, ...callOptions } = options
  const discoveryTool = options.mcpMetaToolOptions === undefined
    ? undefined
    : createGetMcpToolsTool(options.mcpMetaToolOptions, {
      ...(options.resourceAccessor === undefined ? {} : { resourceAccessor: options.resourceAccessor }),
      ...(projectDir === undefined ? {} : { projectDir }),
      ...(options.allowInteractiveMcpAuth === undefined ? {} : { allowInteractiveMcpAuth: options.allowInteractiveMcpAuth }),
      ...(options.dynamicToolRegistry === undefined ? {} : { dynamicToolRegistry: options.dynamicToolRegistry }),
      ...(options.isMcpToolBlocked === undefined ? {} : { isMcpToolBlocked: options.isMcpToolBlocked }),
      // The model is told to call this tool by the name the caller gave the invocation tool.
      ...(options.name === undefined ? {} : { callMcpToolName: options.name }),
    })
  const callMcpTool = createCallMcpTool(callOptions)
  return ToolSetHandle.fromTools([
    ...existingTools,
    ...(discoveryTool === undefined ? [] : [discoveryTool]),
    callMcpTool,
  ])
}
