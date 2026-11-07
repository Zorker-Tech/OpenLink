import {
  AwaitArgs,
  AwaitError,
  AwaitResult,
  AwaitSuccess,
  AwaitTaskComplete,
  AwaitTaskStillRunning,
  AwaitToolCall,
} from "../proto/generated/agent/v1/await_tool_pb.ts"
import { ToolCall } from "../proto/generated/agent/v1/agent_pb.ts"
import type { Context } from "../../../packages/context/context.ts"
import type { RemoteExecManager } from "../../../packages/agent-exec/executor-resources.ts"
import type { ResourceAccessor } from "../../../packages/agent-exec/resource-provider.ts"
import { readExecutorResource, type ReadExecutorArgs } from "../../../packages/agent-exec/read-operation.ts"
import { lsExecutorResource, type LsExecutorArgs, type SlateDirectoryTreeNode } from "../../../packages/agent-exec/ls.ts"
import { slateSubagentAwaitExecutorResource } from "../../../packages/agent-exec/subagent-await.ts"

export interface AwaitRequestView {
  readonly taskId: string
  readonly blockUntilMs: number
  readonly pattern?: string
}

export type AwaitResultView =
  | {
      readonly kind: "complete"
      readonly taskId: string
      readonly runtimeMs: number | bigint
      readonly outputFilePath: string
      readonly outputLength: number | bigint
      readonly regexRequested?: boolean
      readonly regexMatch?: string
      readonly exitCode?: number
      readonly wakeReason?: string
    }
  | {
      readonly kind: "still-running"
      readonly taskId: string
      readonly runtimeMs: number | bigint
      readonly outputFilePath: string
      readonly outputLength: number | bigint
      readonly regexRequested?: boolean
      readonly regexMatch?: string
      readonly wakeReason?: string
    }
  | { readonly kind: "error"; readonly error: string }
  | { readonly kind: "unknown" }

export interface AwaitJobFileSnapshot {
  readonly exists: boolean
  readonly content: string
  readonly outputLength: number
}

export interface AwaitDirectoryNode {
  readonly absPath: string
  readonly childrenFiles: readonly { readonly name: string }[]
  readonly childrenDirs: readonly AwaitDirectoryNode[]
}

export interface AwaitSubagentRequestView {
  readonly bounded: boolean
  readonly taskId: string
  readonly timeoutMs: number
}

export interface AwaitSubagentOutcomeView {
  readonly hasTranscriptPathField: boolean
  readonly transcriptPath?: string
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Constructs the tool-call envelope handed to the interaction recorder. */
export function createAwaitToolCallInterop(request: AwaitRequestView, result?: AwaitResultView): unknown {
  return new ToolCall({
    tool: {
      case: "awaitToolCall",
      value: new AwaitToolCall({
        args: new AwaitArgs({
          taskId: request.taskId,
          blockUntilMs: request.blockUntilMs,
          ...(request.pattern === undefined ? {} : { regex: request.pattern }),
        }),
        ...(result === undefined ? {} : { result: createAwaitResultInterop(result) as AwaitResult }),
      }),
    },
  })
}

export function createAwaitErrorToolCallInterop(error: string): unknown {
  return new ToolCall({
    tool: {
      case: "awaitToolCall",
      value: new AwaitToolCall({
        result: new AwaitResult({ result: { case: "error", value: new AwaitError({ error }) } }),
      }),
    },
  })
}

export function createAwaitResultInterop(view: AwaitResultView): unknown {
  switch (view.kind) {
    case "complete":
      return new AwaitResult({
        result: {
          case: "success",
          value: new AwaitSuccess({
            awaitResult: {
              case: "complete",
              value: new AwaitTaskComplete({
                taskId: view.taskId,
                runtimeMs: BigInt(view.runtimeMs),
                outputFilePath: view.outputFilePath,
                outputLength: BigInt(view.outputLength),
                ...(view.regexRequested === undefined ? {} : { regexRequested: view.regexRequested }),
                ...(view.regexMatch === undefined ? {} : { regexMatch: view.regexMatch }),
                ...(view.exitCode === undefined ? {} : { exitCode: view.exitCode }),
                ...(view.wakeReason === undefined ? {} : { wakeReason: view.wakeReason }),
              }),
            },
          }),
        },
      })
    case "still-running":
      return new AwaitResult({
        result: {
          case: "success",
          value: new AwaitSuccess({
            awaitResult: {
              case: "stillRunning",
              value: new AwaitTaskStillRunning({
                taskId: view.taskId,
                runtimeMs: BigInt(view.runtimeMs),
                outputFilePath: view.outputFilePath,
                outputLength: BigInt(view.outputLength),
                ...(view.regexRequested === undefined ? {} : { regexRequested: view.regexRequested }),
                ...(view.regexMatch === undefined ? {} : { regexMatch: view.regexMatch }),
                ...(view.wakeReason === undefined ? {} : { wakeReason: view.wakeReason }),
              }),
            },
          }),
        },
      })
    case "error":
      return new AwaitResult({ result: { case: "error", value: new AwaitError({ error: view.error }) } })
    case "unknown":
      return new AwaitResult()
  }
}

/** Projects the wire result into the four outcomes the Slate wait tool renders. */
export function projectAwaitResultInterop(value: unknown): AwaitResultView {
  const result = (value as AwaitResult | undefined)?.result
  if (result?.case === "error") return { kind: "error", error: result.value.error }
  if (result?.case !== "success") return { kind: "unknown" }
  const outcome = result.value.awaitResult
  if (outcome?.case === "complete") {
    return {
      kind: "complete",
      taskId: outcome.value.taskId,
      runtimeMs: outcome.value.runtimeMs,
      outputFilePath: outcome.value.outputFilePath,
      outputLength: outcome.value.outputLength,
      ...(outcome.value.regexRequested === undefined ? {} : { regexRequested: outcome.value.regexRequested }),
      ...(outcome.value.regexMatch === undefined ? {} : { regexMatch: outcome.value.regexMatch }),
      ...(outcome.value.exitCode === undefined ? {} : { exitCode: outcome.value.exitCode }),
      ...(outcome.value.wakeReason === undefined ? {} : { wakeReason: outcome.value.wakeReason }),
    }
  }
  if (outcome?.case === "stillRunning") {
    return {
      kind: "still-running",
      taskId: outcome.value.taskId,
      runtimeMs: outcome.value.runtimeMs,
      outputFilePath: outcome.value.outputFilePath,
      outputLength: outcome.value.outputLength,
      ...(outcome.value.regexRequested === undefined ? {} : { regexRequested: outcome.value.regexRequested }),
      ...(outcome.value.regexMatch === undefined ? {} : { regexMatch: outcome.value.regexMatch }),
      ...(outcome.value.wakeReason === undefined ? {} : { wakeReason: outcome.value.wakeReason }),
    }
  }
  return { kind: "unknown" }
}

export function createAwaitReadRequest(path: string, toolCallId: string): ReadExecutorArgs {
  return { path, toolCallId }
}

export async function readAwaitJobFileInterop(
  ctx: Context,
  resourceAccessor: ResourceAccessor<RemoteExecManager>,
  path: string,
  toolCallId: string,
): Promise<AwaitJobFileSnapshot> {
  const executor = resourceAccessor.get(readExecutorResource)
  const result = await executor.execute(ctx, createAwaitReadRequest(path, toolCallId))
  if (result.kind === "success") {
    const output = result.output
    const content = output?.kind === "text" ? output.text : output?.kind === "data" ? Buffer.from(output.bytes).toString("utf8") : ""
    const outputLength = Number(result.fileSize)
    return { exists: true, content, outputLength: Number.isFinite(outputLength) && outputLength > 0 ? outputLength : content.length }
  }
  if (result.kind === "not-found") return { exists: false, content: "", outputLength: 0 }
  if (result.kind === "permission-denied") throw new Error(`Permission denied reading ${path}`)
  if (result.kind === "rejected") throw new Error(result.reason || `Read rejected for ${path}`)
  if (result.kind === "invalid-file") throw new Error(result.reason || `Invalid file: ${path}`)
  if (result.kind === "error") throw new Error(result.error || `Read failed for ${path}`)
  throw new Error(`Unknown read result for ${path}`)
}

export function createAwaitLsRequest(path: string, toolCallId: string): LsExecutorArgs {
  return { path, toolCallId, timeoutMs: 2_000 }
}

function directoryNode(node: SlateDirectoryTreeNode): AwaitDirectoryNode {
  return {
    absPath: node.absPath,
    childrenFiles: node.childrenFiles.map(file => ({ name: file.name })),
    childrenDirs: node.childrenDirs.map(directoryNode),
  }
}

export async function listAwaitDirectoryTreeInterop(
  ctx: Context,
  resourceAccessor: ResourceAccessor<RemoteExecManager>,
  path: string,
  toolCallId: string,
): Promise<AwaitDirectoryNode | undefined> {
  const executor = resourceAccessor.get(lsExecutorResource)
  const result = await executor.execute(ctx, createAwaitLsRequest(path, toolCallId)).catch(() => undefined)
  if (result === undefined || (result.kind !== "success" && result.kind !== "timeout")) return undefined
  return result.root === undefined ? undefined : directoryNode(result.root)
}

export async function runAwaitSubagentInterop(
  ctx: Context,
  resourceAccessor: ResourceAccessor<RemoteExecManager>,
  input: AwaitSubagentRequestView,
): Promise<AwaitSubagentOutcomeView> {
  const request = input.bounded
    ? { agentId: input.taskId, bounded: true as const, timeoutMs: input.timeoutMs }
    : { agentId: input.taskId, bounded: false as const }
  const result = await resourceAccessor.get(slateSubagentAwaitExecutorResource).execute(ctx, request)
  if (result.kind !== "complete") throw new Error("Failed to await subagent task")
  return {
    hasTranscriptPathField: result.transcriptPathKnown,
    ...(result.transcriptPath === undefined ? {} : { transcriptPath: result.transcriptPath }),
  }
}
