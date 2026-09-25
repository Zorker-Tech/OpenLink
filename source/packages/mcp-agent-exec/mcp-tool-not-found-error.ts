/**
 * The failure a tool call reports when the MCP tool it named does not exist.
 *
 * A tool that is not there is not the same as a tool that failed: the model named something the server
 * does not have, so the message lists what the server does have and the error carries both, which lets the
 * caller repair the call instead of only reporting it. The name is a property of the error rather than of
 * its class alone, because the same error may arrive from another realm — a host process or a worker —
 * where the class identity is gone, and the shape is what remains.
 */

export function isMcpToolNotFoundError(error: unknown): error is McpToolNotFoundError {
  if (error instanceof McpToolNotFoundError) {
    return true
  }
  if (!(error instanceof Error) || error.name !== "McpToolNotFoundError") {
    return false
  }
  const candidate = error as Error & {
    readonly toolName?: unknown
    readonly availableTools?: unknown
  }
  return typeof candidate.toolName === "string" && Array.isArray(candidate.availableTools)
}

export class McpToolNotFoundError extends Error {
  readonly toolName: string
  readonly availableTools: string[]

  constructor(toolName: string, availableTools: string[]) {
    super(`Tool ${toolName} not found, available tools: ${availableTools.join(", ")}`)
    this.toolName = toolName
    this.availableTools = availableTools
    this.name = "McpToolNotFoundError"
  }
}
