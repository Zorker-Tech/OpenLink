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

async function renderWithSpotlight(
  toolName: string,
  render: NonNullable<SlateTool["render"]>,
  arguments_: readonly unknown[],
): Promise<{ content: unknown; readonly [key: string]: unknown }> {
  const result = await render(...arguments_);
  if (!Array.isArray(result.content)) return result;

  return {
    ...result,
    content: spotlightToolResultContent(toolName, result.content as SpotlightContentPart[]),
  };
}

export function withSpotlightedToolResult<T extends SlateTool>(tool: T): T {
  const render = tool.render;
  if (render === undefined) return tool;

  return {
    ...tool,
    render: (...arguments_) => renderWithSpotlight(tool.name, render, arguments_),
  };
}

function selectedTools<T extends SlateTool>(tools: readonly T[], enabled: boolean): T[] {
  return enabled ? tools.map((tool) => withSpotlightedToolResult(tool)) : Array.from(tools);
}

export function fencedToolSet<T extends SlateTool>(
  tools: readonly T[],
  enabled: boolean,
  dynamicToolRegistry?: Pick<DynamicToolRegistry, "replaceTools">,
): ToolSetHandle {
  const offeredTools = selectedTools(tools, enabled);
  if (dynamicToolRegistry === undefined) return ToolSetHandle.fromTools(offeredTools);

  const partition = partitionDynamicTools(offeredTools, "final");
  return ToolSetHandle.fromTools({
    staticTools: partition.staticTools,
    dynamicTools: partition.dynamicTools,
    dynamicToolRegistry,
  });
}
