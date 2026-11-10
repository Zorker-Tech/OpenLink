import { ToolSetHandle } from "../tool-execution.ts";
import {
  createCallMcpTool,
  type CreateCallMcpToolOptions,
} from "./mcp.ts";
import { createGetMcpToolsTool } from "./get-mcp-tools.ts";

export interface McpToolRegistryOptions extends CreateCallMcpToolOptions {
  readonly existingTools?: readonly Record<string, unknown>[] | undefined;
  readonly projectDir?: string | undefined;
}

type DiscoveryOptions = NonNullable<Parameters<typeof createGetMcpToolsTool>[1]>;

function discoveryOptionsFrom(options: McpToolRegistryOptions): DiscoveryOptions {
  const fields = [
    ["resourceAccessor", options.resourceAccessor],
    ["projectDir", options.projectDir],
    ["allowInteractiveMcpAuth", options.allowInteractiveMcpAuth],
    ["dynamicToolRegistry", options.dynamicToolRegistry],
    ["isMcpToolBlocked", options.isMcpToolBlocked],
    ["callMcpToolName", options.name],
  ] as const;
  return Object.fromEntries(fields.filter(([, value]) => value !== undefined)) as DiscoveryOptions;
}

function discoveryToolFrom(options: McpToolRegistryOptions) {
  const descriptors = options.mcpMetaToolOptions;
  if (descriptors === undefined) return undefined;
  return createGetMcpToolsTool(descriptors, discoveryOptionsFrom(options));
}

function invocationOptionsFrom(options: McpToolRegistryOptions): CreateCallMcpToolOptions {
  const { existingTools: _providedTools, projectDir: _projectDirectory, ...invocation } = options;
  return invocation;
}

function toolsFor(options: McpToolRegistryOptions): Record<string, unknown>[] {
  const discovery = discoveryToolFrom(options);
  return [
    ...(options.existingTools ?? []),
    ...(discovery === undefined ? [] : [discovery]),
    createCallMcpTool(invocationOptionsFrom(options)),
  ];
}

/** Assemble caller tools, optional discovery and the invocation tool in the order the agent consumes them. */
export function createMcpToolRegistry(options: McpToolRegistryOptions): ToolSetHandle {
  return ToolSetHandle.fromTools(toolsFor(options));
}
