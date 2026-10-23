/**
 * Calling an MCP tool, and the review that decides whether it may be called at all.
 *
 * There are two ways in. A tool from a server is its own tool: the model sees it under its own name and
 * calls it with the server's schema, which is what `createMcpTool` builds. And a tool that is not known
 * ahead of time is called by name through one callMeta tool, which is what `createCallMcpTool` builds — the
 * model names the server and the tool, and the arguments travel as they were given. Both end in the same
 * place: an execution request to the platform, whose answer is projectedResult back into the shape a tool result
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
 * what a provider accepts, callSchemas are normalized so an empty or malformed one is still a schema, arguments
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
const AUTO_REVIEW_BLOCK_REASON = "Blocked by Auto-review"
const AUTO_REVIEW_CLASSIFIER_FAILURE_REASON = "An error occured while classifying this action. Please review manually."
const AUTO_REVIEW_PARENT_APPROVAL_FALLBACK = AUTO_REVIEW_CLASSIFIER_FAILURE_REASON
const AUTO_REVIEW_BLOCKED_SUFFIX = "\n\n<system_reminder>\nAuto-review blocked this autonomous tool call. Decide now between two paths: (1) if a genuinely safer, lower-privilege, authorized path satisfies the request, use it; (2) if this blocked action is still necessary and the user should approve it, immediately retry the exact same call_mcp_tool call with requestSmartModeApproval set to true AND smartModeBlockReason set to the exact block reason text above. That retry is what shows the native approval card; stopping here leaves the user with no approval UI. Do not change the tool arguments or use an escalated variant when retrying.\n</system_reminder>"
// The same refusal, addressed to the tool the model actually called.
const AUTO_REVIEW_DYNAMIC_BLOCKED_SUFFIX = AUTO_REVIEW_BLOCKED_SUFFIX.replace("call_mcp_tool", "CallDynamicTool")

type JsonObject = { readonly [key: string]: JsonValue }

function jsonValueOf(value: unknown): JsonValue | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return value
  if (Array.isArray(value)) {
    const values: JsonValue[] = []
    for (const entry of value) {
      const jsonValue = jsonValueOf(entry)
      if (jsonValue === undefined) return undefined
      values.push(jsonValue)
    }
    return values
  }
  if (typeof value !== "object") return undefined
  const record: Record<string, JsonValue> = {}
  for (const [key, entry] of Object.entries(value)) {
    const jsonValue = jsonValueOf(entry)
    if (jsonValue !== undefined) record[key] = jsonValue
  }
  return record
}

function jsonObjectOf(value: unknown): JsonObject {
  const jsonValue = jsonValueOf(value)
  return jsonValue !== undefined && jsonValue !== null && typeof jsonValue === "object" && !Array.isArray(jsonValue) ? jsonValue : {}
}

/** A provider accepts a bounded tool name, so a long one is shortened with a stable hash of itself. */
function fitToolName(name: string): string {
  if (name.length <= 64) return name
  const hash = generateSeededUuid(name).replaceAll("-", "").slice(0, 7)
  return `${name.slice(0, 57)}${hash}`
}

function sanitizeToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_")
}

/** A schema that is missing, empty or malformed is still a schema: an object with no properties. */
function schemaJsonOf(rawSchema: unknown, convertTupleSchema: boolean): JsonValue {
  if (rawSchema === null || typeof rawSchema !== "object" || Array.isArray(rawSchema)) return { type: "object", properties: {} }
  const schema = jsonObjectOf(rawSchema)
  const properties = schema.properties
  if (properties === undefined || (typeof properties === "object" && properties !== null && !Array.isArray(properties) && Object.keys(properties).length === 0)) {
    return { type: "object", properties: {} }
  }
  return convertTupleSchema ? jsonObjectOf(convertTupleSchemaToDraft2020_12(schema)) : schema
}

interface ToolCallBridge {
  executeToolCall(
    toolCtx: Context,
    toolCall: ReturnType<typeof createMcpToolCall>,
    callId: string,
    promiseFn: (toolCtx: Context) => Promise<McpToolResult>,
    resultMergeFn: (result: McpToolResult) => ReturnType<typeof createMcpToolCall>,
    hookContextCollector?: readonly HookAdditionalContext[],
  ): Promise<McpToolResult>
  getAbortSignal?(toolCtx: Context): AbortSignal
}

interface ConversationStateWithReads extends ConversationStateHandle {
  hasReadPath(path: RedactedString): boolean
}

interface McpCallMeta {
  readonly toolCallId: string
  readonly stateHandler?: ConversationStateWithReads
  readonly workspacePaths?: readonly string[]
  readonly hookContextCollector?: HookAdditionalContext[]
}

interface AutoRunRules {
  readonly allowInstructions: readonly string[]
  readonly blockInstructions: readonly string[]
}

interface McpApprovalProvider {
  requestApproval(input: {
    readonly kind: "mcp"
    readonly target: McpApprovalTarget
    readonly fingerprint: string
    readonly toolCallId: string
    readonly conversationId: string | undefined
    readonly signal: AbortSignal
  }): Promise<{ readonly approved: boolean; readonly reason?: string | undefined }>
}

interface McpApprovalTarget {
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

/** What a call is asking the review to look at. */
interface McpReviewArgs {
  readonly enabled: boolean
  readonly shadowEnabled: boolean
  readonly toolCallId: string
  readonly stateHandler?: ConversationStateWithReads
  readonly serverIdentifier: string
  readonly serverName: string
  readonly toolName: string
  readonly mcpArguments: Record<string, unknown>
  readonly description?: string | undefined
  readonly requestSmartModeApproval: boolean
  readonly smartModeBlockReason?: string | undefined
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
  readonly smartModeApprovalProvider?: McpApprovalProvider | undefined
  readonly devSmartModeClassifierBlockState?: OneShotState | undefined
  readonly devSmartModeClassifierDelayState?: OneShotState | undefined
  readonly dynamicToolRegistry?: DynamicToolRegistry | undefined
  readonly isMcpToolBlocked?: (input: { readonly serverIdentifier: string; readonly toolName: string }) => boolean
  readonly extractSmartModeClassifierConversationContext?: (toolCtx: Context, state: ConversationStateHandle) => Promise<SmartModeClassifierConversationMessage[]>
  readonly userAutoRunInstructions?: AutoRunRules | undefined
  readonly projectAutoRunInstructions?: AutoRunRules | undefined
  readonly suppressSmartModeClassifierTelemetryIds?: boolean | undefined
  readonly smartModeClassifierMaxAttempts?: number | undefined
}

function mcpArgumentsOf(
  serverIdentifier: string,
  serverName: string,
  toolName: string,
  args: Record<string, unknown>,
  toolCallId: string,
  description?: string,
): McpArgs {
  const values: Record<string, Value> = {}
  for (const [key, value] of Object.entries(args)) {
    const jsonValue = jsonValueOf(value)
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

async function readArgumentObject(argsStream: AsyncIterable<string>): Promise<Record<string, unknown>> {
  let serialized = ""
  for await (const chunk of argsStream) serialized += chunk
  let parsed: unknown
  try {
    parsed = JSON.parse(serialized)
  } catch (error) {
    throw new Error(`Tool call arguments were not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!isJsonObject(parsed)) throw new Error("Tool call arguments must be a JSON object")
  return parsed
}

function isToolCallBridge(value: unknown): value is ToolCallBridge {
  return isJsonObject(value) && typeof value.executeToolCall === "function"
}

/** Whether the model looked the tool up before calling it, which is the behaviour worth counting. */
async function searchedBeforeCalling(toolCtx: Context, stateHandler: ConversationStateWithReads | undefined): Promise<boolean> {
  if (stateHandler === undefined) return false
  try {
    const lastTurn = await stateHandler.turns.at(-1)?.get(toolCtx)
    if (!(lastTurn instanceof AgentConversationTurnHandle)) return false
    for (let index = lastTurn.steps.length - 1; index >= 0; index -= 1) {
      const step = await lastTurn.steps[index]!.get(toolCtx)
      if (isDiscoverySearchStep(step)) return true
    }
  } catch {
    // A conversation that cannot be read is not evidence either way.
    return false
  }
  return false
}

/** A discovery step counts as a search only when it asked with a pattern rather than listing everything. */
function isDiscoverySearchStep(value: unknown): boolean {
  if (!isJsonObject(value) || !isJsonObject(value.message) || value.message.case !== "toolCall" || !isJsonObject(value.message.value)) return false
  const tool = value.message.value.tool
  if (!isJsonObject(tool) || tool.case !== "getMcpToolsToolCall" || !isJsonObject(tool.value)) return false
  const args = tool.value.args
  return isJsonObject(args) && args.pattern !== undefined
}

function serializeMcpFailure(error: unknown): ReturnType<typeof createMcpToolCall> {
  if (error instanceof McpPermissionDeniedError) {
    return createMcpToolCall(new McpToolCall({ result: new McpToolResult({ result: { case: "permissionDenied", value: new McpPermissionDenied({ error: error.error, isReadonly: error.isReadonly }) } }) }))
  }
  if (error instanceof ToolCallRejectedError) {
    return createMcpToolCall(new McpToolCall({ result: new McpToolResult({ result: { case: "rejected", value: new McpRejected({ reason: error.message }) } }) }))
  }
  const customError = error instanceof CustomToolCallError ? error : undefined
  const failureText = error instanceof Error ? error.message : String(error)
  return createMcpToolCall(new McpToolCall({ result: new McpToolResult({ result: { case: "error", value: new McpToolError({ error: customError?.clientVisibleErrorMessage ?? "Tool execution error", readToolDefReminder: customError?.modelVisibleErrorMessage ?? failureText }) } }) }))
}

/**
 * The review a call may have to pass before it runs.
 *
 * The classifier is asked about the call as a target, with the project's permissions included, because what
 * is safe to run depends on what the project allows. A shadow run asks the classifier without acting on the
 * answer, which is how the platform measures the classifier before trusting it. A block becomes either an
 * approvalOutcome request or a refusal, and the refusal spells out the two ways forward so the model does not stop
 * where the user has nothing to click.
 */
async function reviewMcpCall(
  toolCtx: Context,
  settings: CreateCallMcpToolOptions,
  args: McpReviewArgs,
): Promise<SmartModeApproval | undefined> {
  if (!args.enabled && !args.shadowEnabled) return undefined
  // A developer can force the next call to be blocked, which is how the refusal path is exercised.
  if (settings.devSmartModeClassifierBlockState?.consume() === true && args.enabled) {
    await delayDevSmartModeClassifierIfRequested(settings.devSmartModeClassifierDelayState)
    throw new ToolCallRejectedError(AUTO_REVIEW_BLOCK_REASON)
  }
  if (!args.enabled) return undefined
  try {
    const toolExecutor = settings.resourceAccessor.get(smartModeClassifierExecutorResource)
    const conversationContext = args.stateHandler === undefined
      ? []
      : settings.extractSmartModeClassifierConversationContext !== undefined
        ? await settings.extractSmartModeClassifierConversationContext(toolCtx, args.stateHandler)
        : await tryExtractSmartModeClassifierConversationContext(toolCtx, args.stateHandler)
    const projectPermissions = await loadSmartModeProjectPermissionsContext(
      toolCtx,
      settings.mcpFileSystemOptions?.workspaceProjectDir === undefined ? undefined : [settings.mcpFileSystemOptions.workspaceProjectDir],
      settings.userAutoRunInstructions,
      settings.projectAutoRunInstructions,
    )
    const target = new SmartModeRiskTarget({
      action: "mcp",
      arguments: Struct.fromJson(jsonObjectOf({
        server: { identifier: args.serverIdentifier, name: args.serverName },
        tool_name: args.toolName,
        mcp_mode: settings.mcpMetaToolOptions?.enabled === true ? "meta_tool" : "file_system",
        arguments: args.mcpArguments,
        tool_definition: args.description === undefined ? undefined : { description: args.description },
        project_permissions: projectPermissions,
      })),
    })
    const parentConversationId = getConversationId(toolCtx)
    const classifierRequest = parentConversationId === undefined
      ? new SmartModeClassifierArgs({ toolCallId: args.toolCallId, target, conversationContext })
      : new SmartModeClassifierArgs({ toolCallId: args.toolCallId, parentConversationId, target, conversationContext })
    const result = await executeSmartModeClassifierWithMeasurement(
      toolCtx,
      toolExecutor,
      classifierRequest,
      "enforce",
      settings.mcpFileSystemOptions?.workspaceProjectDir === undefined ? undefined : [settings.mcpFileSystemOptions.workspaceProjectDir],
      { maxAttempts: settings.smartModeClassifierMaxAttempts, suppressToolCallIdLogging: settings.suppressSmartModeClassifierTelemetryIds },
    )
    // Anything that is not an allow or a block is not an answer, so the call is refused as unclassified.
    if (result.result.case !== "success" || result.result.value.decision !== SmartModeClassifierDecision.BLOCK) {
      if (result.result.case !== "success" || result.result.value.decision !== SmartModeClassifierDecision.ALLOW) throw new ToolCallRejectedError(AUTO_REVIEW_CLASSIFIER_FAILURE_REASON)
      return undefined
    }
    const blockReason = result.result.value.blockReason ?? AUTO_REVIEW_BLOCK_REASON
    return resolveBlockedMcpCall(toolCtx, settings, args, approvalTargetOf(settings, args, blockReason), blockReason)
  } catch (error) {
    // A store that was never configured is a platform bug, not a refusal, so it is raised as it is.
    if (error instanceof Error && error.message === "Auto-review MCP approval store is not configured") throw error
    if (error instanceof ToolCallRejectedError || error instanceof ToolCallAbortedError) throw error
    if (error instanceof Error && error.name === "AbortError") throw error
    throw new ToolCallRejectedError(AUTO_REVIEW_CLASSIFIER_FAILURE_REASON)
  }
}

/** The approval-shaped view of a call the review blocked. */
function approvalTargetOf(settings: CreateCallMcpToolOptions, args: McpReviewArgs, blockReason: string): McpApprovalTarget {
  return {
    serverIdentifier: args.serverIdentifier,
    serverName: args.serverName,
    toolName: args.toolName,
    mcpMode: settings.mcpMetaToolOptions?.enabled === true ? "meta_tool" : "file_system",
    mcpArguments: args.mcpArguments,
    blockReason,
    ...(args.description !== undefined ? { description: args.description } : {}),
  }
}

/**
 * What a blocked call becomes: an approval the user can clear, or a refusal that tells the model the two ways
 * forward. A model that asked for approval gets a card to click; one that did not is told how to ask.
 */
async function resolveBlockedMcpCall(
  toolCtx: Context,
  settings: CreateCallMcpToolOptions,
  args: McpReviewArgs,
  approvalTarget: McpApprovalTarget,
  blockReason: string,
): Promise<SmartModeApproval | undefined> {
  if (settings.smartModeApprovalProvider === undefined && args.requestSmartModeApproval) {
    const parentRefusalReason = args.smartModeBlockReason !== undefined && args.smartModeBlockReason.trim().length > 0
      ? args.smartModeBlockReason.trim()
      : AUTO_REVIEW_PARENT_APPROVAL_FALLBACK
    if (settings.agentType === AgentType.BACKGROUND) throw new ToolCallRejectedError(parentRefusalReason)
    const approvalStore = settings.resourceAccessor.get(smartModeMcpApprovalStoreResource)
    const storedApproval = await createSmartModeMcpApprovalRequest(toolCtx, approvalStore, { ...approvalTarget, blockReason: parentRefusalReason })
    return new SmartModeApproval({ requestId: storedApproval.requestId, reason: storedApproval.blockReason })
  }
  if (settings.smartModeApprovalProvider === undefined) {
    throw new ToolCallRejectedError(`${blockReason}${settings.dynamicToolRegistry === undefined ? AUTO_REVIEW_BLOCKED_SUFFIX : AUTO_REVIEW_DYNAMIC_BLOCKED_SUFFIX}`)
  }
  // Waiting for a user to approve something is not the tool timing out, so the timeout is suspended.
  const approvalOutcome = await withToolExecutionTimeoutSuspended(toolCtx, () => settings.smartModeApprovalProvider!.requestApproval({
    kind: "mcp",
    target: approvalTarget,
    fingerprint: computeSmartModeMcpApprovalTargetFingerprint(approvalTarget),
    toolCallId: args.toolCallId,
    conversationId: getConversationId(toolCtx),
    signal: toolCtx.signal,
  }))
  if (toolCtx.signal.aborted) throw new ToolCallAbortedError()
  if (!approvalOutcome.approved) throw new ToolCallRejectedError(approvalOutcome.reason ?? blockReason)
  return undefined
}

/** A tool from a server, as a tool of its own under the name the provider will accept. */
export function createMcpTool(
  resourceAccessor: ResourceAccessor<RemoteExecManager>,
  mcpToolDefinition: McpToolDefinitionLike,
  settings: { readonly name?: string | undefined; readonly convertTupleSchemaToDraft2020_12?: boolean | undefined } = {},
): Record<string, unknown> {
  const toolExecutor = resourceAccessor.get(mcpExecutorResource)
  const rawSchema = mcpInputSchemaToJson(mcpToolDefinition)
  const toolName = settings.name ?? fitToolName(sanitizeToolName(mcpToolDefinition.name))
  const execute = async (
    parentContext: Context,
    bridge: ToolCallBridge,
    rawArguments: Record<string, unknown>,
    callMeta: McpCallMeta,
  ): Promise<McpToolResult> => {
    using executionSpan = createSpan(parentContext.withName("mcpExecute"))
    const args = mcpArgumentsOf(mcpToolDefinition.providerIdentifier, mcpToolDefinition.providerIdentifier, mcpToolDefinition.toolName, rawArguments, callMeta.toolCallId)
    const baseCall = createMcpToolCall(new McpToolCall({ args }))
    return bridge.executeToolCall(executionSpan.ctx, baseCall, callMeta.toolCallId, async toolCtx => {
      const eventTracker = getAgentEventTracker(toolCtx)
      eventTracker.trackMcpToolCall(toolCtx, { name: mcpToolDefinition.toolName, mcpServerName: mcpToolDefinition.providerIdentifier, origin: "external" })
      const argumentsJson = JSON.stringify(rawArguments)
      try {
        const result = await toolExecutor.execute(toolCtx.with(agentToolExecutionMetaKey, callMeta), args, {
          execId: generateSeededUuid(callMeta.toolCallId),
          ...(callMeta.hookContextCollector !== undefined ? { hookContextCollector: callMeta.hookContextCollector } : {}),
        })
        const projectedResult = convertExecSuccessToToolSuccess(result, undefined, undefined, undefined, undefined)
        eventTracker.trackMcpToolCallResult(toolCtx, { toolName: mcpToolDefinition.toolName, mcpServerName: mcpToolDefinition.providerIdentifier, paramsJson: argumentsJson, success: true })
        return projectedResult
      } catch (error) {
        const classifiedFailure = error instanceof ToolCallError ? error : new Error(error instanceof Error ? error.message : String(error), { cause: error })
        eventTracker.trackMcpToolCallResult(toolCtx, { toolName: mcpToolDefinition.toolName, mcpServerName: mcpToolDefinition.providerIdentifier, paramsJson: argumentsJson, success: false, failureText: classifiedFailure.message, errorClassification: getWrappedMcpErrorClassification(classifiedFailure) })
        // Bad arguments are the one failure the model can fix by looking at the schema, so it is told to.
        if (isInvalidMcpArgumentsError(classifiedFailure)) throw new McpInvalidArgsToolDefinitionReminderError(classifiedFailure, "Inspect this MCP tool's schema before retrying.")
        throw classifiedFailure
      }
    }, result => createMcpToolCall(new McpToolCall({ args, result })), callMeta.hookContextCollector)
  }
  return {
    toolIdentifier: "MCP",
    name: toolName,
    descriptionGenerator: () => mcpToolDefinition.description ?? "",
    parameters: jsonSchema(schemaJsonOf(rawSchema, settings.convertTupleSchemaToDraft2020_12 === true) as Parameters<typeof jsonSchema>[0]),
    render: (_ctx: Context, output: unknown) => renderMcpToolResult(renderedMcpResult(output)),
    execute: async (toolCtx: Context, bridge: unknown, argsStream: AsyncIterable<string>, callMeta: McpCallMeta) => {
      if (!isToolCallBridge(bridge)) throw new Error("MCP execution requires an interaction handler")
      return execute(toolCtx, bridge, await readArgumentObject(argsStream), callMeta)
    },
    serializeError: serializeMcpFailure,
  }
}

/** The one tool that calls any MCP tool by name, for the tools nobody knew about in advance. */
export function createCallMcpTool(settings: CreateCallMcpToolOptions): Record<string, unknown> {
  const useDynamicToolNamespaces = settings.dynamicToolRegistry !== undefined
  const descriptorIndex = indexMcpDescriptors({
    mcpMetaToolEnabled: settings.mcpMetaToolOptions?.enabled === true,
    mcpMetaToolOptions: settings.mcpMetaToolOptions,
    mcpFileSystemOptions: settings.mcpFileSystemOptions,
    allowInteractiveMcpAuth: settings.allowInteractiveMcpAuth,
  })
  const callSchemas = buildMcpCallSchemas({ useDynamicToolNamespaces, smartModeClassifierMode: settings.smartModeClassifierMode === true })
  const name = settings.name ?? "CallMcpTool"
  const execute = async (
    parentContext: Context,
    bridge: ToolCallBridge,
    args: Record<string, unknown>,
    callMeta: McpCallMeta,
  ): Promise<McpToolResult> => {
    using executionSpan = createSpan(parentContext.withName("callMcpToolExecute"))
    const serverIdentifier = typeof args.server === "string" ? args.server : ""
    const toolName = typeof args.toolName === "string" ? args.toolName : ""
    if (settings.validateMcpToolDescriptors === true) assertMcpToolIsCallable(descriptorIndex, serverIdentifier, toolName, settings.getMcpToolsToolName ?? "GetMcpTools", useDynamicToolNamespaces)
    const readCheck = checkToolDefinitionRead(descriptorIndex, settings.mcpMetaToolOptions?.enabled === true, serverIdentifier, toolName, callMeta.stateHandler)
    if (readCheck.kind === "noServer") throw new McpServerDoesNotExistError(readCheck.serverIdentifier, "Discover available MCP servers before calling this tool.")
    if (readCheck.kind === "noTool") throw new McpExecToolNotFoundError(`Tool ${readCheck.toolName} was not found.`)
    const descriptor = descriptorIndex.serverDescriptors.get(serverIdentifier)
    const serverName = descriptor?.serverName ?? serverIdentifier
    const mcpArguments = isJsonObject(args.arguments) ? args.arguments : {}
    // Authenticating a server interactively needs a user in front of it, which this environment is not.
    if (!settings.allowInteractiveMcpAuth && toolName === "mcp_auth") {
      const message = "Interactive MCP authentication is only available in the Slate desktop IDE."
      throw new CustomToolCallError(ToolErrorClassification.UNEXPECTED_ENVIRONMENT, {
        error: message,
        clientVisibleErrorMessage: message,
        modelVisibleErrorMessage: "Interactive MCP authentication is not available in this agent environment. Ask the user to authenticate the MCP server in the Slate desktop IDE, then retry.",
      })
    }
    if (settings.isMcpToolBlocked?.({ serverIdentifier, toolName }) === true) {
      const message = `Tool "${toolName}" on "${serverIdentifier}" is not available in this agent context.`
      throw new CustomToolCallError(ToolErrorClassification.UNEXPECTED_ENVIRONMENT, {
        error: message,
        clientVisibleErrorMessage: message,
        modelVisibleErrorMessage: `${message} It speaks to the end user on the parent agent's behalf and is reserved for the parent agent.`,
      })
    }
    const followedDiscoverySearch = await searchedBeforeCalling(executionSpan.ctx, callMeta.stateHandler)
    const description = typeof args.description === "string" ? args.description : undefined
    const approvalOutcome = await reviewMcpCall(executionSpan.ctx, settings, {
      enabled: settings.smartModeClassifierMode === true,
      shadowEnabled: settings.smartModeClassifierShadowMode === true,
      toolCallId: callMeta.toolCallId,
      ...(callMeta.stateHandler !== undefined ? { stateHandler: callMeta.stateHandler } : {}),
      serverIdentifier,
      serverName,
      toolName,
      mcpArguments,
      ...(description !== undefined ? { description } : {}),
      requestSmartModeApproval: args.requestSmartModeApproval === true,
      ...(typeof args.smartModeBlockReason === "string" ? { smartModeBlockReason: args.smartModeBlockReason } : {}),
    })
    const callArgs = mcpArgumentsOf(serverIdentifier, serverName, toolName, mcpArguments, callMeta.toolCallId, typeof args.description === "string" ? args.description : undefined)
    if (approvalOutcome !== undefined) callArgs.smartModeApproval = approvalOutcome
    const baseCall = createMcpToolCall(new McpToolCall({ args: callArgs, ...(description !== undefined ? { description } : {}) }))
    const toolExecutor = settings.resourceAccessor.get(mcpExecutorResource)
    return bridge.executeToolCall(executionSpan.ctx, baseCall, callMeta.toolCallId, async toolCtx => {
      const eventTracker = getAgentEventTracker(toolCtx)
      const argumentsJson = JSON.stringify(mcpArguments)
      const startedAt = Date.now()
      logger.info(toolCtx, "MCP tool call", { server: serverIdentifier, toolName })
      try {
        if (toolCtx.signal.aborted || bridge.getAbortSignal?.(toolCtx)?.aborted === true) throw new ToolCallAbortedError()
        const result = await toolExecutor.execute(toolCtx.with(agentToolExecutionMetaKey, callMeta), callArgs, {
          execId: generateSeededUuid(callMeta.toolCallId),
          ...(callMeta.hookContextCollector !== undefined ? { hookContextCollector: callMeta.hookContextCollector } : {}),
        })
        const projectedResult = convertExecSuccessToToolSuccess(result, undefined, undefined, settings.mcpFileSystemOptions, settings.getMcpToolsToolName, serverIdentifier)
        eventTracker.trackMcpToolCallResult(toolCtx, { toolName, mcpServerName: serverName, paramsJson: argumentsJson, success: true })
        emitCallMcpToolMetrics(toolCtx, { mcpMode: settings.mcpMetaToolOptions?.enabled === true ? "meta_tool" : "file_system", durationMs: Date.now() - startedAt, success: true })
        if (followedDiscoverySearch) emitMcpSearchThenCallResult(toolCtx, "success")
        return projectedResult
      } catch (error) {
        const classifiedFailure = error instanceof ToolCallError ? error : new Error(error instanceof Error ? error.message : String(error), { cause: error })
        eventTracker.trackMcpToolCallResult(toolCtx, { toolName, mcpServerName: serverName, paramsJson: argumentsJson, success: false, failureText: classifiedFailure.message, errorClassification: getWrappedMcpErrorClassification(classifiedFailure) })
        // The reason is a label rather than a closed union, so a caller may compare it with any of them.
        const failureReason: string = classifiedFailure instanceof ToolCallRejectedError ? CALL_MCP_TOOL_FAILURE_REASONS.REJECTED : CALL_MCP_TOOL_FAILURE_REASONS.OTHER
        emitCallMcpToolMetrics(toolCtx, { mcpMode: settings.mcpMetaToolOptions?.enabled === true ? "meta_tool" : "file_system", durationMs: Date.now() - startedAt, success: false, failureReason, retryable: false })
        if (followedDiscoverySearch) emitMcpSearchThenCallResult(toolCtx, failureReason === CALL_MCP_TOOL_FAILURE_REASONS.TOOL_NOT_FOUND ? "tool_not_found" : "error")
        throw classifiedFailure
      }
    }, result => createMcpToolCall(new McpToolCall({ args: callArgs, result })), callMeta.hookContextCollector)
  }
  return createZodAgentTool("MCP", {
    name,
    parameters: callSchemas.parsingParametersSchema,
    descriptionGenerator: () => "Call an MCP tool by server identifier and tool name with arbitrary JSON arguments.",
    render: (_ctx: Context, output: unknown) => renderMcpToolResult(renderedMcpResult(output)),
    execute: async (toolCtx: Context, bridge: unknown, argsStream: AsyncIterable<string>, callMeta: McpCallMeta) => {
      if (!isToolCallBridge(bridge)) throw new Error("MCP execution requires an interaction handler")
      const args = callSchemas.parsingParametersSchema.parse(JSON.parse(await readArgumentObject(argsStream).then(value => JSON.stringify(value))))
      if (!isJsonObject(args)) throw new Error("MCP call arguments must be a JSON object")
      return execute(toolCtx, bridge, args, callMeta)
    },
    serializeError: serializeMcpFailure,
  })
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** A rendered result that is not one is an empty result rather than a crash. */
function renderedMcpResult(value: unknown): McpToolResult {
  if (value instanceof McpToolResult) return value
  if (isJsonObject(value) && value.result instanceof McpToolResult) return value.result
  return new McpToolResult()
}

void logger
