import type { Context } from "../../context/context.ts"
import { createCounter, createHistogram } from "../../metrics/index.ts"

const eligibleInvocation = createCounter("mcp.discovery.eligible_model_invocation", {
  description: "Model invocations where MCP discovery was available (tagged by discovery mode; use companion histogram for server counts)",
  labelNames: ["mcp_discovery_mode"],
})
const eligibleServerCount = createHistogram("mcp.discovery.eligible_catalog_server_count", {
  description: "MCP server count in discovery context for eligible model invocations (histogram value is the raw count)",
  labelNames: ["mcp_discovery_mode"],
})
const promptToolTokens = createHistogram("mcp.discovery.prompt_tool_tokens", {
  description: "Prompt token count attributable to MCP tool definitions for a model invocation",
  labelNames: ["mcp_discovery_mode"],
})
const promptToolCount = createHistogram("mcp.discovery.prompt_tool_count", {
  description: "Prompt-visible MCP tool count for a model invocation (histogram value is the raw count)",
  labelNames: ["mcp_discovery_mode"],
})
const searchThenCallOutcome = createCounter("mcp.meta.search_then_call_result", {
  description: "Outcome of CallMcpTool executions that were preceded by GetMcpTools in search mode within the same turn",
  labelNames: ["outcome"],
})

export function emitMcpEligibleModelInvocation(ctx: Context, input: { readonly discoveryMode: string; readonly serverCount: number }): void {
  if (input.discoveryMode === "disabled") return
  eligibleInvocation.increment(ctx, 1, { mcp_discovery_mode: input.discoveryMode })
  eligibleServerCount.histogram(ctx, input.serverCount, { mcp_discovery_mode: input.discoveryMode })
}

export function emitMcpPromptToolStats(ctx: Context, input: { readonly discoveryMode: string; readonly toolTokens: number; readonly toolCount: number }): void {
  if (input.discoveryMode === "disabled") return
  const labels = { mcp_discovery_mode: input.discoveryMode }
  promptToolTokens.histogram(ctx, input.toolTokens, labels)
  promptToolCount.histogram(ctx, input.toolCount, labels)
}

export function emitMcpSearchThenCallResult(ctx: Context, outcome: string): void {
  searchThenCallOutcome.increment(ctx, 1, { outcome })
}
