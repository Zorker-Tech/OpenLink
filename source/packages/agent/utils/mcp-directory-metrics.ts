import type { Context } from "../../context/context.ts"
import { createCounter, createHistogram } from "../../metrics/index.ts"

const MCP_DIRECTORY_SEGMENT = "/mcps/"
const directoryAccess = createCounter("agent.tools.mcp_directory_access", {
  description: "Number of times a tool accessed the MCP file system directory (tool descriptors, resources, etc.)",
  labelNames: ["tool"],
})
const directoryResponseSize = createHistogram("agent.tools.mcp_directory_response_bytes", {
  description: "Size of tool response in bytes when accessing the MCP file system directory (context window impact)",
  labelNames: ["tool"],
})

export function trackMcpDirectoryAccessIfApplicable(ctx: Context, path: string | undefined, tool: string): void {
  if (path?.includes(MCP_DIRECTORY_SEGMENT)) directoryAccess.increment(ctx, 1, { tool })
}

export function trackMcpDirectoryResponseBytes(ctx: Context, responseBytes: number, tool: string): void {
  directoryResponseSize.histogram(ctx, responseBytes, { tool })
}
