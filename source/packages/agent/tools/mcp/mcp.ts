/**
 * Calling an MCP tool, and the review that decides whether it may be called at all.
 *
 * There are two ways in. A tool from a server is its own tool: the model sees it under its own name and
 * calls it with the server's schema, which is what `createMcpTool` builds. And a tool that is not known
 * ahead of time is called by name through one meta tool, which is what `createCallMcpTool` builds — the
 * model names the server and the tool, and the arguments travel as they were given. Both end in the same
 * place: an execution request to the platform, whose answer is projected back into the shape a tool result
 * takes.
 *
 * Before either call runs, the platform may review it. The review is a classifier that is asked about the
 * call's target — which server, which tool, with which arguments, under which project permissions — and its
 * answer decides: an allow proceeds, a block stops the call, and anything else is treated as a block the
 * user has to clear. A blocked call that the model asked the user to approve becomes an approval request
 * instead of a refusal, and one that the model did not ask about is refused with the reason and the two ways
 * forward spelled out, since a model that stops at a block leaves the user with nothing to click.
 *
 * The rest is the details that make a call work: names are normalized and shortened so a server's name fits
 * what a provider accepts, schemas are normalized so an empty or malformed one is still a schema, arguments
 * that are not JSON are refused before anything is asked of the server, and a call that was preceded by a
 * search for the tool is counted as such, because a model that searches first is behaving well.
 */

import { jsonSchema } from "ai"
import { Struct, Value, type JsonValue } from "@bufbuild/protobuf"

import type { Context } from "../../../context/context.ts"
import type { RedactedString } from "../../../redaction/redacted-values.ts"
import { createLogger } from "../../../context/logging.ts"
import { createSpan } from "../../../context/telemetry.ts"
import type { ResourceAccessor } from "../../../agent-exec/resource-provider.ts"
import type { RemoteExecManager } from "../../../agent-exec/executor-resources.ts"
import { mcpExecutorResource } from "../../../agent-exec/mcp-operations.ts"
import { smartModeClassifierExecutorResource } from "../../../agent-exec/smart-mode-classifier-operation.ts"
import { McpArgs, McpPermissionDenied, McpRejected } from "../../../proto/generated/agent/v1/mcp_exec_pb.ts"
import { McpToolCall, McpToolError, McpToolResult } from "../../../proto/generated/agent/v1/mcp_tool_pb.ts"
import type { McpFileSystemOptions, McpMetaToolOptions } from "../../../proto/generated/agent/v1/mcp_pb.ts"
import { SmartModeApproval } from "../../../proto/generated/agent/v1/utils_pb.ts"
import { SmartModeClassifierArgs, SmartModeClassifierDecision, SmartModeRiskTarget, type SmartModeClassifierConversationMessage } from "../../../proto/generated/agent/v1/smart_mode_classifier_exec_pb.ts"
import type { RequestContext } from "../../../proto/generated/agent/v1/request_context_exec_pb.ts"
import { AgentType } from "../../utils/agent-config.ts"
import { getConversationId } from "../../utils/request-scope.ts"
import { getAgentEventTracker } from "../../utils/event-tracking.ts"
import { loadSmartModeProjectPermissionsContext } from "../../smart-mode-project-permissions.ts"
import { tryExtractSmartModeClassifierConversationContext } from "../../smart-mode-classifier-context.ts"
import type { ConversationStateHandle } from "../../state.ts"
import { AgentConversationTurnHandle } from "../../state.ts"
import { executeSmartModeClassifierWithMeasurement } from "../../utils/smart-mode-classifier-measurement.ts"
import { delayDevSmartModeClassifierIfRequested, type OneShotState } from "../dev-smart-mode-classifier-block.ts"
import { withToolExecutionTimeoutSuspended } from "../tool-timeout-suspension.ts"
import {
  CustomToolCallError,
  ToolCallAbortedError,
  createZodAgentTool,
  generateSeededUuid,
} from "../tool-support.ts"
import { ToolCallRejectedError } from "../tool-errors.ts"
import { ToolCallError, agentToolExecutionMetaKey, convertTupleSchemaToDraft2020_12 } from "../tool-support.ts"
import { ToolErrorClassification } from "../tool-errors.ts"
import { type McpInputSchemaLike, mcpInputSchemaToJson } from "../../../agent-exec/mcp-operations.ts"
import { DynamicToolRegistry } from "./builtin-tools.ts"
import {
  buildMcpCallSchemas,
  indexMcpDescriptors,
} from "./mcp-call-options.ts"
import {
  McpExecToolNotFoundError,
  McpPermissionDeniedError,
  McpServerDoesNotExistError,
  convertExecSuccessToToolSuccess,
  createMcpToolCall,
  McpInvalidArgsToolDefinitionReminderError,
  getWrappedMcpErrorClassification,
  isInvalidMcpArgumentsError,
  renderMcpToolResult,
} from "./mcp-result-boundary.ts"
import { assertMcpToolIsCallable, checkToolDefinitionRead } from "./mcp-execution-guards.ts"
import type { HookAdditionalContext } from "../../../proto/generated/agent/v1/hook_additional_context_pb.ts"
import {
  CALL_MCP_TOOL_FAILURE_REASONS,
  emitCallMcpToolMetrics,
  emitMcpSearchThenCallResult,
} from "../../utils/mcp-metrics.ts"
import {
  computeSmartModeMcpApprovalTargetFingerprint,
  createSmartModeMcpApprovalRequest,
} from "./smart-mode-approval.ts"
import { smartModeMcpApprovalStoreResource } from "./smart-mode-approval-store.ts"

const logger = createLogger("tools/mcp")
const SMART_MODE_MCP_BLOCK_REASON = "Blocked by Auto-review"
const SMART_MODE_MCP_CLASSIFIER_ERROR_REASON = "An error occured while classifying this action. Please review manually."
const SMART_MODE_MCP_PARENT_REQUESTED_APPROVAL_FALLBACK_REASON = SMART_MODE_MCP_CLASSIFIER_ERROR_REASON
const SMART_MODE_MCP_BLOCKED_AUTONOMOUS_REASON_SUFFIX = "\n\n<system_reminder>\nAuto-review blocked this autonomous tool call. Decide now between two paths: (1) if a genuinely safer, lower-privilege, authorized path satisfies the request, use it; (2) if this blocked action is still necessary and the user should approve it, immediately retry the exact same call_mcp_tool call with requestSmartModeApproval set to true AND smartModeBlockReason set to the exact block reason text above. That retry is what shows the native approval card; stopping here leaves the user with no approval UI. Do not change the tool arguments or use an escalated variant when retrying.\n</system_reminder>"
// The same refusal, addressed to the tool the model actually called.
const SMART_MODE_DYNAMIC_MCP_BLOCKED_AUTONOMOUS_REASON_SUFFIX = SMART_MODE_MCP_BLOCKED_AUTONOMOUS_REASON_SUFFIX.replace("call_mcp_tool", "CallDynamicTool")

type JsonRecord = { readonly [key: string]: JsonValue }

function toJsonValue(value: unknown): JsonValue | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return value
  if (Array.isArray(value)) {
    const values: JsonValue[] = []
    for (const entry of value) {
      const jsonValue = toJsonValue(entry)
      if (jsonValue === undefined) return undefined
      values.push(jsonValue)
    }
    return values
  }
  if (typeof value !== "object") return undefined
  const record: Record<string, JsonValue> = {}
  for (const [key, entry] of Object.entries(value)) {
    const jsonValue = toJsonValue(entry)
    if (jsonValue !== undefined) record[key] = jsonValue
  }
  return record
}

function toJsonRecord(value: unknown): JsonRecord {
  const jsonValue = toJsonValue(value)
  return jsonValue !== undefined && jsonValue !== null && typeof jsonValue === "object" && !Array.isArray(jsonValue) ? jsonValue : {}
}

/** A provider accepts a bounded tool name, so a long one is shortened with a stable hash of itself. */
function truncateMcpToolName(name: string): string {
  if (name.length <= 64) return name
  const hash = generateSeededUuid(name).replaceAll("-", "").slice(0, 7)
  return `${name.slice(0, 57)}${hash}`
}

function normalizeMcpToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_")
}

/** A schema that is missing, empty or malformed is still a schema: an object with no properties. */
function normalizeMcpInputSchema(inputSchema: unknown, convertTupleSchema: boolean): JsonValue {
  if (inputSchema === null || typeof inputSchema !== "object" || Array.isArray(inputSchema)) return { type: "object", properties: {} }
  const schema = toJsonRecord(inputSchema)
  const properties = schema.properties
  if (properties === undefined || (typeof properties === "object" && properties !== null && !Array.isArray(properties) && Object.keys(properties).length === 0)) {
    return { type: "object", properties: {} }
  }
  return convertTupleSchema ? toJsonRecord(convertTupleSchemaToDraft2020_12(schema)) : schema
}

interface InteractionHandlerLike {
  executeToolCall(
    ctx: Context,
    toolCall: ReturnType<typeof createMcpToolCall>,
    callId: string,
    promiseFn: (ctx: Context) => Promise<McpToolResult>,
    resultMergeFn: (result: McpToolResult) => ReturnType<typeof createMcpToolCall>,
    hookContextCollector?: readonly HookAdditionalContext[],
  ): Promise<McpToolResult>
  getAbortSignal?(ctx: Context): AbortSignal
}

interface McpStateHandler extends ConversationStateHandle {
  hasReadPath(path: RedactedString): boolean
}

interface McpExecutionMeta {
  readonly toolCallId: string
  readonly stateHandler?: McpStateHandler
  readonly workspacePaths?: readonly string[]
  readonly hookContextCollector?: HookAdditionalContext[]
}

interface AutoRunInstructionsLike {
  readonly allowInstructions: readonly string[]
  readonly blockInstructions: readonly string[]
}

interface SmartModeApprovalProvider {
  requestApproval(input: {
    readonly kind: "mcp"
    readonly target: SmartModeApprovalTarget
    readonly fingerprint: string
    readonly toolCallId: string
    readonly conversationId: string | undefined
    readonly signal: AbortSignal
  }): Promise<{ readonly approved: boolean; readonly reason?: string | undefined }>
}

interface SmartModeApprovalTarget {
  readonly serverIdentifier: string
  readonly serverName?: string | undefined
  readonly serverDisplayName?: string | undefined
  readonly toolName: string
  readonly mcpMode: string
  readonly mcpArguments?: unknown
  readonly toolDefinitionIdentity?: string | undefined
  readonly toolDefinitionHash?: string | undefined
  readonly blockReason: string
  readonly description?: string | undefined
  readonly proposedAllowRule?: string | undefined
}

export interface McpToolDefinitionLike extends McpInputSchemaLike {
  readonly name: string
  readonly providerIdentifier: string
  readonly toolName: string
  readonly description?: string | undefined
  readonly clientKey?: string | undefined
  readonly plugin?: string | undefined
  readonly marketplace?: string | undefined
  readonly pluginId?: string | undefined
  readonly marketplaceId?: string | undefined
}

export interface CreateCallMcpToolOptions {
  readonly resourceAccessor: ResourceAccessor<RemoteExecManager>
  readonly name?: string | undefined
  readonly mcpFileSystemOptions?: McpFileSystemOptions | undefined
  readonly mcpMetaToolOptions?: McpMetaToolOptions | undefined
  readonly validateMcpToolDescriptors?: boolean | undefined
  readonly getMcpToolsToolName?: string | undefined
  readonly allowInteractiveMcpAuth?: boolean | undefined
  readonly agentType?: AgentType | undefined
  readonly requestContext?: Pick<RequestContext, "env"> | undefined
  readonly smartModeClassifierMode?: boolean | undefined
  readonly smartModeClassifierShadowMode?: boolean | undefined
  readonly smartModeApprovalProvider?: SmartModeApprovalProvider | undefined
  readonly devSmartModeClassifierBlockState?: OneShotState | undefined
  readonly devSmartModeClassifierDelayState?: OneShotState | undefined
  readonly dynamicToolRegistry?: DynamicToolRegistry | undefined
  readonly isMcpToolBlocked?: (input: { readonly serverIdentifier: string; readonly toolName: string }) => boolean
  readonly extractSmartModeClassifierConversationContext?: (ctx: Context, state: ConversationStateHandle) => Promise<SmartModeClassifierConversationMessage[]>
  readonly userAutoRunInstructions?: AutoRunInstructionsLike | undefined
  readonly projectAutoRunInstructions?: AutoRunInstructionsLike | undefined
  readonly suppressSmartModeClassifierTelemetryIds?: boolean | undefined
  readonly smartModeClassifierMaxAttempts?: number | undefined
}

function buildMcpArgs(
  serverIdentifier: string,
  serverName: string,
  toolName: string,
  args: Record<string, unknown>,
  toolCallId: string,
  description?: string,
): McpArgs {
  const values: Record<string, Value> = {}
  for (const [key, value] of Object.entries(args)) {
    const jsonValue = toJsonValue(value)
    if (jsonValue !== undefined) values[key] = Value.fromJson(jsonValue)
  }
  return new McpArgs({
    name: `${serverIdentifier}-${toolName}`,
    args: values,
    toolCallId,
    providerIdentifier: serverName,
    toolName,
    serverIdentifier,
  })
}

async function readJsonObject(argsStream: AsyncIterable<string>): Promise<Record<string, unknown>> {
  let serialized = ""
  for await (const chunk of argsStream) serialized += chunk
  let parsed: unknown
  try {
    parsed = JSON.parse(serialized)
  } catch (error) {
    throw new Error(`Tool call arguments were not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!isRecord(parsed)) throw new Error("Tool call arguments must be a JSON object")
  return parsed
}

function isInteractionHandler(value: unknown): value is InteractionHandlerLike {
  return isRecord(value) && typeof value.executeToolCall === "function"
}

/** Whether the model looked the tool up before calling it, which is the behaviour worth counting. */
async function wasPrecededByGetMcpToolsSearch(ctx: Context, stateHandler: McpStateHandler | undefined): Promise<boolean> {
  if (stateHandler === undefined) return false
  try {
    const lastTurn = await stateHandler.turns.at(-1)?.get(ctx)
    if (!(lastTurn instanceof AgentConversationTurnHandle)) return false
    for (let index = lastTurn.steps.length - 1; index >= 0; index -= 1) {
      const step = await lastTurn.steps[index]!.get(ctx)
      if (isMcpDiscoverySearchStep(step)) return true
    }
  } catch {
    // A conversation that cannot be read is not evidence either way.
    return false
  }
  return false
}

/** A discovery step counts as a search only when it asked with a pattern rather than listing everything. */
function isMcpDiscoverySearchStep(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.message) || value.message.case !== "toolCall" || !isRecord(value.message.value)) return false
  const tool = value.message.value.tool
  if (!isRecord(tool) || tool.case !== "getMcpToolsToolCall" || !isRecord(tool.value)) return false
  const args = tool.value.args
  return isRecord(args) && args.pattern !== undefined
}

function serializeMcpError(error: unknown): ReturnType<typeof createMcpToolCall> {
  if (error instanceof McpPermissionDeniedError) {
    return createMcpToolCall(new McpToolCall({ result: new McpToolResult({ result: { case: "permissionDenied", value: new McpPermissionDenied({ error: error.error, isReadonly: error.isReadonly }) } }) }))
  }
  if (error instanceof ToolCallRejectedError) {
    return createMcpToolCall(new McpToolCall({ result: new McpToolResult({ result: { case: "rejected", value: new McpRejected({ reason: error.message }) } }) }))
  }
  const custom = error instanceof CustomToolCallError ? error : undefined
  const errorMessage = error instanceof Error ? error.message : String(error)
  return createMcpToolCall(new McpToolCall({ result: new McpToolResult({ result: { case: "error", value: new McpToolError({ error: custom?.clientVisibleErrorMessage ?? "Tool execution error", readToolDefReminder: custom?.modelVisibleErrorMessage ?? errorMessage }) } }) }))
}

/**
 * The review a call may have to pass before it runs.
 *
 * The classifier is asked about the call as a target, with the project's permissions included, because what
 * is safe to run depends on what the project allows. A shadow run asks the classifier without acting on the
 * answer, which is how the platform measures the classifier before trusting it. A block becomes either an
 * approval request or a refusal, and the refusal spells out the two ways forward so the model does not stop
 * where the user has nothing to click.
 */
async function runSmartModeMcpPreflight(
  ctx: Context,
  options: CreateCallMcpToolOptions,
  args: {
    readonly enabled: boolean
    readonly shadowEnabled: boolean
    readonly toolCallId: string
    readonly stateHandler?: McpStateHandler
    readonly serverIdentifier: string
    readonly serverName: string
    readonly toolName: string
    readonly mcpArguments: Record<string, unknown>
    readonly description?: string | undefined
    readonly requestSmartModeApproval: boolean
    readonly smartModeBlockReason?: string | undefined
  },
): Promise<SmartModeApproval | undefined> {
  if (!args.enabled && !args.shadowEnabled) return undefined
  // A developer can force the next call to be blocked, which is how the refusal path is exercised.
  if (options.devSmartModeClassifierBlockState?.consume() === true && args.enabled) {
    await delayDevSmartModeClassifierIfRequested(options.devSmartModeClassifierDelayState)
    throw new ToolCallRejectedError(SMART_MODE_MCP_BLOCK_REASON)
  }
  if (!args.enabled) return undefined
  try {
    const executor = options.resourceAccessor.get(smartModeClassifierExecutorResource)
    const conversationContext = args.stateHandler === undefined
      ? []
      : options.extractSmartModeClassifierConversationContext !== undefined
        ? await options.extractSmartModeClassifierConversationContext(ctx, args.stateHandler)
        : await tryExtractSmartModeClassifierConversationContext(ctx, args.stateHandler)
    const permissions = await loadSmartModeProjectPermissionsContext(
      ctx,
      options.mcpFileSystemOptions?.workspaceProjectDir === undefined ? undefined : [options.mcpFileSystemOptions.workspaceProjectDir],
      options.userAutoRunInstructions,
      options.projectAutoRunInstructions,
    )
    const target = new SmartModeRiskTarget({
      action: "mcp",
      arguments: Struct.fromJson(toJsonRecord({
        server: { identifier: args.serverIdentifier, name: args.serverName },
        tool_name: args.toolName,
        mcp_mode: options.mcpMetaToolOptions?.enabled === true ? "meta_tool" : "file_system",
        arguments: args.mcpArguments,
        tool_definition: args.description === undefined ? undefined : { description: args.description },
        project_permissions: permissions,
      })),
    })
    const parentConversationId = getConversationId(ctx)
    const classifierArgs = parentConversationId === undefined
      ? new SmartModeClassifierArgs({ toolCallId: args.toolCallId, target, conversationContext })
      : new SmartModeClassifierArgs({ toolCallId: args.toolCallId, parentConversationId, target, conversationContext })
    const result = await executeSmartModeClassifierWithMeasurement(
      ctx,
      executor,
      classifierArgs,
      "enforce",
      options.mcpFileSystemOptions?.workspaceProjectDir === undefined ? undefined : [options.mcpFileSystemOptions.workspaceProjectDir],
      { maxAttempts: options.smartModeClassifierMaxAttempts, suppressToolCallIdLogging: options.suppressSmartModeClassifierTelemetryIds },
    )
    // Anything that is not an allow or a block is not an answer, so the call is refused as unclassified.
    if (result.result.case !== "success" || result.result.value.decision !== SmartModeClassifierDecision.BLOCK) {
      if (result.result.case !== "success" || result.result.value.decision !== SmartModeClassifierDecision.ALLOW) throw new ToolCallRejectedError(SMART_MODE_MCP_CLASSIFIER_ERROR_REASON)
      return undefined
    }
    const blockReason = result.result.value.blockReason ?? SMART_MODE_MCP_BLOCK_REASON
    const targetForApproval: SmartModeApprovalTarget = {
      serverIdentifier: args.serverIdentifier,
      serverName: args.serverName,
      toolName: args.toolName,
      mcpMode: options.mcpMetaToolOptions?.enabled === true ? "meta_tool" : "file_system",
      mcpArguments: args.mcpArguments,
      blockReason,
      ...(args.description !== undefined ? { description: args.description } : {}),
    }
    // A model that asked for approval gets a card to click; one that did not is told how to ask.
    if (options.smartModeApprovalProvider === undefined && args.requestSmartModeApproval) {
      const parentBlockReason = args.smartModeBlockReason !== undefined && args.smartModeBlockReason.trim().length > 0
        ? args.smartModeBlockReason.trim()
        : SMART_MODE_MCP_PARENT_REQUESTED_APPROVAL_FALLBACK_REASON
      if (options.agentType === AgentType.BACKGROUND) throw new ToolCallRejectedError(parentBlockReason)
      const store = options.resourceAccessor.get(smartModeMcpApprovalStoreResource)
      const approvalRequest = await createSmartModeMcpApprovalRequest(ctx, store, { ...targetForApproval, blockReason: parentBlockReason })
      return new SmartModeApproval({ requestId: approvalRequest.requestId, reason: approvalRequest.blockReason })
    }
    if (options.smartModeApprovalProvider === undefined) {
      throw new ToolCallRejectedError(`${blockReason}${options.dynamicToolRegistry === undefined ? SMART_MODE_MCP_BLOCKED_AUTONOMOUS_REASON_SUFFIX : SMART_MODE_DYNAMIC_MCP_BLOCKED_AUTONOMOUS_REASON_SUFFIX}`)
    }
    // Waiting for a user to approve something is not the tool timing out, so the timeout is suspended.
    const approval = await withToolExecutionTimeoutSuspended(ctx, () => options.smartModeApprovalProvider!.requestApproval({
      kind: "mcp",
      target: targetForApproval,
      fingerprint: computeSmartModeMcpApprovalTargetFingerprint(targetForApproval),
      toolCallId: args.toolCallId,
      conversationId: getConversationId(ctx),
      signal: ctx.signal,
    }))
    if (ctx.signal.aborted) throw new ToolCallAbortedError()
    if (!approval.approved) throw new ToolCallRejectedError(approval.reason ?? blockReason)
    return undefined
  } catch (error) {
    // A store that was never configured is a platform bug, not a refusal, so it is raised as it is.
    if (error instanceof Error && error.message === "Auto-review MCP approval store is not configured") throw error
    if (error instanceof ToolCallRejectedError || error instanceof ToolCallAbortedError) throw error
    if (error instanceof Error && error.name === "AbortError") throw error
    throw new ToolCallRejectedError(SMART_MODE_MCP_CLASSIFIER_ERROR_REASON)
  }
}

/** A tool from a server, as a tool of its own under the name the provider will accept. */
export function createMcpTool(
  resourceAccessor: ResourceAccessor<RemoteExecManager>,
  mcpToolDefinition: McpToolDefinitionLike,
  options: { readonly name?: string | undefined; readonly convertTupleSchemaToDraft2020_12?: boolean | undefined } = {},
): Record<string, unknown> {
  const executor = resourceAccessor.get(mcpExecutorResource)
  const inputSchema = mcpInputSchemaToJson(mcpToolDefinition)
  const toolName = options.name ?? truncateMcpToolName(normalizeMcpToolName(mcpToolDefinition.name))
  const execute = async (
    parentCtx: Context,
    interactionHandler: InteractionHandlerLike,
    rawArgs: Record<string, unknown>,
    meta: McpExecutionMeta,
  ): Promise<McpToolResult> => {
    using span = createSpan(parentCtx.withName("mcpExecute"))
    const args = buildMcpArgs(mcpToolDefinition.providerIdentifier, mcpToolDefinition.providerIdentifier, mcpToolDefinition.toolName, rawArgs, meta.toolCallId)
    const baseToolCall = createMcpToolCall(new McpToolCall({ args }))
    return interactionHandler.executeToolCall(span.ctx, baseToolCall, meta.toolCallId, async ctx => {
      const tracker = getAgentEventTracker(ctx)
      tracker.trackMcpToolCall(ctx, { name: mcpToolDefinition.toolName, mcpServerName: mcpToolDefinition.providerIdentifier, origin: "external" })
      const paramsJson = JSON.stringify(rawArgs)
      try {
        const result = await executor.execute(ctx.with(agentToolExecutionMetaKey, meta), args, {
          execId: generateSeededUuid(meta.toolCallId),
          ...(meta.hookContextCollector !== undefined ? { hookContextCollector: meta.hookContextCollector } : {}),
        })
        const projected = convertExecSuccessToToolSuccess(result, undefined, undefined, undefined, undefined)
        tracker.trackMcpToolCallResult(ctx, { toolName: mcpToolDefinition.toolName, mcpServerName: mcpToolDefinition.providerIdentifier, paramsJson, success: true })
        return projected
      } catch (error) {
        const classified = error instanceof ToolCallError ? error : new Error(error instanceof Error ? error.message : String(error), { cause: error })
        tracker.trackMcpToolCallResult(ctx, { toolName: mcpToolDefinition.toolName, mcpServerName: mcpToolDefinition.providerIdentifier, paramsJson, success: false, errorMessage: classified.message, errorClassification: getWrappedMcpErrorClassification(classified) })
        // Bad arguments are the one failure the model can fix by looking at the schema, so it is told to.
        if (isInvalidMcpArgumentsError(classified)) throw new McpInvalidArgsToolDefinitionReminderError(classified, "Inspect this MCP tool's schema before retrying.")
        throw classified
      }
    }, result => createMcpToolCall(new McpToolCall({ args, result })), meta.hookContextCollector)
  }
  return {
    toolIdentifier: "MCP",
    name: toolName,
    descriptionGenerator: () => mcpToolDefinition.description ?? "",
    parameters: jsonSchema(normalizeMcpInputSchema(inputSchema, options.convertTupleSchemaToDraft2020_12 === true) as Parameters<typeof jsonSchema>[0]),
    render: (_ctx: Context, output: unknown) => renderMcpToolResult(toMcpToolOutput(output)),
    execute: async (ctx: Context, interactionHandler: unknown, argsStream: AsyncIterable<string>, meta: McpExecutionMeta) => {
      if (!isInteractionHandler(interactionHandler)) throw new Error("MCP execution requires an interaction handler")
      return execute(ctx, interactionHandler, await readJsonObject(argsStream), meta)
    },
    serializeError: serializeMcpError,
  }
}

/** The one tool that calls any MCP tool by name, for the tools nobody knew about in advance. */
export function createCallMcpTool(options: CreateCallMcpToolOptions): Record<string, unknown> {
  const useDynamicToolNamespaces = options.dynamicToolRegistry !== undefined
  const session = indexMcpDescriptors({
    mcpMetaToolEnabled: options.mcpMetaToolOptions?.enabled === true,
    mcpMetaToolOptions: options.mcpMetaToolOptions,
    mcpFileSystemOptions: options.mcpFileSystemOptions,
    allowInteractiveMcpAuth: options.allowInteractiveMcpAuth,
  })
  const schemas = buildMcpCallSchemas({ useDynamicToolNamespaces, smartModeClassifierMode: options.smartModeClassifierMode === true })
  const name = options.name ?? "CallMcpTool"
  const execute = async (
    parentCtx: Context,
    interactionHandler: InteractionHandlerLike,
    args: Record<string, unknown>,
    meta: McpExecutionMeta,
  ): Promise<McpToolResult> => {
    using span = createSpan(parentCtx.withName("callMcpToolExecute"))
    const serverIdentifier = typeof args.server === "string" ? args.server : ""
    const toolName = typeof args.toolName === "string" ? args.toolName : ""
    if (options.validateMcpToolDescriptors === true) assertMcpToolIsCallable(session, serverIdentifier, toolName, options.getMcpToolsToolName ?? "GetMcpTools", useDynamicToolNamespaces)
    const readCheck = checkToolDefinitionRead(session, options.mcpMetaToolOptions?.enabled === true, serverIdentifier, toolName, meta.stateHandler)
    if (readCheck.kind === "noServer") throw new McpServerDoesNotExistError(readCheck.serverIdentifier, "Discover available MCP servers before calling this tool.")
    if (readCheck.kind === "noTool") throw new McpExecToolNotFoundError(`Tool ${readCheck.toolName} was not found.`)
    const descriptor = session.serverDescriptors.get(serverIdentifier)
    const serverName = descriptor?.serverName ?? serverIdentifier
    const mcpArguments = isRecord(args.arguments) ? args.arguments : {}
    // Authenticating a server interactively needs a user in front of it, which this environment is not.
    if (!options.allowInteractiveMcpAuth && toolName === "mcp_auth") {
      const message = "Interactive MCP authentication is only available in the Slate desktop IDE."
      throw new CustomToolCallError(ToolErrorClassification.UNEXPECTED_ENVIRONMENT, {
        error: message,
        clientVisibleErrorMessage: message,
        modelVisibleErrorMessage: "Interactive MCP authentication is not available in this agent environment. Ask the user to authenticate the MCP server in the Slate desktop IDE, then retry.",
      })
    }
    if (options.isMcpToolBlocked?.({ serverIdentifier, toolName }) === true) {
      const message = `Tool "${toolName}" on "${serverIdentifier}" is not available in this agent context.`
      throw new CustomToolCallError(ToolErrorClassification.UNEXPECTED_ENVIRONMENT, {
        error: message,
        clientVisibleErrorMessage: message,
        modelVisibleErrorMessage: `${message} It speaks to the end user on the parent agent's behalf and is reserved for the parent agent.`,
      })
    }
    const precededByGetMcpToolsSearch = await wasPrecededByGetMcpToolsSearch(span.ctx, meta.stateHandler)
    const description = typeof args.description === "string" ? args.description : undefined
    const approval = await runSmartModeMcpPreflight(span.ctx, options, {
      enabled: options.smartModeClassifierMode === true,
      shadowEnabled: options.smartModeClassifierShadowMode === true,
      toolCallId: meta.toolCallId,
      ...(meta.stateHandler !== undefined ? { stateHandler: meta.stateHandler } : {}),
      serverIdentifier,
      serverName,
      toolName,
      mcpArguments,
      ...(description !== undefined ? { description } : {}),
      requestSmartModeApproval: args.requestSmartModeApproval === true,
      ...(typeof args.smartModeBlockReason === "string" ? { smartModeBlockReason: args.smartModeBlockReason } : {}),
    })
    const toolArgs = buildMcpArgs(serverIdentifier, serverName, toolName, mcpArguments, meta.toolCallId, typeof args.description === "string" ? args.description : undefined)
    if (approval !== undefined) toolArgs.smartModeApproval = approval
    const baseToolCall = createMcpToolCall(new McpToolCall({ args: toolArgs, ...(description !== undefined ? { description } : {}) }))
    const executor = options.resourceAccessor.get(mcpExecutorResource)
    return interactionHandler.executeToolCall(span.ctx, baseToolCall, meta.toolCallId, async ctx => {
      const tracker = getAgentEventTracker(ctx)
      const paramsJson = JSON.stringify(mcpArguments)
      const startTime = Date.now()
      logger.info(ctx, "MCP tool call", { server: serverIdentifier, toolName })
      try {
        if (ctx.signal.aborted || interactionHandler.getAbortSignal?.(ctx)?.aborted === true) throw new ToolCallAbortedError()
        const result = await executor.execute(ctx.with(agentToolExecutionMetaKey, meta), toolArgs, {
          execId: generateSeededUuid(meta.toolCallId),
          ...(meta.hookContextCollector !== undefined ? { hookContextCollector: meta.hookContextCollector } : {}),
        })
        const projected = convertExecSuccessToToolSuccess(result, undefined, undefined, options.mcpFileSystemOptions, options.getMcpToolsToolName, serverIdentifier)
        tracker.trackMcpToolCallResult(ctx, { toolName, mcpServerName: serverName, paramsJson, success: true })
        emitCallMcpToolMetrics(ctx, { mcpMode: options.mcpMetaToolOptions?.enabled === true ? "meta_tool" : "file_system", durationMs: Date.now() - startTime, success: true })
        if (precededByGetMcpToolsSearch) emitMcpSearchThenCallResult(ctx, "success")
        return projected
      } catch (error) {
        const classified = error instanceof ToolCallError ? error : new Error(error instanceof Error ? error.message : String(error), { cause: error })
        tracker.trackMcpToolCallResult(ctx, { toolName, mcpServerName: serverName, paramsJson, success: false, errorMessage: classified.message, errorClassification: getWrappedMcpErrorClassification(classified) })
        // The reason is a label rather than a closed union, so a caller may compare it with any of them.
        const failureReason: string = classified instanceof ToolCallRejectedError ? CALL_MCP_TOOL_FAILURE_REASONS.REJECTED : CALL_MCP_TOOL_FAILURE_REASONS.OTHER
        emitCallMcpToolMetrics(ctx, { mcpMode: options.mcpMetaToolOptions?.enabled === true ? "meta_tool" : "file_system", durationMs: Date.now() - startTime, success: false, failureReason, retryable: false })
        if (precededByGetMcpToolsSearch) emitMcpSearchThenCallResult(ctx, failureReason === CALL_MCP_TOOL_FAILURE_REASONS.TOOL_NOT_FOUND ? "tool_not_found" : "error")
        throw classified
      }
    }, result => createMcpToolCall(new McpToolCall({ args: toolArgs, result })), meta.hookContextCollector)
  }
  return createZodAgentTool("MCP", {
    name,
    parameters: schemas.parsingParametersSchema,
    descriptionGenerator: () => "Call an MCP tool by server identifier and tool name with arbitrary JSON arguments.",
    render: (_ctx: Context, output: unknown) => renderMcpToolResult(toMcpToolOutput(output)),
    execute: async (ctx: Context, interactionHandler: unknown, argsStream: AsyncIterable<string>, meta: McpExecutionMeta) => {
      if (!isInteractionHandler(interactionHandler)) throw new Error("MCP execution requires an interaction handler")
      const args = schemas.parsingParametersSchema.parse(JSON.parse(await readJsonObject(argsStream).then(value => JSON.stringify(value))))
      if (!isRecord(args)) throw new Error("MCP call arguments must be a JSON object")
      return execute(ctx, interactionHandler, args, meta)
    },
    serializeError: serializeMcpError,
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** A rendered result that is not one is an empty result rather than a crash. */
function toMcpToolOutput(value: unknown): McpToolResult {
  if (value instanceof McpToolResult) return value
  if (isRecord(value) && value.result instanceof McpToolResult) return value.result
  return new McpToolResult()
}

void logger
