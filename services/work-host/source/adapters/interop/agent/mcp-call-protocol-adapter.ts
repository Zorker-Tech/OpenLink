import { Struct, Value, type JsonValue } from "@bufbuild/protobuf"
import { McpArgs, McpPermissionDenied, McpRejected } from "../proto/generated/agent/v1/mcp_exec_pb.ts"
import { McpToolCall, McpToolError, McpToolResult } from "../proto/generated/agent/v1/mcp_tool_pb.ts"
import { SmartModeApproval } from "../proto/generated/agent/v1/utils_pb.ts"
import { SmartModeClassifierArgs, SmartModeClassifierDecision, SmartModeRiskTarget, type SmartModeClassifierResult } from "../proto/generated/agent/v1/smart_mode_classifier_exec_pb.ts"
import type { Context } from "../../../packages/context/context.ts"
import type { RemoteExecManager } from "../../../packages/agent-exec/executor-resources.ts"
import type { ResourceAccessor } from "../../../packages/agent-exec/resource-provider.ts"
import { mcpExecutorResource } from "../../../packages/agent-exec/mcp-operations.ts"
import { smartModeClassifierExecutorResource } from "../../../packages/agent-exec/smart-mode-classifier-operation.ts"
import type { HookContextEntry } from "../../../packages/hooks-carriers/hook-additional-context.ts"
import { executeSmartModeClassifierWithMeasurement } from "./smart-mode-classifier-measurement-adapter.ts"
import { createMcpToolCall } from "./mcp-result-adapter.ts"

export interface McpApprovalView {
  readonly requestId: string
  readonly reason: string
}

export interface McpCallRequestView {
  readonly serverIdentifier: string
  readonly serverName: string
  readonly toolName: string
  readonly arguments: Record<string, unknown>
  readonly toolCallId: string
  readonly description?: string
  readonly approval?: McpApprovalView
}

export type McpClassifierDecisionView =
  | { readonly kind: "allow" }
  | { readonly kind: "block"; readonly blockReason?: string }
  | { readonly kind: "unclassified" }

export type McpToolFailureView =
  | { readonly kind: "permission-denied"; readonly error: string; readonly isReadonly: boolean }
  | { readonly kind: "rejected"; readonly reason: string }
  | { readonly kind: "error"; readonly error: string; readonly readToolDefReminder: string }

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

function jsonObjectOf(value: unknown): Record<string, JsonValue> {
  const jsonValue = jsonValueOf(value)
  return jsonValue !== undefined && jsonValue !== null && typeof jsonValue === "object" && !Array.isArray(jsonValue) ? jsonValue : {}
}

/** Builds the external MCP executor request after Slate has decided to run a call. */
export function createMcpArgsInterop(input: McpCallRequestView): unknown {
  const values: Record<string, Value> = {}
  for (const [key, value] of Object.entries(input.arguments)) {
    const jsonValue = jsonValueOf(value)
    if (jsonValue !== undefined) values[key] = Value.fromJson(jsonValue)
  }
  return new McpArgs({
    name: `${input.serverIdentifier}-${input.toolName}`,
    args: values,
    toolCallId: input.toolCallId,
    providerIdentifier: input.serverName,
    toolName: input.toolName,
    serverIdentifier: input.serverIdentifier,
    ...(input.approval === undefined ? {} : {
      smartModeApproval: new SmartModeApproval({ requestId: input.approval.requestId, reason: input.approval.reason }),
    }),
  })
}

export async function executeMcpCallInterop(
  ctx: Context,
  resourceAccessor: ResourceAccessor<RemoteExecManager>,
  request: McpCallRequestView,
  execId: string,
  hookContextCollector?: HookContextEntry[],
): Promise<unknown> {
  return resourceAccessor.get(mcpExecutorResource).execute(ctx, createMcpArgsInterop(request) as never, {
    execId,
    ...(hookContextCollector === undefined ? {} : { hookContextCollector }),
  })
}

/** Wraps an external MCP result and the Slate request in the generated tool-call envelope. */
export function createMcpToolCallInterop(input: {
  readonly request: McpCallRequestView
  readonly result?: unknown
}): unknown {
  return createMcpToolCall(new McpToolCall({
    args: createMcpArgsInterop(input.request) as McpArgs,
    ...(input.request.description === undefined ? {} : { description: input.request.description }),
    ...(input.result === undefined ? {} : { result: input.result as McpToolResult }),
  }))
}

export function createMcpFailureToolCallInterop(failure: McpToolFailureView): unknown {
  switch (failure.kind) {
    case "permission-denied":
      return createMcpToolCall(new McpToolCall({ result: new McpToolResult({ result: { case: "permissionDenied", value: new McpPermissionDenied({ error: failure.error, isReadonly: failure.isReadonly }) } }) }))
    case "rejected":
      return createMcpToolCall(new McpToolCall({ result: new McpToolResult({ result: { case: "rejected", value: new McpRejected({ reason: failure.reason }) } }) }))
    case "error":
      return createMcpToolCall(new McpToolCall({ result: new McpToolResult({ result: { case: "error", value: new McpToolError({ error: failure.error, readToolDefReminder: failure.readToolDefReminder }) } }) }))
  }
}

export async function classifyMcpCallInterop(input: {
  readonly ctx: Context
  readonly resourceAccessor: ResourceAccessor<RemoteExecManager>
  readonly toolCallId: string
  readonly parentConversationId?: string
  readonly targetArguments: unknown
  readonly conversationContext: readonly { readonly role: string; readonly content: string }[]
  readonly workspacePaths?: readonly string[]
  readonly maxAttempts?: number
  readonly suppressToolCallIdLogging?: boolean
}): Promise<McpClassifierDecisionView> {
  const executor = input.resourceAccessor.get(smartModeClassifierExecutorResource)
  const args = new SmartModeClassifierArgs({
    toolCallId: input.toolCallId,
    ...(input.parentConversationId === undefined ? {} : { parentConversationId: input.parentConversationId }),
    target: new SmartModeRiskTarget({ action: "mcp", arguments: Struct.fromJson(jsonObjectOf(input.targetArguments)) }),
    conversationContext: [...input.conversationContext],
  })
  const result: SmartModeClassifierResult = await executeSmartModeClassifierWithMeasurement(
    input.ctx,
    executor,
    args,
    "enforce",
    input.workspacePaths,
    { maxAttempts: input.maxAttempts, suppressToolCallIdLogging: input.suppressToolCallIdLogging },
  )
  if (result.result.case !== "success") return { kind: "unclassified" }
  if (result.result.value.decision === SmartModeClassifierDecision.ALLOW) return { kind: "allow" }
  if (result.result.value.decision === SmartModeClassifierDecision.BLOCK) {
    return {
      kind: "block",
      ...(result.result.value.blockReason === undefined ? {} : { blockReason: result.result.value.blockReason }),
    }
  }
  return { kind: "unclassified" }
}
