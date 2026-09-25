/**
 * What the MCP meta tools report about themselves.
 *
 * The meta tools are the agent's window onto MCP servers, and the numbers that matter about them are
 * the ones that explain a bad turn: how long a discovery call took, how many tools came back, how
 * many bytes that put in the context window, and whether the model called a tool without reading its
 * definition first (a model error, not a server one). Discovery is also gated by mode, and a disabled
 * mode reports nothing at all rather than reporting zeros.
 */

import type { Context } from "../../context/context.ts"
import { createLogger } from "../../context/logging.ts"
import { createCounter, createHistogram } from "../../metrics/index.ts"

const logger = createLogger("mcp.meta.failure")

const getMcpToolsDuration = createHistogram("mcp.meta.get_tools_duration_ms", {
  description: "Duration of GetMcpTools calls in milliseconds",
  labelNames: ["mode"],
})
const getMcpToolsSuccess = createCounter("mcp.meta.get_tools_success", {
  description: "Successful GetMcpTools calls",
  labelNames: ["mode"],
})
const getMcpToolsError = createCounter("mcp.meta.get_tools_error", {
  description: "Failed GetMcpTools calls",
  labelNames: ["mode", "failure_reason"],
})
const getMcpToolsResultCount = createHistogram("mcp.meta.get_tools_result_count", {
  description: "Number of results returned by GetMcpTools",
  labelNames: ["mode"],
})
const getMcpToolsResponseBytes = createHistogram("mcp.meta.get_tools_response_bytes", {
  description: "Size of GetMcpTools response in bytes (context window impact)",
  labelNames: ["mode"],
})
const getMcpToolsPayloadBytes = createHistogram("mcp.meta.get_tools_payload_bytes", {
  description: "Size of the full GetMcpTools JSON payload before any file-output truncation",
  labelNames: ["mode"],
})
const getMcpToolsFileOutput = createCounter("mcp.meta.get_tools_file_output", {
  description: "GetMcpTools calls that wrote output to file (large results)",
  labelNames: ["mode"],
})

const callMcpToolDuration = createHistogram("mcp.meta.call_tool_duration_ms", {
  description: "Duration of CallMcpTool calls in milliseconds",
  labelNames: ["mcp_mode"],
})
const callMcpToolSuccess = createCounter("mcp.meta.call_tool_success", {
  description: "Successful CallMcpTool calls",
  labelNames: ["mcp_mode"],
})
const callMcpToolError = createCounter("mcp.meta.call_tool_error", {
  description: "Failed CallMcpTool calls",
  labelNames: ["mcp_mode", "failure_reason", "retryable"],
})
const callMcpToolWithoutReadDef = createCounter("mcp.meta.call_tool_without_read_def", {
  description: "CallMcpTool called without reading tool definition first (model error)",
  labelNames: ["mcp_mode"],
})
const callMcpToolResponseBytes = createHistogram("mcp.meta.call_tool_response_bytes", {
  description: "Size of CallMcpTool response in bytes (context window impact)",
  labelNames: ["mcp_mode"],
})
const callMcpToolOutputSpill = createCounter("mcp.meta.output_spill", {
  description: "Outcome of spilling oversized MCP tool output to an agent-tools file",
  labelNames: ["outcome"],
})

const fetchMcpResourceDuration = createHistogram("mcp.meta.fetch_resource_duration_ms", {
  description: "Duration of FetchMcpResource calls in milliseconds",
  labelNames: ["mcp_mode"],
})
const fetchMcpResourceSuccess = createCounter("mcp.meta.fetch_resource_success", {
  description: "Successful FetchMcpResource calls",
  labelNames: ["mcp_mode"],
})
const fetchMcpResourceError = createCounter("mcp.meta.fetch_resource_error", {
  description: "Failed FetchMcpResource calls",
  labelNames: ["mcp_mode", "failure_reason"],
})
const fetchMcpResourceResponseBytes = createHistogram("mcp.meta.fetch_resource_response_bytes", {
  description: "Size of FetchMcpResource response in bytes (context window impact)",
  labelNames: ["mcp_mode"],
})

const mcpEligibleModelInvocation = createCounter("mcp.discovery.eligible_model_invocation", {
  description: "Model invocations where MCP discovery was available (tagged by discovery mode; use companion histogram for server counts)",
  labelNames: ["mcp_discovery_mode"],
})
const mcpDiscoveryEligibleCatalogServerCount = createHistogram("mcp.discovery.eligible_catalog_server_count", {
  description: "MCP server count in discovery context for eligible model invocations (histogram value is the raw count)",
  labelNames: ["mcp_discovery_mode"],
})
const mcpPromptToolTokens = createHistogram("mcp.discovery.prompt_tool_tokens", {
  description: "Prompt token count attributable to MCP tool definitions for a model invocation",
  labelNames: ["mcp_discovery_mode"],
})
const mcpPromptToolCount = createHistogram("mcp.discovery.prompt_tool_count", {
  description: "Prompt-visible MCP tool count for a model invocation (histogram value is the raw count)",
  labelNames: ["mcp_discovery_mode"],
})
const mcpSearchThenCallResult = createCounter("mcp.meta.search_then_call_result", {
  description: "Outcome of CallMcpTool executions that were preceded by GetMcpTools in search mode within the same turn",
  labelNames: ["outcome"],
})

export const GET_MCP_TOOLS_FAILURE_REASONS = {
  INVALID_REGEX: "invalid_regex",
  SERVER_NOT_FOUND: "server_not_found",
  TOOL_NOT_FOUND: "tool_not_found",
  INVALID_ARGS: "invalid_args",
  OTHER: "other",
} as const

export const CALL_MCP_TOOL_FAILURE_REASONS = {
  SERVER_NOT_FOUND: "server_not_found",
  TOOL_NOT_FOUND: "tool_not_found",
  EXEC_NOT_FOUND: "exec_not_found",
  PERMISSION_DENIED: "permission_denied",
  TRANSPORT_ERROR: "transport_error",
  REJECTED: "rejected",
  WITHOUT_READ_DEF: "without_read_def",
  OTHER: "other",
} as const

/** Which shape a discovery call took, derived from what the model asked for. */
export function getGetMcpToolsMode(args: {
  readonly toolName?: unknown
  readonly pattern?: unknown
  readonly server?: unknown
}): "tool_detail" | "search" | "catalog" | "server_detail" {
  if (args.toolName !== undefined) return "tool_detail"
  if (args.pattern !== undefined) return "search"
  if (args.server === undefined) return "catalog"
  return "server_detail"
}

export interface GetMcpToolsMetricsInput {
  readonly mode: string
  readonly durationMs: number
  readonly success: boolean
  readonly failureReason?: string | undefined
  readonly resultCount?: number | undefined
  readonly responseBytes?: number | undefined
  readonly payloadBytes?: number | undefined
  readonly wroteToFile?: boolean | undefined
}

export function emitGetMcpToolsMetrics(ctx: Context, input: GetMcpToolsMetricsInput): void {
  const { mode, durationMs, success, failureReason, resultCount, responseBytes, payloadBytes, wroteToFile } = input
  getMcpToolsDuration.histogram(ctx, durationMs, { mode })
  if (success) getMcpToolsSuccess.increment(ctx, 1, { mode })
  else getMcpToolsError.increment(ctx, 1, { mode, failure_reason: failureReason ?? "unknown" })
  if (resultCount !== undefined) getMcpToolsResultCount.histogram(ctx, resultCount, { mode })
  if (responseBytes !== undefined) getMcpToolsResponseBytes.histogram(ctx, responseBytes, { mode })
  if (payloadBytes !== undefined) getMcpToolsPayloadBytes.histogram(ctx, payloadBytes, { mode })
  if (wroteToFile) getMcpToolsFileOutput.increment(ctx, 1, { mode })
}

export interface CallMcpToolMetricsInput {
  readonly mcpMode: string
  readonly durationMs: number
  readonly success: boolean
  readonly failureReason?: string | undefined
  readonly retryable?: boolean | undefined
  readonly responseBytes?: number | undefined
  readonly calledWithoutReadDef?: boolean | undefined
}

export function emitCallMcpToolMetrics(ctx: Context, input: CallMcpToolMetricsInput): void {
  const { mcpMode, durationMs, success, failureReason, retryable, responseBytes, calledWithoutReadDef } = input
  callMcpToolDuration.histogram(ctx, durationMs, { mcp_mode: mcpMode })
  if (success) callMcpToolSuccess.increment(ctx, 1, { mcp_mode: mcpMode })
  else {
    callMcpToolError.increment(ctx, 1, {
      mcp_mode: mcpMode,
      failure_reason: failureReason ?? "unknown",
      retryable: String(retryable ?? false),
    })
  }
  if (responseBytes !== undefined) callMcpToolResponseBytes.histogram(ctx, responseBytes, { mcp_mode: mcpMode })
  if (calledWithoutReadDef) callMcpToolWithoutReadDef.increment(ctx, 1, { mcp_mode: mcpMode })
}

export interface FetchMcpResourceMetricsInput {
  readonly mcpMode: string
  readonly durationMs: number
  readonly success: boolean
  readonly failureReason?: string | undefined
  readonly responseBytes?: number | undefined
}

export function emitFetchMcpResourceMetrics(
  ctx: Context,
  input: FetchMcpResourceMetricsInput,
): void {
  const { mcpMode, durationMs, success, failureReason, responseBytes } = input
  fetchMcpResourceDuration.histogram(ctx, durationMs, { mcp_mode: mcpMode })
  if (success) fetchMcpResourceSuccess.increment(ctx, 1, { mcp_mode: mcpMode })
  else fetchMcpResourceError.increment(ctx, 1, { mcp_mode: mcpMode, failure_reason: failureReason ?? "unknown" })
  if (responseBytes !== undefined) fetchMcpResourceResponseBytes.histogram(ctx, responseBytes, { mcp_mode: mcpMode })
}

export function emitMcpOutputSpillOutcome(ctx: Context, outcome: string): void {
  callMcpToolOutputSpill.increment(ctx, 1, { outcome })
}

/** A disabled discovery mode reports nothing: a zero would look like a server with no tools. */
export function emitMcpEligibleModelInvocation(
  ctx: Context,
  input: { readonly discoveryMode: string; readonly serverCount: number },
): void {
  if (input.discoveryMode === "disabled") return
  mcpEligibleModelInvocation.increment(ctx, 1, { mcp_discovery_mode: input.discoveryMode })
  mcpDiscoveryEligibleCatalogServerCount.histogram(ctx, input.serverCount, { mcp_discovery_mode: input.discoveryMode })
}

export function emitMcpPromptToolStats(
  ctx: Context,
  input: { readonly discoveryMode: string; readonly toolTokens: number; readonly toolCount: number },
): void {
  if (input.discoveryMode === "disabled") return
  const tags = { mcp_discovery_mode: input.discoveryMode }
  mcpPromptToolTokens.histogram(ctx, input.toolTokens, tags)
  mcpPromptToolCount.histogram(ctx, input.toolCount, tags)
}

export function emitMcpSearchThenCallResult(
  ctx: Context,
  outcome: string,
): void {
  mcpSearchThenCallResult.increment(ctx, 1, { outcome })
}

export interface McpMetaToolFailure {
  readonly tool: string
  readonly failureReason: string
  readonly retryable?: boolean | undefined
  readonly server?: string | undefined
  readonly toolName?: string | undefined
  readonly mode?: string | undefined
  readonly mcpMode?: string | undefined
  readonly durationMs?: number | undefined
  readonly errorMessage?: string | undefined
}

export function reportMcpMetaToolFailure(
  ctx: Context,
  error: unknown,
  data: McpMetaToolFailure,
): void {
  const errorMessage = error instanceof Error ? error.message : typeof error === "string" ? error : String(error)
  logger.warn(ctx, "MCP meta tool failure", {
    tool: data.tool,
    failure_reason: data.failureReason,
    retryable: data.retryable,
    server: data.server,
    toolName: data.toolName,
    mode: data.mode,
    mcp_mode: data.mcpMode,
    duration_ms: data.durationMs,
    error_message: data.errorMessage ?? errorMessage,
  })
}

const MCP_DIR_SEGMENT = "/mcps/"
const mcpDirectoryAccess = createCounter("agent.tools.mcp_directory_access", {
  description: "Number of times a tool accessed the MCP file system directory (tool descriptors, resources, etc.)",
  labelNames: ["tool"],
})
const mcpDirectoryResponseBytes = createHistogram("agent.tools.mcp_directory_response_bytes", {
  description: "Size of tool response in bytes when accessing the MCP file system directory (context window impact)",
  labelNames: ["tool"],
})

function isMcpDirectoryPath(path: string | undefined): boolean {
  return path?.includes(MCP_DIR_SEGMENT) ?? false
}

export function trackMcpDirectoryAccessIfApplicable(
  ctx: Context,
  path: string | undefined,
  tool: string,
): void {
  if (isMcpDirectoryPath(path)) mcpDirectoryAccess.increment(ctx, 1, { tool })
}

export function trackMcpDirectoryResponseBytes(
  ctx: Context,
  responseBytes: number,
  tool: string,
): void {
  mcpDirectoryResponseBytes.histogram(ctx, responseBytes, { tool })
}
