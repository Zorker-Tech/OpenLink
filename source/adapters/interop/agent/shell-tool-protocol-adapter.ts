/** Encodes Slate shell tool calls for the model and transcript interaction boundary. */

import { Struct, type JsonValue } from "@bufbuild/protobuf"
import { ToolCall } from "../proto/generated/agent/v1/agent_pb.ts"
import { ShellArgs } from "../proto/generated/agent/v1/shell_exec_pb.ts"
import { ShellToolCall } from "../proto/generated/agent/v1/shell_tool_pb.ts"
import {
  SmartModeClassifierArgs,
  SmartModeClassifierDecision,
  SmartModeRiskTarget,
  type SmartModeClassifierResult,
} from "../proto/generated/agent/v1/smart_mode_classifier_exec_pb.ts"
import type { ShellExecResponse } from "../../../packages/agent-exec/shell.ts"
import { shellExecutorArgsToInterop, shellResultToInterop } from "./shell-operation-adapter.ts"
import type { Context } from "../../../packages/context/context.ts"
import type { HookContextEntry } from "../../../packages/hooks-carriers/hook-additional-context.ts"
import type { ShellToolInteractionPort, SlateShellToolCall } from "../../../packages/agent/tools/core/shell/shell-tool-contract.ts"

export type SmartModeClassifierDecisionView =
  | { readonly kind: "allow" }
  | { readonly kind: "unknown" }
  | { readonly kind: "block"; readonly reason?: string; readonly proposedAllowRule?: string }

export function createSmartModeRiskTargetInterop(input: {
  readonly action: string
  readonly arguments: Record<string, unknown>
}): InstanceType<typeof SmartModeRiskTarget> {
  return new SmartModeRiskTarget({
    action: input.action,
    arguments: Struct.fromJson(toJsonRecord(input.arguments)),
  })
}

export function createSmartModeClassifierArgsInterop(input: {
  readonly toolCallId: string
  readonly parentConversationId?: string
  readonly target: InstanceType<typeof SmartModeRiskTarget>
  readonly conversationContext: readonly unknown[]
}): InstanceType<typeof SmartModeClassifierArgs> {
  return new SmartModeClassifierArgs({
    toolCallId: input.toolCallId,
    ...(input.parentConversationId === undefined ? {} : { parentConversationId: input.parentConversationId }),
    target: input.target,
    conversationContext: [...input.conversationContext] as never,
  })
}

export function projectSmartModeClassifierDecisionInterop(
  result: SmartModeClassifierResult,
): SmartModeClassifierDecisionView {
  if (result.result.case !== "success") return { kind: "unknown" }
  switch (result.result.value.decision) {
    case SmartModeClassifierDecision.ALLOW:
      return { kind: "allow" }
    case SmartModeClassifierDecision.BLOCK:
      return {
        kind: "block",
        ...(result.result.value.blockReason === undefined ? {} : { reason: result.result.value.blockReason }),
        ...(result.result.value.proposedAllowRule === undefined ? {} : { proposedAllowRule: result.result.value.proposedAllowRule }),
      }
    default:
      return { kind: "unknown" }
  }
}

/** Encodes Slate's own shell call and execution result for model/transcript consumers. */
export function shellToolCallToInterop(call: SlateShellToolCall): ToolCall {
  return new ToolCall({
    tool: {
      case: "shellToolCall",
      value: new ShellToolCall({
        ...(call.args === undefined ? {} : { args: shellExecutorArgsToInterop(call.args) }),
        ...(call.result === undefined ? {} : { result: shellResultToInterop(call.result) }),
      }),
    },
  })
}

/** The streamed-argument placeholder is encoded only when it enters the interaction handler. */
export function emptyShellToolCallInterop(): ToolCall {
  return new ToolCall({ tool: { case: "shellToolCall", value: new ShellToolCall({ args: new ShellArgs() }) } })
}

interface InteropShellToolInteractionHandler {
  executeToolCall(
    context: Context,
    call: ToolCall,
    callId: string,
    run: (context: Context) => Promise<ShellExecResponse>,
    merge: (result: ShellExecResponse) => ToolCall,
    hookContexts?: readonly HookContextEntry[],
  ): Promise<ShellExecResponse>
  getAbortSignal(context: Context): AbortSignal
  emitPartialToolCall?(context: Context, callId: string, call: ToolCall): Promise<void>
}

/** Keeps generated transcript objects at the interaction-handler boundary. */
export function shellToolInteractionPortFromInterop(handler: unknown): ShellToolInteractionPort {
  const interop = handler as InteropShellToolInteractionHandler
  return {
    executeToolCall(context, call, callId, run, merge, hookContexts) {
      return interop.executeToolCall(
        context,
        shellToolCallToInterop(call),
        callId,
        run,
        result => shellToolCallToInterop(merge(result)),
        hookContexts,
      )
    },
    getAbortSignal(context) {
      return interop.getAbortSignal(context)
    },
    ...(interop.emitPartialToolCall === undefined ? {} : {
      emitPartialToolCall(context: Context, callId: string, call: SlateShellToolCall) {
        return interop.emitPartialToolCall!(context, callId, shellToolCallToInterop(call))
      },
    }),
  }
}

function toJsonRecord(value: Record<string, unknown>): Record<string, JsonValue> {
  const result: Record<string, JsonValue> = {}
  for (const [key, entry] of Object.entries(value)) {
    const json = toJsonValue(entry)
    if (json !== undefined) result[key] = json
  }
  return result
}

function toJsonValue(value: unknown): JsonValue | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return value
  if (Array.isArray(value)) {
    const values = value.map(toJsonValue)
    return values.some((item) => item === undefined) ? undefined : values as JsonValue[]
  }
  if (typeof value === "object") return toJsonRecord(value as Record<string, unknown>)
  return undefined
}
