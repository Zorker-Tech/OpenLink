import { routedMcpRecord } from "./routed-mcp-shapes.ts";
import type { RoutedMcpTool } from "./routed-mcp-bridge-contracts.ts";

const READ_ACTION = /(^|[^a-z])(read|search|find|list|get|fetch|query|lookup|inspect|view|download|retrieve)([^a-z]|$)/;
const WRITE_ACTION = /(send|create|update|delete|remove|write|upload|post|reply|archive|move|rename|modify|cancel|purchase|buy)/;

/** Prefer repeatable hints only when no write-like action appears in the exposed tool metadata. */
export function isRoutedToolReadOnly(tool: RoutedMcpTool): boolean {
  const searchableText = `${tool.name} ${tool.toolName} ${tool.description ?? ""}`.toLowerCase();
  return READ_ACTION.test(searchableText) && !WRITE_ACTION.test(searchableText);
}

/** Keep only tool records with the routing identity needed by the call port. */
export function routedMcpTools(value: unknown): Map<string, RoutedMcpTool> {
  if (!Array.isArray(value)) return new Map();
  const tools = new Map<string, RoutedMcpTool>();
  for (const item of value) {
    const tool = routedMcpRecord(item);
    if (typeof tool?.name !== "string" || typeof tool.providerIdentifier !== "string" || typeof tool.toolName !== "string") continue;
    tools.set(tool.name, tool as unknown as RoutedMcpTool);
  }
  return tools;
}

/** Shape list results for the bridge while deriving conservative annotations. */
export function describeRoutedMcpTools(tools: Iterable<RoutedMcpTool>): Record<string, unknown>[] {
  return [...tools].map((tool) => {
    const readOnly = isRoutedToolReadOnly(tool);
    return {
      name: tool.name,
      description: tool.description ?? `${tool.toolName} via ${tool.providerIdentifier}`,
      inputSchema: routedMcpRecord(tool.inputSchema) ?? { type: "object", additionalProperties: true },
      annotations: {
        readOnlyHint: readOnly,
        destructiveHint: !readOnly,
        idempotentHint: readOnly,
        openWorldHint: !readOnly,
      },
    };
  });
}
