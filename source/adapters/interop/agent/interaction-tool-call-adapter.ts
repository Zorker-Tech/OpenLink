import { ToolCall } from "../proto/generated/agent/v1/agent_pb.ts"
import { EditArgs } from "../proto/generated/agent/v1/edit_tool_pb.ts"
import { toRedactedToolCall } from "../redacted-protos/generated/agent/v1/agent_redacted.ts"
import type { PrivacyMode } from "../../../packages/redaction/privacy-mode.ts"

function assertToolCall(value: unknown): ToolCall {
  if (value instanceof ToolCall && typeof value.clone === "function" && typeof value.toBinary === "function") return value
  const constructorName = typeof value === "object" && value !== null
    ? Object.getPrototypeOf(value)?.constructor?.name ?? "unknown"
    : typeof value
  const keys = typeof value === "object" && value !== null ? Object.keys(value).sort().join(",") : ""
  throw new TypeError(`tool call carrier is not agent.v1.ToolCall (constructor=${constructorName}; keys=${keys})`)
}

/** Validates an incoming generated call before it crosses the Slate interaction port. */
export function assertToolCallInterop(value: unknown): unknown {
  return assertToolCall(value)
}

/** Preserves the latest streamed arguments for selected tool cases when a call fails. */
export function mergeLatestToolCallArgsInterop(previousValue: unknown, incomingValue: unknown): unknown {
  const previousCall = assertToolCall(previousValue)
  const incomingCall = assertToolCall(incomingValue)
  if (previousCall.tool.case !== incomingCall.tool.case) return incomingCall
  const combinedCall = incomingCall.clone()
  if (combinedCall.tool.case === "createAgentToolCall" && previousCall.tool.case === "createAgentToolCall") {
    const latestArgs = previousCall.tool.value.args
    if (latestArgs !== undefined) combinedCall.tool.value.args = latestArgs.clone()
    return combinedCall
  }
  if (combinedCall.tool.case === "sendToAgentToolCall" && previousCall.tool.case === "sendToAgentToolCall") {
    const latestArgs = previousCall.tool.value.args
    if (latestArgs !== undefined) combinedCall.tool.value.args = latestArgs.clone()
    return combinedCall
  }
  if (combinedCall.tool.case === "editToolCall" && previousCall.tool.case === "editToolCall") {
    const latestArgs = previousCall.tool.value.args
    if (latestArgs === undefined) return combinedCall
    const mergedArgs = combinedCall.tool.value.args
    if (mergedArgs === undefined) {
      combinedCall.tool.value.args = latestArgs.clone()
      return combinedCall
    }
    if (mergedArgs.path.length === 0 && latestArgs.path.length > 0) mergedArgs.path = latestArgs.path
    if (mergedArgs.streamContent === undefined && latestArgs.streamContent !== undefined) mergedArgs.streamContent = latestArgs.streamContent
  }
  return combinedCall
}

/** Appends streamed edit text to the last tool-call message while arguments are being preserved. */
export function appendEditToolCallDeltaInterop(previousValue: unknown, deltaValue: unknown): void {
  const previousCall = previousValue as ToolCall | undefined
  const delta = deltaValue as { readonly delta?: { readonly case?: string; readonly value?: { readonly streamContentDelta?: string } } }
  if (previousCall?.tool.case !== "editToolCall" || delta.delta?.case !== "editToolCallDelta") return
  const editToolCall = previousCall.tool.value
  editToolCall.args ??= new EditArgs()
  editToolCall.args.streamContent = (editToolCall.args.streamContent ?? "") + (delta.delta.value?.streamContentDelta ?? "")
}

/** Stamps the external tool-call envelope with the call identity and lifecycle times. */
export function stampToolCallMetadataInterop(
  callId: string,
  value: unknown,
  timestamps?: { readonly startedAtMs?: number | undefined; readonly completedAtMs?: number | undefined },
): unknown {
  const pendingCall = assertToolCall(value)
  const startedAtMs = timestamps?.startedAtMs !== undefined ? BigInt(timestamps.startedAtMs) : undefined
  const completedAtMs = timestamps?.completedAtMs !== undefined ? BigInt(timestamps.completedAtMs) : undefined
  if (pendingCall.toolCallId === callId && (startedAtMs === undefined || pendingCall.startedAtMs === startedAtMs) && (completedAtMs === undefined || pendingCall.completedAtMs === completedAtMs)) return pendingCall
  const stamped = pendingCall.clone()
  stamped.toolCallId = callId
  if (startedAtMs !== undefined) stamped.startedAtMs = startedAtMs
  if (completedAtMs !== undefined) stamped.completedAtMs = completedAtMs
  return stamped
}

export function redactInteractionToolCallInterop(value: unknown, mode: PrivacyMode): unknown {
  return toRedactedToolCall(value as ToolCall, mode)
}

export function isAskQuestionToolCallInterop(value: unknown): boolean {
  return (value as ToolCall | undefined)?.tool.case === "askQuestionToolCall"
}

export function toolCallNameInterop(value: unknown): string {
  return (value as ToolCall | undefined)?.tool?.case ?? "unknown"
}
