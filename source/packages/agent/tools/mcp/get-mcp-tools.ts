/**
 * The tool that tells the model what MCP tools exist, and what their schemas are.
 *
 * A model cannot call a tool it has not been told about, and the tools a session can reach change while
 * the session runs: a server connects late, an integration needs authenticating, a plugin adds a tool.
 * So this tool is the one place a schema is discovered from, and it is asked in five shapes — the whole
 * catalog, one server, one server's tool, a regex over names, and a regex scoped to one server — because
 * a catalog of every tool on every server is rarely what is wanted and often too large to read.
 *
 * What the model is shown is deliberately less than what the server said. Catalog and search results
 * carry truncated descriptions, since they are for finding a tool rather than using it; a server or
 * single-tool lookup carries the full description and the full input schema, because that is what a call
 * needs. The one exception is the platform's own reserved namespace, whose schemas are handed over
 * verbatim: they are ours, so nothing in them needs flattening.
 *
 * The live picture comes from the execution side, which knows which servers are connected and which need
 * authentication, and falls back to the descriptors captured when the turn started if that lookup fails —
 * a stale catalog is more useful than none. Authentication is a tool of its own inside a server, and how
 * it is presented depends on whether this environment can run it at all: when it can, the model is told
 * how to authenticate and retry; when it cannot, the model is told to ask the user instead of trying.
 *
 * A large answer is written to a file and the model is given its path, since a catalog can be far larger
 * than a message should be.
 */

import { RE2JS } from "re2js"
import { z } from "zod"

import type { Context } from "../../../context/context.ts"
import type { ResourceAccessor } from "../../../agent-exec/resource-provider.ts"
import type { RemoteExecManager } from "../../../agent-exec/executor-resources.ts"
import {
  DYNAMIC_TOOLS_NAMESPACE,
  mcpServerUnavailableReason,
  supportsInteractiveMcpAuth,
} from "../../../agent-exec/mcp-operations.ts"
import { writeExecutorResource } from "../../../agent-exec/write-operation.ts"
import { writeToAgentToolsFile } from "../../../../adapters/interop/agent/agent-tools-file-adapter.ts"
import { createStringResult } from "../../../chat-inference/prompt-executor.ts"
import { isProjectWorkspaceConversation } from "../../configs/project-workspace-mcp-tools.ts"
import { createZodAgentTool, CustomToolCallError, withSafeParsedArgs } from "../tool-support.ts"
import { ToolErrorClassification } from "../tool-errors.ts"
import { DynamicToolRegistry, isReservedDynamicToolsNamespace } from "./builtin-tools.ts"
import {
  createGetMcpToolsResultInterop,
  createGetMcpToolsToolCallInterop,
  loadMcpServerSnapshotsInterop,
  projectCapturedMcpServersInterop,
  projectGetMcpToolsResultInterop,
} from "../../../../adapters/interop/agent/get-mcp-tools-protocol-adapter.ts"
import type {
  GetMcpToolsRequestView,
  GetMcpToolsResultView,
  McpServerDescriptorView,
  McpToolDescriptorView,
} from "./get-mcp-tools-contracts.ts"
import {
  emitGetMcpToolsMetrics,
  GET_MCP_TOOLS_FAILURE_REASONS,
  reportMcpMetaToolFailure,
} from "../../utils/mcp-metrics.ts"

const DEFAULT_GET_MCP_TOOLS_NAME = "GetMcpTools"
const MCP_AUTH_TOOL_NAME = "mcp_auth"
const MAX_DESCRIPTION_LENGTH = 200
const TRUNCATED_DESCRIPTION_SUFFIX = "... [truncated]"
const CONTROL_CHARACTERS_REGEX = /[\u0000-\u001F\u007F]/g
const FILE_OUTPUT_THRESHOLD_BYTES = 12_000
const MAX_REGEX_PATTERN_LENGTH = 256
const MCP_AUTH_INPUT_SCHEMA = { type: "object", properties: {}, additionalProperties: false }
/** The server the platform's own workspace-changing tools live on; its identifier is the server's own toolName. */
const APP_CONTROL_MCP_SERVER = "cursor-app-control"
const WORKSPACE_MUTATION_TOOLS = new Set(["move_agent_to_root", "move_agent_to_cloned_root", "create_project"])

interface LoadedServer {
  readonly descriptor: McpServerDescriptorView
  readonly status?: string
  readonly hadMcpAuthBeforeFilter?: boolean
}

type GetMcpToolsRequest = GetMcpToolsRequestView

interface GetMcpToolsExecutionInfo {
  readonly toolCallId: string
  readonly stateHandler?: unknown
}

interface GetMcpToolsInteractionHandler {
  executeToolCall(
    ctx: Context,
    toolCall: unknown,
    callId: string,
    run: (ctx: Context) => Promise<unknown>,
    merge: (agentResult: unknown) => unknown,
  ): Promise<unknown>
}

export interface CreateGetMcpToolsToolOptions {
  readonly resourceAccessor?: ResourceAccessor<RemoteExecManager> | undefined
  readonly projectDir?: string | undefined
  readonly toolName?: string | undefined
  readonly callMcpToolName?: string | undefined
  readonly allowInteractiveMcpAuth?: boolean | undefined
  readonly dynamicToolRegistry?: DynamicToolRegistry | undefined
  readonly isMcpToolBlocked?: (input: { readonly serverIdentifier: string; readonly toolName: string }) => boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function looksLikeRequest(value: unknown): value is GetMcpToolsRequest {
  return isRecord(value) && (value.server === undefined || typeof value.server === "string") && (value.toolName === undefined || typeof value.toolName === "string") && (value.pattern === undefined || typeof value.pattern === "string")
}

function looksLikeWorkspaceState(value: unknown): value is Parameters<typeof isProjectWorkspaceConversation>[1] {
  return isRecord(value)
}

function looksLikeHandler(value: unknown): value is GetMcpToolsInteractionHandler {
  return isRecord(value) && typeof value.executeToolCall === "function"
}

/** A failure the model reads and the platform records, phrased the same way for both. */
function metaError(message: string, classification: ToolErrorClassification): CustomToolCallError {
  return new CustomToolCallError(classification, { error: message, clientVisibleErrorMessage: message, modelVisibleErrorMessage: message })
}

/** In a dynamic namespace the same body is described with namespace wording rather than server wording. */
function modelFacingServer(body: Record<string, unknown>, dynamic: boolean): Record<string, unknown> {
  if (!dynamic) return body
  return { namespace: body.server, namespaceStatus: body.serverStatus, namespaceError: body.serverError, namespaceDescription: body.serverDescription, tools: body.tools }
}

function modelFacingSearchRow(body: Record<string, unknown>, dynamic: boolean): Record<string, unknown> {
  if (!dynamic) return body
  return { namespace: body.server, tool: body.tool, description: body.description, namespaceStatus: body.serverStatus, namespaceError: body.serverError }
}

function modelFacingSingleTool(server: Record<string, unknown>, tool: Record<string, unknown>, dynamic: boolean): Record<string, unknown> {
  return dynamic
    ? { mode: "single_tool", namespace: server.server, namespaceStatus: server.serverStatus, namespaceDescription: server.serverDescription, tool }
    : { mode: "single_tool", server: server.server, serverStatus: server.serverStatus, serverDescription: server.serverDescription, tool }
}

/**
 * A server that cannot be authenticated in this environment loses its auth tool rather than the whole
 * server, and a server whose only tool was that one is reported as needing authentication.
 */
function fromCapturedServer(descriptor: McpServerDescriptorView, allowInteractiveMcpAuth: boolean): LoadedServer {
  const supportsAuth = supportsInteractiveMcpAuth(descriptor.serverIdentifier)
  if (allowInteractiveMcpAuth && supportsAuth) return { descriptor }
  const tools = descriptor.tools.filter(tool => tool.toolName !== MCP_AUTH_TOOL_NAME)
  if (tools.length === descriptor.tools.length) return { descriptor }
  return { descriptor: { ...descriptor, tools }, ...(supportsAuth && tools.length === 0 ? { status: "needsAuth" } : {}) }
}

/** The auth tool as the turn-start snapshot described it, which is all the live answer may be missing. */
function capturedAuthTool(descriptors: readonly McpServerDescriptorView[], serverIdentifier: string): McpToolDescriptorView | undefined {
  const tool = descriptors.find(descriptor => descriptor.serverIdentifier === serverIdentifier)?.tools.find(candidate => candidate.toolName === MCP_AUTH_TOOL_NAME)
  if (tool !== undefined && tool.description === undefined && tool.inputSchemaPresent !== true) return undefined
  return tool
}

/** Server text is flattened to one line and stripped of control characters before it reaches a prompt. */
function flattenText(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  const value = raw.replace(CONTROL_CHARACTERS_REGEX, " ").replace(/\s+/g, " ").trim()
  return value.length === 0 ? undefined : value
}

function flattenAndShorten(raw: string | undefined): string | undefined {
  const value = flattenText(raw)
  return value === undefined || value.length <= MAX_DESCRIPTION_LENGTH ? value : `${value.slice(0, MAX_DESCRIPTION_LENGTH - TRUNCATED_DESCRIPTION_SUFFIX.length)}${TRUNCATED_DESCRIPTION_SUFFIX}`
}

function toolPayloadFor(tool: McpToolDescriptorView, includeSchema: boolean, detail: "short" | "full" | "fullVerbatim"): Record<string, unknown> {
  const description = detail === "fullVerbatim" ? tool.description?.trim() || undefined : detail === "full" ? flattenText(tool.description) : flattenAndShorten(tool.description)
  const schema = includeSchema ? tool.inputSchema : undefined
  return { tool: tool.toolName, description, ...(includeSchema && schema !== undefined ? { inputSchema: schema } : {}) }
}

function toolPayloadsFor(tools: readonly McpToolDescriptorView[], includeSchema: boolean, detail: "short" | "full" | "fullVerbatim"): Record<string, unknown>[] {
  return [...tools].map(tool => toolPayloadFor(tool, includeSchema, detail)).sort((left, right) => String(left.tool).localeCompare(String(right.tool)))
}

/** A server whose only tool is authentication has not been authenticated yet. */
function statusForTools(descriptor: McpServerDescriptorView, allowInteractiveMcpAuth: boolean): string {
  const names = new Set(descriptor.tools.map(tool => tool.toolName))
  return !allowInteractiveMcpAuth && names.has(MCP_AUTH_TOOL_NAME) && names.size === 1 ? "needsAuth" : "ready"
}

function normalizedStatus(server: LoadedServer, allowInteractiveMcpAuth: boolean): string | undefined {
  // The platform's own namespace is always available, so it is not given a status to distrust.
  if (isReservedDynamicToolsNamespace(server.descriptor.serverIdentifier)) return undefined
  if (server.status === "connected") return "ready"
  if (server.status === undefined || server.status === "") return server.hadMcpAuthBeforeFilter ? "needsAuth" : statusForTools(server.descriptor, allowInteractiveMcpAuth)
  return server.status
}

function serverMetadataFor(server: LoadedServer, allowInteractiveMcpAuth: boolean, detail: "short" | "full" | "fullVerbatim" = "short"): Record<string, unknown> {
  const status = normalizedStatus(server, allowInteractiveMcpAuth)
  const raw = server.descriptor.serverUseInstructions
  const description = detail === "fullVerbatim" ? raw?.trim() || undefined : detail === "full" ? flattenText(raw) : flattenAndShorten(raw)
  return { server: server.descriptor.serverIdentifier, serverStatus: status, serverError: status === undefined ? undefined : mcpServerUnavailableReason(status), serverDescription: description }
}

function serverPayloadFor(server: LoadedServer, allowInteractiveMcpAuth: boolean, settings: { readonly includeSchema?: boolean; readonly trustedFirstParty?: boolean; readonly toolName?: string } = {}): Record<string, unknown> {
  const detail = settings.includeSchema === true ? settings.trustedFirstParty === true ? "fullVerbatim" : "full" : "short"
  const tools = settings.toolName === undefined ? server.descriptor.tools : server.descriptor.tools.filter(tool => tool.toolName === settings.toolName)
  return { ...serverMetadataFor(server, allowInteractiveMcpAuth, detail), tools: toolPayloadsFor(tools, settings.includeSchema === true, detail) }
}

/** The platform's own tools are one namespace in this list, listed once and never shadowed by a server. */
function withBuiltinServer(servers: readonly LoadedServer[], registry: DynamicToolRegistry | undefined): LoadedServer[] {
  if (registry === undefined) return [...servers]
  const withoutReserved = servers.filter(server => !isReservedDynamicToolsNamespace(server.descriptor.serverIdentifier))
  const slateDescriptor = registry.getMcpDescriptor()
  return slateDescriptor === undefined
    ? withoutReserved
    : [...withoutReserved, { descriptor: slateDescriptor }]
}

function success(text: string, outputFilePath: string | undefined = undefined): GetMcpToolsResultView {
  return { kind: "success", content: text, ...(outputFilePath === undefined ? {} : { outputFilePath }) }
}

function failure(error: string): GetMcpToolsResultView {
  return { kind: "error", error }
}

async function renderAgentResult(_ctx: Context, agentResult: unknown): Promise<{ content: Array<{ type: "text"; text: string }>; isError: boolean }> {
  const result = projectGetMcpToolsResultInterop(agentResult)
  if (result.kind === "success") return createStringResult(result.content)
  if (result.kind === "error") return createStringResult(`Error: ${result.error}`)
  return createStringResult("Unknown error")
}

/**
 * The live servers, asked of the execution side. A failure here is not a failure of the tool: the
 * descriptors captured at turn start are still a truthful, if older, answer.
 */
async function loadServers(ctx: Context, accessor: ResourceAccessor<RemoteExecManager> | undefined, capturedServers: readonly McpServerDescriptorView[], authAllowed: boolean, identifiers: readonly string[]): Promise<LoadedServer[]> {
  if (accessor === undefined) return capturedServers.map(descriptor => fromCapturedServer(descriptor, authAllowed))
  const liveServers = await loadMcpServerSnapshotsInterop(ctx, accessor, identifiers)
  if (liveServers !== undefined) return liveServers.map(server => {
    const supportsAuth = supportsInteractiveMcpAuth(server.serverIdentifier)
    const allowsAuth = authAllowed && supportsAuth
    const snapshotAuth = allowsAuth ? capturedAuthTool(capturedServers, server.serverIdentifier) : undefined
    let tools = [...server.tools]
    const hadAuth = tools.some(tool => tool.toolName === MCP_AUTH_TOOL_NAME)
    const hadOnlyAuth = hadAuth && tools.length === 1
    if (!allowsAuth) tools = tools.filter(tool => tool.toolName !== MCP_AUTH_TOOL_NAME)
    // An authenticatable server is always offered its auth tool, using the snapshot's wording when the
    // live answer has none, since the model has to know how to authenticate before it can call anything.
    if (allowsAuth && !tools.some(tool => tool.toolName === MCP_AUTH_TOOL_NAME)) {
      tools.push(snapshotAuth ?? {
        toolName: MCP_AUTH_TOOL_NAME,
        description: "Authenticate this MCP server so its tools can be used.",
        inputSchema: MCP_AUTH_INPUT_SCHEMA,
      })
    }
    const { status, ...descriptor } = server
    return {
      descriptor: { ...descriptor, tools },
      ...(status === undefined ? {} : { status }),
      ...(!authAllowed && supportsAuth && hadOnlyAuth ? { hadMcpAuthBeforeFilter: true } : {}),
    }
  })
  // A failed live lookup keeps the immutable fallback to the turn-start descriptor snapshot.
  return capturedServers.map(descriptor => fromCapturedServer(descriptor, authAllowed))
}

/** Moving the agent's workspace around is refused for a project workspace, whatever asked for it. */
function isWorkspaceMove(input: { readonly serverIdentifier: string; readonly toolName: string }): boolean {
  return input.serverIdentifier.toLowerCase() === APP_CONTROL_MCP_SERVER && WORKSPACE_MUTATION_TOOLS.has(input.toolName.toLowerCase())
}

function checkRequest(request: GetMcpToolsRequest, dynamic: boolean): void {
  if (request.toolName !== undefined && request.server === undefined) {
    const container = dynamic ? "namespace" : "server"
    throw metaError(`toolName requires ${container} to be set.`, ToolErrorClassification.INVALID_ARGS)
  }
  if (request.pattern !== undefined && request.pattern.length > MAX_REGEX_PATTERN_LENGTH) throw metaError(`pattern cannot exceed ${MAX_REGEX_PATTERN_LENGTH} characters.`, ToolErrorClassification.INVALID_ARGS)
}

/** Search runs on a linear-time engine, so a pattern a server toolName could not match cannot stall the turn. */
function compilePattern(pattern: string): { test(input: string): boolean } {
  try {
    const compiled = RE2JS.compile(pattern)
    return { test: input => compiled.matcher(input).find() }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw metaError(`Invalid regex pattern: ${message}`, ToolErrorClassification.INVALID_ARGS)
  }
}

function missingServerError(server: string, available: readonly string[], dynamic: boolean): CustomToolCallError {
  const container = dynamic ? "namespace" : "MCP server"
  const toolName = dynamic ? "namespaces" : "servers"
  // The available names are listed only when there are any, since an empty list reads as a bug.
  const message = available.length === 0 ? `${container} "${server}" not found.` : `${container} "${server}" not found. Available ${toolName}: ${available.join(", ")}`
  return metaError(message, ToolErrorClassification.UNEXPECTED_ENVIRONMENT)
}

/**
 * An answer too large for a message is written to the project's tools folder, and the model is given the
 * path with its size rather than the whole body.
 */
async function maybeWriteLargeOutput(ctx: Context, accessor: ResourceAccessor<RemoteExecManager> | undefined, projectDir: string | undefined, toolCallId: string, body: Record<string, unknown>): Promise<{ readonly result: GetMcpToolsResultView; readonly payloadBytes: number; readonly wroteToFile: boolean }> {
  const text = JSON.stringify(body, null, 2)
  const payloadBytes = Buffer.byteLength(text, "utf8")
  if (accessor !== undefined && projectDir !== undefined && payloadBytes > FILE_OUTPUT_THRESHOLD_BYTES) {
    const location = await writeToAgentToolsFile(ctx, accessor.get(writeExecutorResource), { content: text, projectDir, osPlatform: process.platform, toolCallId })
    if (location !== undefined) {
      const size = payloadBytes >= 1024 ? `${(payloadBytes / 1024).toFixed(1)} KB` : `${payloadBytes} bytes`
      return { result: success(JSON.stringify({ note: `Large output has been written to: ${location.filePath} (${size}, ${Number(location.lineCount)} lines)`, filePath: location.filePath }, null, 2), location.filePath), payloadBytes, wroteToFile: true }
    }
  }
  return { result: success(text), payloadBytes, wroteToFile: false }
}

export function createGetMcpToolsTool(mcpMetaToolOptions: unknown, settings: CreateGetMcpToolsToolOptions = {}): Record<string, unknown> {
  const dynamic = settings.dynamicToolRegistry !== undefined
  const toolName = settings.toolName ?? DEFAULT_GET_MCP_TOOLS_NAME
  const capturedServers = projectCapturedMcpServersInterop(mcpMetaToolOptions)
  const authAllowed = settings.allowInteractiveMcpAuth === true
  const serverShape = z.object({
    server: z.string().optional().describe("MCP server identifier to inspect."),
    toolName: z.string().optional().describe("Tool name within the server. Requires server to be set."),
    pattern: z.string().optional().describe(`RE2 regex pattern to search server and tool names (max ${MAX_REGEX_PATTERN_LENGTH} chars). Optionally combine with server to scope the search.`),
  })
  const namespaceShape = z.object({
    namespace: z.string().optional().describe("Dynamic namespace to inspect, e.g. an MCP server."),
    toolName: z.string().optional().describe("Tool name within the namespace. Requires namespace to be set."),
    pattern: z.string().optional().describe(`RE2 regex pattern to search namespace and tool names (max ${MAX_REGEX_PATTERN_LENGTH} chars). Optionally combine with namespace to scope the search.`),
  })
  const shapeForModel = dynamic ? namespaceShape : serverShape
  // The model is shown namespace wording but the rest of the tool speaks of servers, so the two names are
  // bridged once here rather than at every use.
  const parsedShape = z.preprocess(raw => {
    if (!dynamic || !isRecord(raw)) return raw
    return { ...raw, server: raw.namespace }
  }, z.object({ server: z.string().optional(), toolName: z.string().optional(), pattern: z.string().optional() }))
  const runTool = async (parentContext: Context, handler: unknown, rawRequest: unknown, executionMeta: GetMcpToolsExecutionInfo): Promise<unknown> => {
    if (!looksLikeHandler(handler) || !looksLikeRequest(rawRequest)) throw new Error("GetMcpTools execution requires valid arguments and an interaction handler")
    const request = rawRequest
    const startedAtMs = Date.now()
    const mode = request.toolName !== undefined ? "tool_detail" : request.pattern !== undefined ? "search" : request.server === undefined ? "catalog" : "server_detail"
    const reportOk = (ctx: Context, agentResult: GetMcpToolsResultView, measure: { readonly resultCount: number; readonly payloadBytes: number; readonly wroteToFile: boolean }): void => {
      emitGetMcpToolsMetrics(ctx, { mode, durationMs: Date.now() - startedAtMs, success: true, resultCount: measure.resultCount, responseBytes: agentResult.kind === "success" ? Buffer.byteLength(agentResult.content, "utf8") : 0, payloadBytes: measure.payloadBytes, wroteToFile: measure.wroteToFile })
    }
    const reportFailure = (ctx: Context, reason: string, error?: unknown): void => {
      const durationMs = Date.now() - startedAtMs
      emitGetMcpToolsMetrics(ctx, { mode, durationMs, success: false, failureReason: reason })
      if (error !== undefined) reportMcpMetaToolFailure(ctx, error, { tool: toolName, failureReason: reason, retryable: false, mode, durationMs })
    }
    try {
      // A malformed request is refused before anything is asked of the execution side.
      try { checkRequest(request, dynamic); } catch (error) { reportFailure(parentContext, GET_MCP_TOOLS_FAILURE_REASONS.INVALID_ARGS, error); throw error }
      const baseCall = createGetMcpToolsToolCallInterop(executionMeta.toolCallId, request)
      const result = await handler.executeToolCall(parentContext, baseCall, executionMeta.toolCallId, async ctx => {
        const workspaceRestricted = looksLikeWorkspaceState(executionMeta.stateHandler) ? await isProjectWorkspaceConversation(ctx, executionMeta.stateHandler) : false
        const isToolBlocked = (input: { readonly serverIdentifier: string; readonly toolName: string }) => settings.isMcpToolBlocked?.(input) === true || workspaceRestricted && isWorkspaceMove(input)
        const wantsBuiltin = request.server !== undefined && settings.dynamicToolRegistry !== undefined && isReservedDynamicToolsNamespace(request.server)
        const loadedServers = wantsBuiltin ? [] : await loadServers(ctx, settings.resourceAccessor, capturedServers, authAllowed, request.server === undefined ? [] : [request.server])
        const servers = loadedServers.map(server => {
          const filtered = server.descriptor.tools.filter(tool => !isToolBlocked({ serverIdentifier: server.descriptor.serverIdentifier, toolName: tool.toolName }))
          return filtered.length === server.descriptor.tools.length ? server : { ...server, descriptor: { ...server.descriptor, tools: filtered } }
        })
        const allServers = withBuiltinServer(servers, settings.dynamicToolRegistry)
        if (request.pattern !== undefined && request.toolName === undefined) {
          let regex: { test(input: string): boolean }
          try { regex = compilePattern(request.pattern) } catch (error) { reportFailure(ctx, GET_MCP_TOOLS_FAILURE_REASONS.INVALID_REGEX, error); throw error }
          let searchServers = allServers
          if (request.server !== undefined) {
            const chosen = allServers.find(server => server.descriptor.serverIdentifier === request.server)
            if (chosen === undefined) {
              const error = missingServerError(request.server, allServers.map(server => server.descriptor.serverIdentifier).sort(), dynamic)
              reportFailure(ctx, GET_MCP_TOOLS_FAILURE_REASONS.SERVER_NOT_FOUND, error); throw error
            }
            searchServers = [chosen]
          }
          const rows: Record<string, unknown>[] = []
          for (const server of searchServers) {
            const serverFacts = serverMetadataFor(server, authAllowed)
            // A server whose own toolName rows is listed once, and every tool under it counts as a match.
            const serverNameMatches = regex.test(server.descriptor.serverIdentifier)
            const tools = server.descriptor.tools.filter(tool => serverNameMatches || regex.test(tool.toolName))
            if (serverNameMatches) rows.push({ server: serverFacts.server, description: serverFacts.serverDescription, serverStatus: serverFacts.serverStatus, serverError: serverFacts.serverError })
            for (const tool of tools) {
              const matchRow: Record<string, unknown> = { server: server.descriptor.serverIdentifier, tool: tool.toolName, description: flattenAndShorten(tool.description) }
              // A tool matchRow repeats its server's status only when the server itself was not already listed.
              if (serverFacts.serverStatus !== undefined && serverFacts.serverStatus !== "ready" && !serverNameMatches) { matchRow.serverStatus = serverFacts.serverStatus; matchRow.serverError = serverFacts.serverError }
              rows.push(matchRow)
            }
          }
          rows.sort((left, right) => left.server === right.server ? String(left.tool ?? "").localeCompare(String(right.tool ?? "")) : String(left.server).localeCompare(String(right.server)))
          const output = await maybeWriteLargeOutput(ctx, settings.resourceAccessor, settings.projectDir, executionMeta.toolCallId, { mode: "search", pattern: request.pattern, matches: rows.map(match => modelFacingSearchRow(match, dynamic)) })
          reportOk(ctx, output.result, { resultCount: rows.length, payloadBytes: output.payloadBytes, wroteToFile: output.wroteToFile })
          return output.result
        }
        if (request.server === undefined) {
          const bodies = [...allServers].sort((left, right) => left.descriptor.serverIdentifier.localeCompare(right.descriptor.serverIdentifier)).map(server => serverPayloadFor(server, authAllowed))
          const toolCount = bodies.reduce((total, body) => total + (Array.isArray(body.tools) ? body.tools.length : 0), 0)
          const body = dynamic ? { mode: "catalog", namespaces: bodies.map(value => modelFacingServer(value, true)) } : { mode: "catalog", servers: bodies }
          const output = await maybeWriteLargeOutput(ctx, settings.resourceAccessor, settings.projectDir, executionMeta.toolCallId, body)
          reportOk(ctx, output.result, { resultCount: toolCount, payloadBytes: output.payloadBytes, wroteToFile: output.wroteToFile })
          return output.result
        }
        const server = allServers.find(candidate => candidate.descriptor.serverIdentifier === request.server)
        if (server === undefined) {
          const error = missingServerError(request.server, allServers.map(candidate => candidate.descriptor.serverIdentifier).sort(), dynamic)
          reportFailure(ctx, GET_MCP_TOOLS_FAILURE_REASONS.SERVER_NOT_FOUND, error); throw error
        }
        const body = serverPayloadFor(server, authAllowed, { includeSchema: true, trustedFirstParty: settings.dynamicToolRegistry !== undefined && isReservedDynamicToolsNamespace(request.server), ...(request.toolName === undefined ? {} : { toolName: request.toolName }) })
        if (request.toolName === undefined) {
          const serverOutput = dynamic ? { mode: "namespace", ...modelFacingServer(body, true) } : { mode: "server", ...body }
          const output = await maybeWriteLargeOutput(ctx, settings.resourceAccessor, settings.projectDir, executionMeta.toolCallId, serverOutput)
          reportOk(ctx, output.result, { resultCount: Array.isArray(body.tools) ? body.tools.length : 0, payloadBytes: output.payloadBytes, wroteToFile: output.wroteToFile })
          return output.result
        }
        const tool = Array.isArray(body.tools) ? body.tools.find(candidate => candidate.tool === request.toolName) : undefined
        if (tool === undefined) {
          const status = typeof body.serverStatus === "string" ? body.serverStatus : undefined
          // A server that is not usable explains itself, so the model is told why rather than only that the
          // tool is missing.
          if (status !== undefined && status !== "ready") {
            const message = typeof body.serverError === "string" ? body.serverError : `${dynamic ? "Namespace" : "MCP server"} "${request.server}" is ${status}.`
            const error = metaError(message, ToolErrorClassification.UNEXPECTED_ENVIRONMENT)
            reportFailure(ctx, GET_MCP_TOOLS_FAILURE_REASONS.TOOL_NOT_FOUND, error); throw error
          }
          // A tool the model could call directly is not part of a namespace, and saying so saves a retry.
          if (dynamic && isReservedDynamicToolsNamespace(request.server) && settings.dynamicToolRegistry?.usesDirectToolRecovery() === true && settings.dynamicToolRegistry.isStaticTool(request.toolName) === true) {
            const message = `Tool "${request.toolName}" is already available directly and is not part of dynamic namespace "${request.server}". Invoke "${request.toolName}" directly instead of using dynamic tool discovery or invocation.`
            const error = metaError(message, ToolErrorClassification.UNEXPECTED_ENVIRONMENT)
            reportFailure(ctx, GET_MCP_TOOLS_FAILURE_REASONS.TOOL_NOT_FOUND, error); throw error
          }
          const message = dynamic ? `Tool "${request.toolName}" not found in namespace "${request.server}".` : `MCP tool "${request.toolName}" not found on server "${request.server}".`
          const error = metaError(message, ToolErrorClassification.UNEXPECTED_ENVIRONMENT)
          reportFailure(ctx, GET_MCP_TOOLS_FAILURE_REASONS.TOOL_NOT_FOUND, error); throw error
        }
        const text = JSON.stringify(modelFacingSingleTool(body, tool, dynamic), null, 2)
        const agentResult = success(text)
        reportOk(ctx, agentResult, { resultCount: 1, payloadBytes: Buffer.byteLength(text, "utf8"), wroteToFile: false })
        return agentResult
      }, agentResult => createGetMcpToolsToolCallInterop(executionMeta.toolCallId, request, agentResult as GetMcpToolsResultView))
      return createGetMcpToolsResultInterop(result as GetMcpToolsResultView)
    } catch (error) {
      throw error
    }
  }
  return createZodAgentTool("GET_MCP_TOOLS", {
    name: toolName,
    dynamicToolMetaRole: "discovery",
    descriptionGenerator: (props: Record<string, unknown>) => {
      const allTools = props.allTools
      const callName = settings.callMcpToolName ?? (isRecord(allTools) && isRecord(allTools.MCP) && typeof allTools.MCP.name === "string" ? allTools.MCP.name : "CallMcpTool")
      // How authentication is presented depends on whether this environment can run the auth tool at all.
      const authLines = authAllowed
        ? ["", dynamic ? `MCP authentication: If an MCP-backed namespace has namespaceStatus "needsAuth", or its tool call fails with an authentication/authorization error, authenticate it by calling ${MCP_AUTH_TOOL_NAME} through ${callName} with empty arguments. Then inspect that namespace again and retry if appropriate.` : `MCP authentication: If a relevant server has serverStatus "needsAuth", or if an MCP tool call fails with an authentication/authorization error, authenticate it by calling ${MCP_AUTH_TOOL_NAME} (via ${callName}, with empty arguments), then inspect that server again and retry the original request if appropriate. Do not call ${MCP_AUTH_TOOL_NAME} just because it is listed, and do not repeatedly call it if authentication did not fix the failure.`]
        : ["", dynamic ? `MCP authentication: If an MCP-backed namespace has namespaceStatus "needsAuth", its tools are unavailable until that MCP integration is authenticated in the Slate desktop IDE.` : `MCP authentication: If a server has serverStatus "needsAuth", its tools are not usable in this environment. Ask the user to authenticate that MCP server in the Slate desktop IDE, then retry.`]
      const builtinLines = dynamic && settings.dynamicToolRegistry !== undefined && !settings.dynamicToolRegistry.isEmpty()
        ? ["", `First-party Slate tools: the reserved namespace "${DYNAMIC_TOOLS_NAMESPACE}" lists built-in Slate tools available on demand (${settings.dynamicToolRegistry.getToolNames().join(", ")}). Discover their schemas here, then invoke them via ${callName}; they run natively with their own approvals and rendering.`]
        : []
      const description = dynamic
        ? [
          "Discover and inspect tools available through dynamic namespaces, e.g. MCP servers.", "",
          '{"namespace":"<id>"}: returns full input schemas and full descriptions for every tool in that namespace.',
          '{"namespace":"<id>","toolName":"<name>"}: returns the full schema and full description for one tool.',
          '{"pattern":"<regex>"}: searches namespace and tool names across all namespaces using RE2 syntax.',
          '{"namespace":"<id>","pattern":"<regex>"}: searches tool names within that namespace.',
          "No arguments: returns the full catalog. Prefer a namespace or pattern when possible.", "",
          `Pattern-search and catalog results shorten long descriptions to 200 characters, ending with "${TRUNCATED_DESCRIPTION_SUFFIX}". Namespace and single-tool lookups always return the complete description, so fetch the tool directly when you need the full text.`,
          'The response includes namespaceStatus for MCP-backed namespaces; do not treat namespaces in "needsAuth", "error", or "loading" states as usable.',
          `Always call this tool to discover a tool's schema before calling it with ${callName}.`, ...builtinLines, ...authLines,
        ]
        : [
          "Discover and inspect MCP tools. There are 5 ways to call this tool. Prefer fetching by server or pattern over listing the full catalog.", "",
          '{"server":"<id>"}: returns full input schemas and full descriptions for every tool on that server. Preferred when you know the server.',
          '{"server":"<id>","toolName":"<name>"}: returns the full schema and full description for one tool.',
          '{"pattern":"<regex>"}: searches tool and server names across all servers using RE2 syntax.',
          '{"server":"<id>","pattern":"<regex>"}: searches tool names on that server using RE2 syntax.',
          "No arguments: returns a catalog of all servers with tool names and short descriptions. Use only as a last resort.", "",
          `Pattern-search and catalog results shorten long descriptions to 200 characters, ending with "${TRUNCATED_DESCRIPTION_SUFFIX}". Server and single-tool lookups always return the complete description, so fetch the tool directly when you need the full text.`,
          `The response includes each server's serverStatus; do not treat servers in "needsAuth", "error", or "loading" states as usable.`,
          `Always call this tool to discover a tool's schema before calling it with ${callName}.`, ...builtinLines, ...authLines,
        ]
      return description.join("\n")
    },
    parameters: shapeForModel,
    render: renderAgentResult,
    execute: withSafeParsedArgs(parsedShape, runTool, createGetMcpToolsToolCallInterop("unknown-tool-call-id", {}, failure("Invalid arguments"))),
    serializeError: error => createGetMcpToolsToolCallInterop("unknown-tool-call-id", {}, failure(error instanceof Error ? error.message : String(error))),
  })
}
