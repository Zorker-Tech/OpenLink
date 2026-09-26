/**
 * The tools the platform offers around its own spotlight, described to the model with what each one is for.
 */
import { spotlightToolResultContent, type SpotlightContentPart } from "../../../shared/slate-spotlight.ts";
import { ToolSetHandle } from "../../../packages/agent/tools/tool-execution.ts";
import { partitionDynamicTools } from "../../../packages/agent/tools/exclude-tools.ts";
import type { DynamicToolRegistry } from "../../../packages/agent/tools/mcp/builtin-tools.ts";

export interface SlateTool {
  readonly name: string;
  readonly toolIdentifier?: string;
  readonly dynamic?: boolean;
  readonly dynamicToolMetaRole?: string;
  readonly customToolFormat?: unknown;
  readonly contextType?: { readonly type?: string };
  readonly render?: (...args: readonly unknown[]) => Promise<{ content: unknown; readonly [key: string]: unknown }>;
}
export function withSpotlightedToolResult<T extends SlateTool>(tool: T): T {
  if (tool.render === undefined) return tool;
  return {
    ...tool,
    render: async (...args: readonly unknown[]) => {
      const result = await tool.render!(...args);
      const content = Array.isArray(result.content)
        ? spotlightToolResultContent(tool.name, result.content as SpotlightContentPart[])
        : result.content;
      return { ...result, content };
    },
  };
}
export function fencedToolSet<T extends SlateTool>(
  tools: readonly T[],
  enabled: boolean,
  dynamicToolRegistry?: Pick<DynamicToolRegistry, "replaceTools">,
): ToolSetHandle {
  const finalTools = enabled ? tools.map((tool) => withSpotlightedToolResult(tool)) : [...tools];
  if (dynamicToolRegistry === undefined) return ToolSetHandle.fromTools(finalTools);
  const { staticTools, dynamicTools } = partitionDynamicTools(finalTools, "final");
  return ToolSetHandle.fromTools({ staticTools, dynamicTools, dynamicToolRegistry });
}
