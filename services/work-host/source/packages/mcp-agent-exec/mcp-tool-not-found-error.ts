/**
 * The failure a tool call reports when the MCP tool it named does not exist.
 *
 * A tool that is not there is not the same as a tool that failed: the model named something the server
 * does not have, so the message lists what the server does have and the error carries both, which lets the
 * caller repair the call instead of only reporting it. The name is a property of the error rather than of
 * its class alone, because the same error may arrive from another realm — a host process or a worker —
 * where the class identity is gone, and the shape is what remains.
 */

/** The name this failure carries across a realm, where the class identity does not survive. */
const TOOL_NOT_FOUND = "McpToolNotFoundError";

/** The message a missing tool reports: what was asked for, and what the server has instead. */
function missingToolMessage(toolName: string, availableTools: readonly string[]): string {
  return `Tool ${toolName} not found, available tools: ${availableTools.join(", ")}`;
}

/** Whether an error from another realm kept the name and the two fields a caller repairs the call from. */
function isForeignToolNotFoundError(value: unknown): value is McpToolNotFoundError {
  if (!(value instanceof Error) || value.name !== TOOL_NOT_FOUND) return false;
  const foreign = value as { toolName?: unknown; availableTools?: unknown };
  return typeof foreign.toolName === "string" && Array.isArray(foreign.availableTools);
}

/** Whether this is the failure a tool call reports when the tool it named does not exist. */
export function isMcpToolNotFoundError(value: unknown): value is McpToolNotFoundError {
  return value instanceof McpToolNotFoundError || isForeignToolNotFoundError(value);
}

export class McpToolNotFoundError extends Error {
  readonly toolName: string;
  readonly availableTools: string[];

  constructor(toolName: string, availableTools: string[]) {
    super(missingToolMessage(toolName, availableTools));
    this.toolName = toolName;
    this.availableTools = availableTools;
    this.name = TOOL_NOT_FOUND;
  }
}
