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

import { Value } from "@bufbuild/protobuf"
import { RE2JS } from "re2js"
import { z } from "zod"

import type { Context } from "../../../context/context.ts"
import type { ResourceAccessor } from "../../../agent-exec/resource-provider.ts"
import type { RemoteExecManager } from "../../../agent-exec/executor-resources.ts"
import {
  DYNAMIC_TOOLS_NAMESPACE,
  mcpInputSchemaToJson,
  mcpServerUnavailableReason,
  mcpStateExecutorResource,
  supportsInteractiveMcpAuth,
} from "../../../agent-exec/mcp-operations.ts"
import { writeExecutorResource } from "../../../agent-exec/write-operation.ts"
import { writeToAgentToolsFile } from "../../../agent-exec/agent-tools-file.ts"
import { createStringResult } from "../../../chat-inference/prompt-executor.ts"
import { isProjectWorkspaceConversation } from "../../configs/project-workspace-mcp-tools.ts"
import { createZodAgentTool, CustomToolCallError, withSafeParsedArgs } from "../tool-support.ts"
import { ToolErrorClassification } from "../tool-errors.ts"
import { DynamicToolRegistry, isReservedDynamicToolsNamespace } from "./builtin-tools.ts"
import { createMcpToolCall } from "./mcp-result-boundary.ts"
import {
  emitGetMcpToolsMetrics,
  GET_MCP_TOOLS_FAILURE_REASONS,
  reportMcpMetaToolFailure,
} from "../../utils/mcp-metrics.ts"
import { McpStateExecArgs } from "../../../proto/generated/agent/v1/mcp_exec_pb.ts"
import { McpDescriptor, McpToolDescriptor, type McpMetaToolOptions } from "../../../proto/generated/agent/v1/mcp_pb.ts"
import {
  GetMcpToolsAgentResult,
  GetMcpToolsArgs,
  GetMcpToolsError,
  GetMcpToolsSuccess,
  GetMcpToolsToolCall,
} from "../../../proto/generated/agent/v1/get_mcp_tools_tool_pb.ts"
import { ToolCall } from "../../../proto/generated/agent/v1/agent_pb.ts"

const DEFAULT_GET_MCP_TOOLS_NAME = "GetMcpTools"
const MCP_AUTH_TOOL_NAME = "mcp_auth"
const MAX_DESCRIPTION_LENGTH = 200
const TRUNCATED_DESCRIPTION_SUFFIX = "... [truncated]"
const CONTROL_CHARACTERS_REGEX = /[\u0000-\u001F\u007F]/g
const FILE_OUTPUT_THRESHOLD_BYTES = 12_000
const MAX_REGEX_PATTERN_LENGTH = 256
const MCP_AUTH_INPUT_SCHEMA = { type: "object", properties: {}, additionalProperties: false }
/** The server the platform's own workspace-changing tools live on; its identifier is the server's own name. */
const APP_CONTROL_MCP_SERVER = "cursor-app-control"
const WORKSPACE_MUTATION_TOOLS = new Set(["move_agent_to_root", "move_agent_to_cloned_root", "create_project"])

interface ResolvedServer {
  readonly descriptor: McpDescriptor
  readonly status?: string
  readonly hadMcpAuthBeforeFilter?: boolean
}

interface GetMcpToolsArgsInput {
  readonly server?: string | undefined
  readonly toolName?: string | undefined
  readonly pattern?: string | undefined
}

interface GetMcpToolsExecutionMeta {
  readonly toolCallId: string
  readonly stateHandler?: unknown
}

interface GetMcpToolsInteractionHandler {
  executeToolCall(
    ctx: Context,
    toolCall: ToolCall,
    callId: string,
    run: (ctx: Context) => Promise<GetMcpToolsAgentResult>,
    merge: (result: GetMcpToolsAgentResult) => ToolCall,
  ): Promise<GetMcpToolsAgentResult>
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

function isGetMcpToolsArgs(value: unknown): value is GetMcpToolsArgsInput {
  return isRecord(value) && (value.server === undefined || typeof value.server === "string") && (value.toolName === undefined || typeof value.toolName === "string") && (value.pattern === undefined || typeof value.pattern === "string")
}

function isProjectWorkspaceState(value: unknown): value is Parameters<typeof isProjectWorkspaceConversation>[1] {
  return isRecord(value)
}

function isGetMcpToolsInteractionHandler(value: unknown): value is GetMcpToolsInteractionHandler {
  return isRecord(value) && typeof value.executeToolCall === "function"
}

/** A failure the model reads and the platform records, phrased the same way for both. */
function metaError(message: string, classification: ToolErrorClassification): CustomToolCallError {
  return new CustomToolCallError(classification, { error: message, clientVisibleErrorMessage: message, modelVisibleErrorMessage: message })
}

/** In a dynamic namespace the same payload is described with namespace wording rather than server wording. */
function toModelFacingServerPayload(payload: Record<string, unknown>, dynamic: boolean): Record<string, unknown> {
  if (!dynamic) return payload
  return { namespace: payload.server, namespaceStatus: payload.serverStatus, namespaceError: payload.serverError, namespaceDescription: payload.serverDescription, tools: payload.tools }
}

function toModelFacingSearchResult(payload: Record<string, unknown>, dynamic: boolean): Record<string, unknown> {
  if (!dynamic) return payload
  return { namespace: payload.server, tool: payload.tool, description: payload.description, namespaceStatus: payload.serverStatus, namespaceError: payload.serverError }
}

function toModelFacingSingleToolPayload(server: Record<string, unknown>, tool: Record<string, unknown>, dynamic: boolean): Record<string, unknown> {
  return dynamic
    ? { mode: "single_tool", namespace: server.server, namespaceStatus: server.serverStatus, namespaceDescription: server.serverDescription, tool }
    : { mode: "single_tool", server: server.server, serverStatus: server.serverStatus, serverDescription: server.serverDescription, tool }
}

/**
 * A server that cannot be authenticated in this environment loses its auth tool rather than the whole
 * server, and a server whose only tool was that one is reported as needing authentication.
 */
function resolvedServerFromSnapshot(descriptor: McpDescriptor, allowInteractiveMcpAuth: boolean): ResolvedServer {
  const supportsAuth = supportsInteractiveMcpAuth(descriptor.serverIdentifier)
  if (allowInteractiveMcpAuth && supportsAuth) return { descriptor }
  const tools = descriptor.tools.filter(tool => tool.toolName !== MCP_AUTH_TOOL_NAME)
  if (tools.length === descriptor.tools.length) return { descriptor }
  return { descriptor: new McpDescriptor({ ...descriptor, tools }), ...(supportsAuth && tools.length === 0 ? { status: "needsAuth" } : {}) }
}

/** The auth tool as the turn-start snapshot described it, which is all the live answer may be missing. */
function getSnapshotMcpAuthTool(descriptors: readonly McpDescriptor[], serverIdentifier: string): McpToolDescriptor | undefined {
  const tool = descriptors.find(descriptor => descriptor.serverIdentifier === serverIdentifier)?.tools.find(candidate => candidate.toolName === MCP_AUTH_TOOL_NAME)
  if (tool !== undefined && tool.description === undefined && tool.inputSchema === undefined && tool.inputSchemaJson === undefined) return undefined
  return tool
}

/** Server text is flattened to one line and stripped of control characters before it reaches a prompt. */
function sanitizeDescription(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  const value = raw.replace(CONTROL_CHARACTERS_REGEX, " ").replace(/\s+/g, " ").trim()
  return value.length === 0 ? undefined : value
}

function sanitizeAndTruncateDescription(raw: string | undefined): string | undefined {
  const value = sanitizeDescription(raw)
  return value === undefined || value.length <= MAX_DESCRIPTION_LENGTH ? value : `${value.slice(0, MAX_DESCRIPTION_LENGTH - TRUNCATED_DESCRIPTION_SUFFIX.length)}${TRUNCATED_DESCRIPTION_SUFFIX}`
}

function descriptorToToolPayload(tool: McpToolDescriptor, includeSchema: boolean, detail: "short" | "full" | "fullVerbatim"): Record<string, unknown> {
  const description = detail === "fullVerbatim" ? tool.description?.trim() || undefined : detail === "full" ? sanitizeDescription(tool.description) : sanitizeAndTruncateDescription(tool.description)
  const schema = includeSchema ? mcpInputSchemaToJson(tool) : undefined
  return { tool: tool.toolName, description, ...(includeSchema && schema !== undefined ? { inputSchema: schema } : {}) }
}

function descriptorsToToolPayloads(tools: readonly McpToolDescriptor[], includeSchema: boolean, detail: "short" | "full" | "fullVerbatim"): Record<string, unknown>[] {
  return [...tools].map(tool => descriptorToToolPayload(tool, includeSchema, detail)).sort((left, right) => String(left.tool).localeCompare(String(right.tool)))
}

/** A server whose only tool is authentication has not been authenticated yet. */
function statusFromDescriptor(descriptor: McpDescriptor, allowInteractiveMcpAuth: boolean): string {
  const names = new Set(descriptor.tools.map(tool => tool.toolName))
  return !allowInteractiveMcpAuth && names.has(MCP_AUTH_TOOL_NAME) && names.size === 1 ? "needsAuth" : "ready"
}

function normalizeServerStatus(server: ResolvedServer, allowInteractiveMcpAuth: boolean): string | undefined {
  // The platform's own namespace is always available, so it is not given a status to distrust.
  if (isReservedDynamicToolsNamespace(server.descriptor.serverIdentifier)) return undefined
  if (server.status === "connected") return "ready"
  if (server.status === undefined || server.status === "") return server.hadMcpAuthBeforeFilter ? "needsAuth" : statusFromDescriptor(server.descriptor, allowInteractiveMcpAuth)
  return server.status
}

function descriptorToServerMetadata(server: ResolvedServer, allowInteractiveMcpAuth: boolean, detail: "short" | "full" | "fullVerbatim" = "short"): Record<string, unknown> {
  const status = normalizeServerStatus(server, allowInteractiveMcpAuth)
  const raw = server.descriptor.serverUseInstructions
  const description = detail === "fullVerbatim" ? raw?.trim() || undefined : detail === "full" ? sanitizeDescription(raw) : sanitizeAndTruncateDescription(raw)
  return { server: server.descriptor.serverIdentifier, serverStatus: status, serverError: status === undefined ? undefined : mcpServerUnavailableReason(status), serverDescription: description }
}

function descriptorToServerPayload(server: ResolvedServer, allowInteractiveMcpAuth: boolean, options: { readonly includeSchema?: boolean; readonly trustedFirstParty?: boolean; readonly toolName?: string } = {}): Record<string, unknown> {
  const detail = options.includeSchema === true ? options.trustedFirstParty === true ? "fullVerbatim" : "full" : "short"
  const tools = options.toolName === undefined ? server.descriptor.tools : server.descriptor.tools.filter(tool => tool.toolName === options.toolName)
  return { ...descriptorToServerMetadata(server, allowInteractiveMcpAuth, detail), tools: descriptorsToToolPayloads(tools, options.includeSchema === true, detail) }
}

/** The platform's own tools are one namespace in this list, listed once and never shadowed by a server. */
function mergeBuiltinToolsServer(servers: readonly ResolvedServer[], registry: DynamicToolRegistry | undefined): ResolvedServer[] {
  if (registry === undefined) return [...servers]
  const withoutReserved = servers.filter(server => !isReservedDynamicToolsNamespace(server.descriptor.serverIdentifier))
  const descriptor = registry.getMcpDescriptor()
  return descriptor === undefined ? withoutReserved : [...withoutReserved, { descriptor }]
}

function createToolCall(args: GetMcpToolsArgs, result: GetMcpToolsAgentResult | undefined = undefined): ToolCall {
  return new ToolCall({ tool: { case: "getMcpToolsToolCall", value: new GetMcpToolsToolCall({ args, ...(result === undefined ? {} : { result }) }) } })
}

function createArgs(toolCallId: string, args: GetMcpToolsArgsInput): GetMcpToolsArgs {
  return new GetMcpToolsArgs({ ...(args.server === undefined ? {} : { server: args.server }), ...(args.toolName === undefined ? {} : { toolName: args.toolName }), ...(args.pattern === undefined ? {} : { pattern: args.pattern }), toolCallId })
}

function success(content: string, outputFilePath: string | undefined = undefined): GetMcpToolsAgentResult {
  return new GetMcpToolsAgentResult({ result: { case: "success", value: new GetMcpToolsSuccess({ content, ...(outputFilePath === undefined ? {} : { outputFilePath }) }) } })
}

function failure(error: string): GetMcpToolsAgentResult {
  return new GetMcpToolsAgentResult({ result: { case: "error", value: new GetMcpToolsError({ error }) } })
}

async function renderResult(_ctx: Context, result: GetMcpToolsAgentResult): Promise<{ content: Array<{ type: "text"; text: string }>; isError: boolean }> {
  if (result.result.case === "success") return createStringResult(result.result.value.content)
  if (result.result.case === "error") return createStringResult(`Error: ${result.result.value.error}`)
  return createStringResult("Unknown error")
}

/**
 * The live servers, asked of the execution side. A failure here is not a failure of the tool: the
 * descriptors captured at turn start are still a truthful, if older, answer.
 */
async function resolveServers(ctx: Context, accessor: ResourceAccessor<RemoteExecManager> | undefined, snapshots: readonly McpDescriptor[], allowAuth: boolean, identifiers: readonly string[]): Promise<ResolvedServer[]> {
  if (accessor === undefined) return snapshots.map(descriptor => resolvedServerFromSnapshot(descriptor, allowAuth))
  try {
    const result = await accessor.get(mcpStateExecutorResource).execute(ctx, new McpStateExecArgs({ serverIdentifiers: [...identifiers] }))
    if (result.result.case === "success") return result.result.value.servers.map(server => {
      const supportsAuth = supportsInteractiveMcpAuth(server.serverIdentifier)
      const allowsAuth = allowAuth && supportsAuth
      const snapshotAuth = allowsAuth ? getSnapshotMcpAuthTool(snapshots, server.serverIdentifier) : undefined
      const instructions = server.instructions.map(item => item.instructions).filter(Boolean).join("\n")
      let tools = server.tools.map(tool => new McpToolDescriptor({ toolName: tool.toolName, ...(tool.description === undefined ? {} : { description: tool.description }), ...(tool.inputSchema === undefined ? {} : { inputSchema: tool.inputSchema }), ...(tool.inputSchemaJson === undefined ? {} : { inputSchemaJson: tool.inputSchemaJson }) }))
      const hadAuth = tools.some(tool => tool.toolName === MCP_AUTH_TOOL_NAME)
      const hadOnlyAuth = hadAuth && tools.length === 1
      if (!allowsAuth) tools = tools.filter(tool => tool.toolName !== MCP_AUTH_TOOL_NAME)
      // An authenticatable server is always offered its auth tool, using the snapshot's wording when the
      // live answer has none, since the model has to know how to authenticate before it can call anything.
      if (allowsAuth && !tools.some(tool => tool.toolName === MCP_AUTH_TOOL_NAME)) tools.push(snapshotAuth ?? new McpToolDescriptor({ toolName: MCP_AUTH_TOOL_NAME, description: "Authenticate this MCP server so its tools can be used.", inputSchema: Value.fromJson(MCP_AUTH_INPUT_SCHEMA) }))
      return {
        descriptor: new McpDescriptor({ serverIdentifier: server.serverIdentifier, serverName: server.serverName, ...(server.plugin === undefined ? {} : { plugin: server.plugin }), ...(server.marketplace === undefined ? {} : { marketplace: server.marketplace }), ...(instructions.length === 0 ? {} : { serverUseInstructions: instructions }), tools }),
        ...(server.status === undefined ? {} : { status: server.status }),
        ...(!allowAuth && supportsAuth && hadOnlyAuth ? { hadMcpAuthBeforeFilter: true } : {}),
      }
    })
  } catch {
    // Retain the immutable fallback to the turn-start descriptor snapshot.
  }
  return snapshots.map(descriptor => resolvedServerFromSnapshot(descriptor, allowAuth))
}

/** Moving the agent's workspace around is refused for a project workspace, whatever asked for it. */
function isWorkspaceMutation(input: { readonly serverIdentifier: string; readonly toolName: string }): boolean {
  return input.serverIdentifier.toLowerCase() === APP_CONTROL_MCP_SERVER && WORKSPACE_MUTATION_TOOLS.has(input.toolName.toLowerCase())
}

function validateArgs(args: GetMcpToolsArgsInput, dynamic: boolean): void {
  if (args.toolName !== undefined && args.server === undefined) {
    const container = dynamic ? "namespace" : "server"
    throw metaError(`toolName requires ${container} to be set.`, ToolErrorClassification.INVALID_ARGS)
  }
  if (args.pattern !== undefined && args.pattern.length > MAX_REGEX_PATTERN_LENGTH) throw metaError(`pattern cannot exceed ${MAX_REGEX_PATTERN_LENGTH} characters.`, ToolErrorClassification.INVALID_ARGS)
}

/** Search runs on a linear-time engine, so a pattern a server name could not match cannot stall the turn. */
function compileSearchRegex(pattern: string): { test(input: string): boolean } {
  try {
    const compiled = RE2JS.compile(pattern)
    return { test: input => compiled.matcher(input).find() }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw metaError(`Invalid regex pattern: ${message}`, ToolErrorClassification.INVALID_ARGS)
  }
}

function serverNotFoundError(server: string, available: readonly string[], dynamic: boolean): CustomToolCallError {
  const container = dynamic ? "namespace" : "MCP server"
  const name = dynamic ? "namespaces" : "servers"
  // The available names are listed only when there are any, since an empty list reads as a bug.
  const message = available.length === 0 ? `${container} "${server}" not found.` : `${container} "${server}" not found. Available ${name}: ${available.join(", ")}`
  return metaError(message, ToolErrorClassification.UNEXPECTED_ENVIRONMENT)
}

/**
 * An answer too large for a message is written to the project's tools folder, and the model is given the
 * path with its size rather than the whole payload.
 */
async function maybeWriteToFile(ctx: Context, accessor: ResourceAccessor<RemoteExecManager> | undefined, projectDir: string | undefined, toolCallId: string, payload: Record<string, unknown>): Promise<{ readonly result: GetMcpToolsAgentResult; readonly payloadBytes: number; readonly wroteToFile: boolean }> {
  const text = JSON.stringify(payload, null, 2)
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

export function createGetMcpToolsTool(mcpMetaToolOptions: McpMetaToolOptions, options: CreateGetMcpToolsToolOptions = {}): Record<string, unknown> {
  const dynamic = options.dynamicToolRegistry !== undefined
  const name = options.toolName ?? DEFAULT_GET_MCP_TOOLS_NAME
  const snapshots = mcpMetaToolOptions.mcpDescriptors
  const allowAuth = options.allowInteractiveMcpAuth === true
  const serverParameters = z.object({
    server: z.string().optional().describe("MCP server identifier to inspect."),
    toolName: z.string().optional().describe("Tool name within the server. Requires server to be set."),
    pattern: z.string().optional().describe(`RE2 regex pattern to search server and tool names (max ${MAX_REGEX_PATTERN_LENGTH} chars). Optionally combine with server to scope the search.`),
  })
  const namespaceParameters = z.object({
    namespace: z.string().optional().describe("Dynamic namespace to inspect, e.g. an MCP server."),
    toolName: z.string().optional().describe("Tool name within the namespace. Requires namespace to be set."),
    pattern: z.string().optional().describe(`RE2 regex pattern to search namespace and tool names (max ${MAX_REGEX_PATTERN_LENGTH} chars). Optionally combine with namespace to scope the search.`),
  })
  const modelParameters = dynamic ? namespaceParameters : serverParameters
  // The model is shown namespace wording but the rest of the tool speaks of servers, so the two names are
  // bridged once here rather than at every use.
  const parsingParameters = z.preprocess(raw => {
    if (!dynamic || !isRecord(raw)) return raw
    return { ...raw, server: raw.namespace }
  }, z.object({ server: z.string().optional(), toolName: z.string().optional(), pattern: z.string().optional() }))
  const execute = async (parentCtx: Context, interactionHandler: unknown, rawArgs: unknown, meta: GetMcpToolsExecutionMeta): Promise<GetMcpToolsAgentResult> => {
    if (!isGetMcpToolsInteractionHandler(interactionHandler) || !isGetMcpToolsArgs(rawArgs)) throw new Error("GetMcpTools execution requires valid arguments and an interaction handler")
    const args = rawArgs
    const startTime = Date.now()
    const mode = args.toolName !== undefined ? "tool_detail" : args.pattern !== undefined ? "search" : args.server === undefined ? "catalog" : "server_detail"
    const reportSuccess = (ctx: Context, result: GetMcpToolsAgentResult, dimensions: { readonly resultCount: number; readonly payloadBytes: number; readonly wroteToFile: boolean }): void => {
      emitGetMcpToolsMetrics(ctx, { mode, durationMs: Date.now() - startTime, success: true, resultCount: dimensions.resultCount, responseBytes: result.result.case === "success" ? Buffer.byteLength(result.result.value.content, "utf8") : 0, payloadBytes: dimensions.payloadBytes, wroteToFile: dimensions.wroteToFile })
    }
    const reportError = (ctx: Context, reason: string, error?: unknown): void => {
      const durationMs = Date.now() - startTime
      emitGetMcpToolsMetrics(ctx, { mode, durationMs, success: false, failureReason: reason })
      if (error !== undefined) reportMcpMetaToolFailure(ctx, error, { tool: name, failureReason: reason, retryable: false, mode, durationMs })
    }
    try {
      // A malformed request is refused before anything is asked of the execution side.
      try { validateArgs(args, dynamic); } catch (error) { reportError(parentCtx, GET_MCP_TOOLS_FAILURE_REASONS.INVALID_ARGS, error); throw error }
      const baseArgs = createArgs(meta.toolCallId, args)
      const baseToolCall = createToolCall(baseArgs)
      return await interactionHandler.executeToolCall(parentCtx, baseToolCall, meta.toolCallId, async ctx => {
        const restrictWorkspace = isProjectWorkspaceState(meta.stateHandler) ? await isProjectWorkspaceConversation(ctx, meta.stateHandler) : false
        const isBlocked = (input: { readonly serverIdentifier: string; readonly toolName: string }) => options.isMcpToolBlocked?.(input) === true || restrictWorkspace && isWorkspaceMutation(input)
        const requestsBuiltin = args.server !== undefined && options.dynamicToolRegistry !== undefined && isReservedDynamicToolsNamespace(args.server)
        const liveServers = requestsBuiltin ? [] : await resolveServers(ctx, options.resourceAccessor, snapshots, allowAuth, args.server === undefined ? [] : [args.server])
        const servers = liveServers.map(server => {
          const filtered = server.descriptor.tools.filter(tool => !isBlocked({ serverIdentifier: server.descriptor.serverIdentifier, toolName: tool.toolName }))
          return filtered.length === server.descriptor.tools.length ? server : { ...server, descriptor: new McpDescriptor({ ...server.descriptor, tools: filtered }) }
        })
        const mergedServers = mergeBuiltinToolsServer(servers, options.dynamicToolRegistry)
        if (args.pattern !== undefined && args.toolName === undefined) {
          let regex: { test(input: string): boolean }
          try { regex = compileSearchRegex(args.pattern) } catch (error) { reportError(ctx, GET_MCP_TOOLS_FAILURE_REASONS.INVALID_REGEX, error); throw error }
          let searchServers = mergedServers
          if (args.server !== undefined) {
            const selected = mergedServers.find(server => server.descriptor.serverIdentifier === args.server)
            if (selected === undefined) {
              const error = serverNotFoundError(args.server, mergedServers.map(server => server.descriptor.serverIdentifier).sort(), dynamic)
              reportError(ctx, GET_MCP_TOOLS_FAILURE_REASONS.SERVER_NOT_FOUND, error); throw error
            }
            searchServers = [selected]
          }
          const matches: Record<string, unknown>[] = []
          for (const server of searchServers) {
            const metadata = descriptorToServerMetadata(server, allowAuth)
            // A server whose own name matches is listed once, and every tool under it counts as a match.
            const serverMatches = regex.test(server.descriptor.serverIdentifier)
            const tools = server.descriptor.tools.filter(tool => serverMatches || regex.test(tool.toolName))
            if (serverMatches) matches.push({ server: metadata.server, description: metadata.serverDescription, serverStatus: metadata.serverStatus, serverError: metadata.serverError })
            for (const tool of tools) {
              const row: Record<string, unknown> = { server: server.descriptor.serverIdentifier, tool: tool.toolName, description: sanitizeAndTruncateDescription(tool.description) }
              // A tool row repeats its server's status only when the server itself was not already listed.
              if (metadata.serverStatus !== undefined && metadata.serverStatus !== "ready" && !serverMatches) { row.serverStatus = metadata.serverStatus; row.serverError = metadata.serverError }
              matches.push(row)
            }
          }
          matches.sort((left, right) => left.server === right.server ? String(left.tool ?? "").localeCompare(String(right.tool ?? "")) : String(left.server).localeCompare(String(right.server)))
          const prepared = await maybeWriteToFile(ctx, options.resourceAccessor, options.projectDir, meta.toolCallId, { mode: "search", pattern: args.pattern, matches: matches.map(match => toModelFacingSearchResult(match, dynamic)) })
          reportSuccess(ctx, prepared.result, { resultCount: matches.length, payloadBytes: prepared.payloadBytes, wroteToFile: prepared.wroteToFile })
          return prepared.result
        }
        if (args.server === undefined) {
          const payloads = [...mergedServers].sort((left, right) => left.descriptor.serverIdentifier.localeCompare(right.descriptor.serverIdentifier)).map(server => descriptorToServerPayload(server, allowAuth))
          const count = payloads.reduce((total, payload) => total + (Array.isArray(payload.tools) ? payload.tools.length : 0), 0)
          const payload = dynamic ? { mode: "catalog", namespaces: payloads.map(value => toModelFacingServerPayload(value, true)) } : { mode: "catalog", servers: payloads }
          const prepared = await maybeWriteToFile(ctx, options.resourceAccessor, options.projectDir, meta.toolCallId, payload)
          reportSuccess(ctx, prepared.result, { resultCount: count, payloadBytes: prepared.payloadBytes, wroteToFile: prepared.wroteToFile })
          return prepared.result
        }
        const server = mergedServers.find(candidate => candidate.descriptor.serverIdentifier === args.server)
        if (server === undefined) {
          const error = serverNotFoundError(args.server, mergedServers.map(candidate => candidate.descriptor.serverIdentifier).sort(), dynamic)
          reportError(ctx, GET_MCP_TOOLS_FAILURE_REASONS.SERVER_NOT_FOUND, error); throw error
        }
        const payload = descriptorToServerPayload(server, allowAuth, { includeSchema: true, trustedFirstParty: options.dynamicToolRegistry !== undefined && isReservedDynamicToolsNamespace(args.server), ...(args.toolName === undefined ? {} : { toolName: args.toolName }) })
        if (args.toolName === undefined) {
          const output = dynamic ? { mode: "namespace", ...toModelFacingServerPayload(payload, true) } : { mode: "server", ...payload }
          const prepared = await maybeWriteToFile(ctx, options.resourceAccessor, options.projectDir, meta.toolCallId, output)
          reportSuccess(ctx, prepared.result, { resultCount: Array.isArray(payload.tools) ? payload.tools.length : 0, payloadBytes: prepared.payloadBytes, wroteToFile: prepared.wroteToFile })
          return prepared.result
        }
        const tool = Array.isArray(payload.tools) ? payload.tools.find(candidate => candidate.tool === args.toolName) : undefined
        if (tool === undefined) {
          const status = typeof payload.serverStatus === "string" ? payload.serverStatus : undefined
          // A server that is not usable explains itself, so the model is told why rather than only that the
          // tool is missing.
          if (status !== undefined && status !== "ready") {
            const message = typeof payload.serverError === "string" ? payload.serverError : `${dynamic ? "Namespace" : "MCP server"} "${args.server}" is ${status}.`
            const error = metaError(message, ToolErrorClassification.UNEXPECTED_ENVIRONMENT)
            reportError(ctx, GET_MCP_TOOLS_FAILURE_REASONS.TOOL_NOT_FOUND, error); throw error
          }
          // A tool the model could call directly is not part of a namespace, and saying so saves a retry.
          if (dynamic && isReservedDynamicToolsNamespace(args.server) && options.dynamicToolRegistry?.usesDirectToolRecovery() === true && options.dynamicToolRegistry.isStaticTool(args.toolName) === true) {
            const message = `Tool "${args.toolName}" is already available directly and is not part of dynamic namespace "${args.server}". Invoke "${args.toolName}" directly instead of using dynamic tool discovery or invocation.`
            const error = metaError(message, ToolErrorClassification.UNEXPECTED_ENVIRONMENT)
            reportError(ctx, GET_MCP_TOOLS_FAILURE_REASONS.TOOL_NOT_FOUND, error); throw error
          }
          const message = dynamic ? `Tool "${args.toolName}" not found in namespace "${args.server}".` : `MCP tool "${args.toolName}" not found on server "${args.server}".`
          const error = metaError(message, ToolErrorClassification.UNEXPECTED_ENVIRONMENT)
          reportError(ctx, GET_MCP_TOOLS_FAILURE_REASONS.TOOL_NOT_FOUND, error); throw error
        }
        const content = JSON.stringify(toModelFacingSingleToolPayload(payload, tool, dynamic), null, 2)
        const result = success(content)
        reportSuccess(ctx, result, { resultCount: 1, payloadBytes: Buffer.byteLength(content, "utf8"), wroteToFile: false })
        return result
      }, result => createToolCall(baseArgs, result))
    } catch (error) {
      throw error
    }
  }
  return createZodAgentTool("GET_MCP_TOOLS", {
    name,
    dynamicToolMetaRole: "discovery",
    descriptionGenerator: (props: Record<string, unknown>) => {
      const allTools = props.allTools
      const callName = options.callMcpToolName ?? (isRecord(allTools) && isRecord(allTools.MCP) && typeof allTools.MCP.name === "string" ? allTools.MCP.name : "CallMcpTool")
      // How authentication is presented depends on whether this environment can run the auth tool at all.
      const authLines = allowAuth
        ? ["", dynamic ? `MCP authentication: If an MCP-backed namespace has namespaceStatus "needsAuth", or its tool call fails with an authentication/authorization error, authenticate it by calling ${MCP_AUTH_TOOL_NAME} through ${callName} with empty arguments. Then inspect that namespace again and retry if appropriate.` : `MCP authentication: If a relevant server has serverStatus "needsAuth", or if an MCP tool call fails with an authentication/authorization error, authenticate it by calling ${MCP_AUTH_TOOL_NAME} (via ${callName}, with empty arguments), then inspect that server again and retry the original request if appropriate. Do not call ${MCP_AUTH_TOOL_NAME} just because it is listed, and do not repeatedly call it if authentication did not fix the failure.`]
        : ["", dynamic ? `MCP authentication: If an MCP-backed namespace has namespaceStatus "needsAuth", its tools are unavailable until that MCP integration is authenticated in the Slate desktop IDE.` : `MCP authentication: If a server has serverStatus "needsAuth", its tools are not usable in this environment. Ask the user to authenticate that MCP server in the Slate desktop IDE, then retry.`]
      const builtinLines = dynamic && options.dynamicToolRegistry !== undefined && !options.dynamicToolRegistry.isEmpty()
        ? ["", `First-party Slate tools: the reserved namespace "${DYNAMIC_TOOLS_NAMESPACE}" lists built-in Slate tools available on demand (${options.dynamicToolRegistry.getToolNames().join(", ")}). Discover their schemas here, then invoke them via ${callName}; they run natively with their own approvals and rendering.`]
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
    parameters: modelParameters,
    render: renderResult,
    execute: withSafeParsedArgs(parsingParameters, execute, createToolCall(createArgs("unknown-tool-call-id", {}), failure("Invalid arguments"))),
    serializeError: error => createToolCall(createArgs("unknown-tool-call-id", {}), failure(error instanceof Error ? error.message : String(error))),
  })
}
