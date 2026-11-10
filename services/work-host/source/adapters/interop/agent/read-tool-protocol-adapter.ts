/** Keep generated transcript messages at the edge; the workspace reader uses Slate's own contract. */

import type { Context } from "../../../packages/context/context.ts"
import type { ResourceAccessor } from "../../../packages/agent-exec/resource-provider.ts"
import type { RemoteExecManager } from "../../../packages/agent-exec/executor-resources.ts"
import {
  readExecutorResource,
  redactedReadExecutorResource,
  type ReadExecutorResult,
} from "../../../packages/agent-exec/read-operation.ts"
import type { HookContextEntry } from "../../../packages/hooks-carriers/hook-additional-context.ts"
import type {
  ReadConversationPort,
  ReadExecutionRequest,
  ReadExecutionResultModel,
  ReadExecutorOptions,
  ReadExecutorPort,
  ReadOutputModel,
  ReadRangeModel,
  ReadRuleModel,
  ReadToolCallModel,
  ReadToolResultModel,
  ReadToolSuccessModel,
} from "../../../packages/agent/tools/core/read/read-contract.ts"
import {
  ReadRange,
  ReadToolArgs,
  ReadToolCall,
  ReadToolError,
  ReadToolResult,
  ReadToolSuccess,
} from "../proto/generated/agent/v1/read_tool_pb.ts"
import { ToolCall } from "../proto/generated/agent/v1/agent_pb.ts"
import { CursorRule } from "../proto/generated/agent/v1/rules_pb.ts"

type RecordValue = Record<string, unknown>
const modelByInteropSuccess = new WeakMap<object, ReadToolSuccessModel>()

function recordOf(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === "object" ? value as RecordValue : undefined
}

function stringField(value: RecordValue, key: string): string {
  const field = value[key]
  return typeof field === "string" ? field : ""
}

function numberField(value: RecordValue, key: string): number {
  const field = value[key]
  return typeof field === "number" || typeof field === "bigint" ? Number(field) : 0
}

function booleanField(value: RecordValue, key: string): boolean {
  return value[key] === true
}

function bytesField(value: unknown): Uint8Array | undefined {
  return value instanceof Uint8Array ? value : undefined
}

function decodeRange(value: unknown): ReadRangeModel | undefined {
  const range = recordOf(value)
  if (range === undefined) return undefined
  return { startLine: numberField(range, "startLine"), endLine: numberField(range, "endLine") }
}

function decodeRule(value: unknown): ReadRuleModel | undefined {
  const rule = recordOf(value)
  if (rule === undefined) return undefined
  const fullPath = stringField(rule, "fullPath")
  return { ...(fullPath === "" ? {} : { fullPath }), content: stringField(rule, "content") }
}

function decodeReadOutput(value: unknown): ReadOutputModel | undefined {
  const output = recordOf(value)
  if (output === undefined) return undefined
  const variant = output.case
  if (variant === "content" && typeof output.value === "string") return { case: variant, value: output.value }
  if (variant === "data" || variant === "dataBlobId" || variant === "contentBlobId") {
    const bytes = bytesField(output.value)
    if (bytes !== undefined) return { case: variant, value: bytes }
  }
  return undefined
}

function decodeToolSuccess(value: unknown): ReadToolSuccessModel | undefined {
  const success = recordOf(value)
  if (success === undefined) return undefined
  const originalModel = modelByInteropSuccess.get(success)
  if (originalModel !== undefined) return originalModel
  const relatedRules = Array.isArray(success.relatedCursorRules)
    ? success.relatedCursorRules.flatMap(rule => {
      const decoded = decodeRule(rule)
      return decoded === undefined ? [] : [decoded]
    })
    : []
  const relatedRulePaths = Array.isArray(success.relatedCursorRulePaths)
    ? success.relatedCursorRulePaths.filter((path): path is string => typeof path === "string")
    : []
  const readRange = decodeRange(success.readRange)
  const output = decodeReadOutput(success.output)
  return {
    path: stringField(success, "path"),
    isEmpty: booleanField(success, "isEmpty"),
    exceededLimit: booleanField(success, "exceededLimit"),
    totalLines: numberField(success, "totalLines"),
    fileSize: numberField(success, "fileSize"),
    relatedRules,
    relatedRulePaths,
    ...(readRange === undefined ? {} : { readRange }),
    ...(typeof success.includeLineNumbers === "boolean" ? { includeLineNumbers: success.includeLineNumbers } : {}),
    ...(output === undefined ? {} : { output }),
  }
}

/** Decodes the counterpart tool result into the read feature's own result contract. */
export function fromInteropReadToolResult(value: unknown): ReadToolResultModel {
  const result = recordOf(recordOf(value)?.result)
  if (result === undefined) return {}
  if (result.case === "success") {
    const success = decodeToolSuccess(result.value)
    return success === undefined ? {} : { result: { case: "success", value: success } }
  }
  if (result.case === "error") {
    const error = recordOf(result.value)
    return { result: { case: "error", value: { errorMessage: error === undefined ? "" : stringField(error, "errorMessage") } } }
  }
  return { result: { case: undefined } }
}

export function fromInteropReadRules(values: readonly unknown[]): ReadRuleModel[] {
  return values.flatMap(value => {
    const rule = decodeRule(value)
    return rule === undefined ? [] : [rule]
  })
}

function encodeRange(range: ReadRangeModel | undefined): ReadRange | undefined {
  return range === undefined ? undefined : new ReadRange({ startLine: range.startLine, endLine: range.endLine })
}

function encodeToolSuccess(success: ReadToolSuccessModel): ReadToolSuccess {
  const readRange = encodeRange(success.readRange)
  const encoded = new ReadToolSuccess({
    ...(success.output === undefined ? {} : { output: success.output }),
    ...(success.isEmpty === undefined ? {} : { isEmpty: success.isEmpty }),
    ...(success.exceededLimit === undefined ? {} : { exceededLimit: success.exceededLimit }),
    ...(success.totalLines === undefined ? {} : { totalLines: success.totalLines }),
    ...(success.fileSize === undefined ? {} : { fileSize: success.fileSize }),
    path: success.path,
    ...(readRange === undefined ? {} : { readRange }),
    ...(success.includeLineNumbers === undefined ? {} : { includeLineNumbers: success.includeLineNumbers }),
    ...(success.relatedRulePaths === undefined ? {} : { relatedCursorRulePaths: success.relatedRulePaths }),
    ...(success.relatedRules === undefined ? {} : {
      relatedCursorRules: success.relatedRules.map(rule => new CursorRule({
        ...(rule.fullPath === undefined ? {} : { fullPath: rule.fullPath }),
        content: rule.content,
      })),
    }),
  })
  modelByInteropSuccess.set(encoded, success)
  return encoded
}

/** Encodes Slate's result at the existing agent-tool boundary. */
export function toInteropReadToolResult(value: ReadToolResultModel): ReadToolResult {
  switch (value.result?.case) {
    case "success":
      return new ReadToolResult({ result: { case: "success", value: encodeToolSuccess(value.result.value) } })
    case "error":
      return new ReadToolResult({ result: { case: "error", value: new ReadToolError(value.result.value) } })
    default:
      return new ReadToolResult()
  }
}

/** Converts one Slate call into the counterpart's generated transcript envelope. */
export function toInteropReadToolCall(value: ReadToolCallModel): ToolCall {
  const call = new ReadToolCall({
    ...(value.args === undefined ? {} : { args: new ReadToolArgs({
      path: value.args.path,
      ...(value.args.offset === undefined ? {} : { offset: value.args.offset }),
      ...(value.args.limit === undefined ? {} : { limit: value.args.limit }),
      ...(value.args.includeLineNumbers === undefined ? {} : { includeLineNumbers: value.args.includeLineNumbers }),
    }) }),
    ...(value.result === undefined ? {} : { result: toInteropReadToolResult(value.result) }),
  })
  return new ToolCall({ tool: { case: "readToolCall", value: call } })
}

export function toInteropReadToolErrorCall(message: string): ToolCall {
  return toInteropReadToolCall({ result: { result: { case: "error", value: { errorMessage: message } } } })
}

/** Binds the executor resource while keeping generated request and response messages private here. */
export function createReadExecutorPort(
  resourceAccessor: ResourceAccessor<RemoteExecManager>,
  preferRedactedRead: boolean,
): ReadExecutorPort {
  const executor = resourceAccessor.get(preferRedactedRead ? redactedReadExecutorResource : readExecutorResource)
  return {
    async execute(context: Context, request: ReadExecutionRequest, options: ReadExecutorOptions): Promise<ReadExecutionResultModel> {
      const result = await executor.execute(context, {
        path: request.path,
        toolCallId: request.toolCallId,
        ...(request.offset === undefined ? {} : { offset: request.offset }),
        ...(request.limit === undefined ? {} : { limit: request.limit }),
      }, {
        execId: options.execId,
        ...(options.hookContextCollector === undefined ? {} : { hookContextCollector: options.hookContextCollector }),
      })
      return decodeReadExecutionResult(result)
    },
  }
}

function decodeReadExecutionResult(value: ReadExecutorResult): ReadExecutionResultModel {
  switch (value.kind) {
    case "success": {
      return {
        result: {
          case: "success",
          value: {
            path: value.path,
            totalLines: value.totalLines,
            fileSize: Number(value.fileSize),
            rangeApplied: value.rangeApplied,
            ...(value.output === undefined ? {} : {
              output: value.output.kind === "text"
                ? { case: "content" as const, value: value.output.text }
                : { case: "data" as const, value: value.output.bytes },
            }),
            ...(value.outputBlobId === undefined ? {} : { outputBlobId: value.outputBlobId }),
          },
        },
      }
    }
    case "error": return { result: { case: "error", value: { error: value.error } } }
    case "rejected": return { result: { case: "rejected", value: { reason: value.reason } } }
    case "not-found": return { result: { case: "fileNotFound", value: { path: value.path } } }
    case "permission-denied": return { result: { case: "permissionDenied", value: { path: value.path } } }
    case "invalid-file": return { result: { case: "invalidFile", value: { reason: value.reason } } }
    case "unrecognized": return { result: { case: undefined } }
  }
}

interface InteropReadInteractionHandler {
  executeToolCall(
    context: Context,
    call: ToolCall,
    callId: string,
    execute: (context: Context) => Promise<ReadToolResult>,
    merge: (result: ReadToolResult) => ToolCall,
    hookContextCollector?: HookContextEntry[],
  ): Promise<ReadToolResult>
}

/** Bridges the existing transcript interaction callback to Slate's read call/result model. */
export function createReadConversationPort(value: unknown): ReadConversationPort {
  const candidate = recordOf(value)
  if (typeof candidate?.executeToolCall !== "function") throw new TypeError("Read interaction handler is unavailable")
  const handler = candidate as unknown as InteropReadInteractionHandler
  return {
    async executeToolCall(context, call, callId, execute, hookContextCollector) {
      const result = await handler.executeToolCall(
        context,
        toInteropReadToolCall(call),
        callId,
        async executeContext => toInteropReadToolResult(await execute(executeContext)),
        wireResult => toInteropReadToolCall({ ...call, result: fromInteropReadToolResult(wireResult) }),
        hookContextCollector,
      )
      return fromInteropReadToolResult(result)
    },
  }
}
