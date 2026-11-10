import type { Context } from "../../context/context.ts"
import { createLogger } from "../../context/logging.ts"
import { createCounter, createHistogram } from "../../metrics/index.ts"

const logger = createLogger("mcp.meta.failure")

const getToolsDuration = createHistogram("mcp.meta.get_tools_duration_ms", {
  description: "Duration of GetMcpTools calls in milliseconds",
  labelNames: ["mode"],
})
const getToolsSuccess = createCounter("mcp.meta.get_tools_success", {
  description: "Successful GetMcpTools calls",
  labelNames: ["mode"],
})
const getToolsError = createCounter("mcp.meta.get_tools_error", {
  description: "Failed GetMcpTools calls",
  labelNames: ["mode", "failure_reason"],
})
const getToolsResultCount = createHistogram("mcp.meta.get_tools_result_count", {
  description: "Number of results returned by GetMcpTools",
  labelNames: ["mode"],
})
const getToolsResponseBytes = createHistogram("mcp.meta.get_tools_response_bytes", {
  description: "Size of GetMcpTools response in bytes (context window impact)",
  labelNames: ["mode"],
})
const getToolsPayloadBytes = createHistogram("mcp.meta.get_tools_payload_bytes", {
  description: "Size of the full GetMcpTools JSON payload before any file-output truncation",
  labelNames: ["mode"],
})
const getToolsFileOutput = createCounter("mcp.meta.get_tools_file_output", {
  description: "GetMcpTools calls that wrote output to file (large results)",
  labelNames: ["mode"],
})

const callToolDuration = createHistogram("mcp.meta.call_tool_duration_ms", {
  description: "Duration of CallMcpTool calls in milliseconds",
  labelNames: ["mcp_mode"],
})
const callToolSuccess = createCounter("mcp.meta.call_tool_success", {
  description: "Successful CallMcpTool calls",
  labelNames: ["mcp_mode"],
})
const callToolError = createCounter("mcp.meta.call_tool_error", {
  description: "Failed CallMcpTool calls",
  labelNames: ["mcp_mode", "failure_reason", "retryable"],
})
const callToolWithoutReadDefinition = createCounter("mcp.meta.call_tool_without_read_def", {
  description: "CallMcpTool called without reading tool definition first (model error)",
  labelNames: ["mcp_mode"],
})
const callToolResponseBytes = createHistogram("mcp.meta.call_tool_response_bytes", {
  description: "Size of CallMcpTool response in bytes (context window impact)",
  labelNames: ["mcp_mode"],
})
const callToolOutputSpill = createCounter("mcp.meta.output_spill", {
  description: "Outcome of spilling oversized MCP tool output to an agent-tools file",
  labelNames: ["outcome"],
})

const fetchResourceDuration = createHistogram("mcp.meta.fetch_resource_duration_ms", {
  description: "Duration of FetchMcpResource calls in milliseconds",
  labelNames: ["mcp_mode"],
})
const fetchResourceSuccess = createCounter("mcp.meta.fetch_resource_success", {
  description: "Successful FetchMcpResource calls",
  labelNames: ["mcp_mode"],
})
const fetchResourceError = createCounter("mcp.meta.fetch_resource_error", {
  description: "Failed FetchMcpResource calls",
  labelNames: ["mcp_mode", "failure_reason"],
})
const fetchResourceResponseBytes = createHistogram("mcp.meta.fetch_resource_response_bytes", {
  description: "Size of FetchMcpResource response in bytes (context window impact)",
  labelNames: ["mcp_mode"],
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
  getToolsDuration.histogram(ctx, durationMs, { mode })
  if (success) getToolsSuccess.increment(ctx, 1, { mode })
  else getToolsError.increment(ctx, 1, { mode, failure_reason: failureReason ?? "unknown" })
  if (resultCount !== undefined) getToolsResultCount.histogram(ctx, resultCount, { mode })
  if (responseBytes !== undefined) getToolsResponseBytes.histogram(ctx, responseBytes, { mode })
  if (payloadBytes !== undefined) getToolsPayloadBytes.histogram(ctx, payloadBytes, { mode })
  if (wroteToFile) getToolsFileOutput.increment(ctx, 1, { mode })
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
  callToolDuration.histogram(ctx, durationMs, { mcp_mode: mcpMode })
  if (success) callToolSuccess.increment(ctx, 1, { mcp_mode: mcpMode })
  else callToolError.increment(ctx, 1, {
    mcp_mode: mcpMode,
    failure_reason: failureReason ?? "unknown",
    retryable: String(retryable ?? false),
  })
  if (responseBytes !== undefined) callToolResponseBytes.histogram(ctx, responseBytes, { mcp_mode: mcpMode })
  if (calledWithoutReadDef) callToolWithoutReadDefinition.increment(ctx, 1, { mcp_mode: mcpMode })
}

export interface FetchMcpResourceMetricsInput {
  readonly mcpMode: string
  readonly durationMs: number
  readonly success: boolean
  readonly failureReason?: string | undefined
  readonly responseBytes?: number | undefined
}

export function emitFetchMcpResourceMetrics(ctx: Context, input: FetchMcpResourceMetricsInput): void {
  const { mcpMode, durationMs, success, failureReason, responseBytes } = input
  fetchResourceDuration.histogram(ctx, durationMs, { mcp_mode: mcpMode })
  if (success) fetchResourceSuccess.increment(ctx, 1, { mcp_mode: mcpMode })
  else fetchResourceError.increment(ctx, 1, { mcp_mode: mcpMode, failure_reason: failureReason ?? "unknown" })
  if (responseBytes !== undefined) fetchResourceResponseBytes.histogram(ctx, responseBytes, { mcp_mode: mcpMode })
}

export function emitMcpOutputSpillOutcome(ctx: Context, outcome: string): void {
  callToolOutputSpill.increment(ctx, 1, { outcome })
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

export function reportMcpMetaToolFailure(ctx: Context, error: unknown, data: McpMetaToolFailure): void {
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
