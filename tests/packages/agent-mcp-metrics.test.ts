import { test } from "node:test"
import assert from "node:assert/strict"

import { createContext, type Context } from "../../source/packages/context/context.ts"
import { loggerKey, type ContextLogEntry } from "../../source/packages/context/logging.ts"
import { metricsKey, type MetricHandle, type MetricLabels, type MetricsBackend } from "../../source/packages/metrics/index.ts"
import {
  emitCallMcpToolMetrics,
  emitFetchMcpResourceMetrics,
  emitGetMcpToolsMetrics,
  emitMcpEligibleModelInvocation,
  emitMcpOutputSpillOutcome,
  emitMcpPromptToolStats,
  emitMcpSearchThenCallResult,
  getGetMcpToolsMode,
  reportMcpMetaToolFailure,
  trackMcpDirectoryAccessIfApplicable,
  trackMcpDirectoryResponseBytes,
} from "../../source/packages/agent/utils/mcp-metrics.ts"

interface Recorded {
  readonly kind: string
  readonly name: string
  readonly value: number
  readonly labels: MetricLabels | undefined
}

function recordingMetrics(): { ctx: Context; calls: Recorded[] } {
  const calls: Recorded[] = []
  const keep = (kind: string) => (_context: Context, handle: MetricHandle, value: number, labels?: MetricLabels): void => {
    calls.push({ kind, name: handle.name, value, labels })
  }
  const backend: MetricsBackend = {
    record: keep("record"),
    increment: keep("increment"),
    gauge: keep("gauge"),
    histogram: keep("histogram"),
  }
  return { ctx: createContext().with(metricsKey, backend), calls }
}

function recordingLogs(): { ctx: Context; entries: ContextLogEntry[] } {
  const entries: ContextLogEntry[] = []
  return { ctx: createContext().with(loggerKey, { log: (_context, entry) => entries.push(entry) }), entries }
}

test("a discovery call's mode follows what the model asked for", () => {
  assert.equal(getGetMcpToolsMode({}), "catalog")
  assert.equal(getGetMcpToolsMode({ server: "github" }), "server_detail")
  assert.equal(getGetMcpToolsMode({ pattern: "pr" }), "search")
  assert.equal(getGetMcpToolsMode({ toolName: "create_pr" }), "tool_detail")
  assert.equal(getGetMcpToolsMode({ toolName: "create_pr", pattern: "pr" }), "tool_detail")
})

test("a successful discovery call reports its cost and its size", () => {
  const { ctx, calls } = recordingMetrics()
  emitGetMcpToolsMetrics(ctx, {
    mode: "search",
    durationMs: 12,
    success: true,
    resultCount: 3,
    responseBytes: 900,
    payloadBytes: 1200,
    wroteToFile: true,
  })
  assert.deepEqual(calls.map(call => [call.kind, call.name, call.value]), [
    ["histogram", "mcp.meta.get_tools_duration_ms", 12],
    ["increment", "mcp.meta.get_tools_success", 1],
    ["histogram", "mcp.meta.get_tools_result_count", 3],
    ["histogram", "mcp.meta.get_tools_response_bytes", 900],
    ["histogram", "mcp.meta.get_tools_payload_bytes", 1200],
    ["increment", "mcp.meta.get_tools_file_output", 1],
  ])
  assert.deepEqual(calls[0]?.labels, { mode: "search" })
})

test("a failed discovery call reports the reason, and an unstated one is unknown", () => {
  const { ctx, calls } = recordingMetrics()
  emitGetMcpToolsMetrics(ctx, { mode: "catalog", durationMs: 5, success: false, failureReason: "server_not_found" })
  emitGetMcpToolsMetrics(ctx, { mode: "catalog", durationMs: 6, success: false })
  assert.deepEqual(calls[1]?.labels, { mode: "catalog", failure_reason: "server_not_found" })
  assert.deepEqual(calls[3]?.labels, { mode: "catalog", failure_reason: "unknown" })
  assert.equal(calls.some(call => call.name === "mcp.meta.get_tools_result_count"), false, "an absent size is not reported as zero")
})

test("calling a tool reports whether a retry could help and whether its definition was read", () => {
  const { ctx, calls } = recordingMetrics()
  emitCallMcpToolMetrics(ctx, { mcpMode: "search", durationMs: 30, success: false, failureReason: "transport_error", retryable: true })
  emitCallMcpToolMetrics(ctx, { mcpMode: "search", durationMs: 31, success: false, calledWithoutReadDef: true })
  emitCallMcpToolMetrics(ctx, { mcpMode: "search", durationMs: 32, success: true, responseBytes: 100 })

  const failures = calls.filter(call => call.name === "mcp.meta.call_tool_error")
  assert.deepEqual(failures[0]?.labels, { mcp_mode: "search", failure_reason: "transport_error", retryable: "true" })
  assert.deepEqual(failures[1]?.labels, { mcp_mode: "search", failure_reason: "unknown", retryable: "false" })
  assert.equal(calls.some(call => call.name === "mcp.meta.call_tool_without_read_def"), true)
  assert.deepEqual(calls.find(call => call.name === "mcp.meta.call_tool_response_bytes")?.labels, { mcp_mode: "search" })
})

test("fetching a resource reports its duration and outcome", () => {
  const { ctx, calls } = recordingMetrics()
  emitFetchMcpResourceMetrics(ctx, { mcpMode: "catalog", durationMs: 8, success: true, responseBytes: 42 })
  emitFetchMcpResourceMetrics(ctx, { mcpMode: "catalog", durationMs: 9, success: false })
  assert.deepEqual(calls.map(call => call.name), [
    "mcp.meta.fetch_resource_duration_ms",
    "mcp.meta.fetch_resource_success",
    "mcp.meta.fetch_resource_response_bytes",
    "mcp.meta.fetch_resource_duration_ms",
    "mcp.meta.fetch_resource_error",
  ])
  assert.deepEqual(calls[4]?.labels, { mcp_mode: "catalog", failure_reason: "unknown" })
})

test("discovery statistics are reported only when discovery is on", () => {
  const { ctx, calls } = recordingMetrics()
  emitMcpEligibleModelInvocation(ctx, { discoveryMode: "disabled", serverCount: 5 })
  emitMcpPromptToolStats(ctx, { discoveryMode: "disabled", toolTokens: 100, toolCount: 2 })
  assert.equal(calls.length, 0, "a disabled mode reports nothing rather than zeros")

  emitMcpEligibleModelInvocation(ctx, { discoveryMode: "search", serverCount: 5 })
  emitMcpPromptToolStats(ctx, { discoveryMode: "search", toolTokens: 100, toolCount: 2 })
  assert.deepEqual(calls.map(call => [call.name, call.value]), [
    ["mcp.discovery.eligible_model_invocation", 1],
    ["mcp.discovery.eligible_catalog_server_count", 5],
    ["mcp.discovery.prompt_tool_tokens", 100],
    ["mcp.discovery.prompt_tool_count", 2],
  ])
  assert.deepEqual(calls[0]?.labels, { mcp_discovery_mode: "search" })
})

test("an output spill and a search-then-call outcome are counted by outcome", () => {
  const { ctx, calls } = recordingMetrics()
  emitMcpOutputSpillOutcome(ctx, "spilled")
  emitMcpSearchThenCallResult(ctx, "hit")
  assert.deepEqual(calls.map(call => [call.name, call.labels]), [
    ["mcp.meta.output_spill", { outcome: "spilled" }],
    ["mcp.meta.search_then_call_result", { outcome: "hit" }],
  ])
})

test("a meta tool failure is logged with everything needed to explain it", () => {
  const { ctx, entries } = recordingLogs()
  reportMcpMetaToolFailure(ctx, new Error("server refused"), {
    tool: "CallMcpTool",
    failureReason: "transport_error",
    retryable: true,
    server: "github",
    toolName: "create_pr",
    mcpMode: "search",
    durationMs: 12,
  })
  assert.equal(entries.length, 1)
  assert.equal(entries[0]?.level, "warn")
  assert.equal(entries[0]?.message, "MCP meta tool failure")
  assert.deepEqual(entries[0]?.metadata, {
    tool: "CallMcpTool",
    failure_reason: "transport_error",
    retryable: true,
    server: "github",
    toolName: "create_pr",
    mode: undefined,
    mcp_mode: "search",
    duration_ms: 12,
    error_message: "server refused",
  })

  const thrownValue = recordingLogs()
  reportMcpMetaToolFailure(thrownValue.ctx, "a string failure", { tool: "GetMcpTools", failureReason: "other" })
  assert.equal(thrownValue.entries[0]?.metadata?.error_message, "a string failure")
})

test("directory access is counted only for the MCP directory", () => {
  const { ctx, calls } = recordingMetrics()
  trackMcpDirectoryAccessIfApplicable(ctx, "/home/u/.slate/projects/ws/mcps/github/tools.json", "read")
  trackMcpDirectoryAccessIfApplicable(ctx, "/home/u/src/app.ts", "read")
  trackMcpDirectoryAccessIfApplicable(ctx, undefined, "read")
  assert.deepEqual(calls, [{ kind: "increment", name: "agent.tools.mcp_directory_access", value: 1, labels: { tool: "read" } }])

  trackMcpDirectoryResponseBytes(ctx, 512, "read")
  assert.deepEqual(calls[1], { kind: "histogram", name: "agent.tools.mcp_directory_response_bytes", value: 512, labels: { tool: "read" } })
})
