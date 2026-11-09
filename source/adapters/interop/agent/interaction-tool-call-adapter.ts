import { ToolCall } from "../proto/generated/agent/v1/agent_pb.ts"
import { EditArgs } from "../proto/generated/agent/v1/edit_tool_pb.ts"
import { HookAdditionalContext } from "../proto/generated/agent/v1/hook_additional_context_pb.ts"
import { fromRedactedToolCall, toRedactedToolCall } from "../redacted-protos/generated/agent/v1/agent_redacted.ts"
import { PrivacyCapability } from "../../../packages/redaction/classification.ts"
import type { PrivacyMode } from "../../../packages/redaction/privacy-mode.ts"
import { createSlateToolCallStep, type SlateToolCallStep, type SlateToolCallValue } from "../../../packages/agent/conversation-step-state.ts"
import type { SlateInteractionToolCallValue } from "../../../packages/agent-core/interaction-update-contracts.ts"
import { fromInteropToolCallStep, toInteropConversationStep } from "./agent-state-message-serdes-adapter.ts"

function projectSlateInteractionToolCallFromInterop(value: unknown, toolCallId?: string): SlateInteractionToolCallValue {
  if (typeof value !== "object" || value === null || !("tool" in value)) {
    throw new TypeError("Tool-call update must contain a tool value")
  }
  const step = fromInteropToolCallStep(value as never, toolCallId)
  if (step.kind !== "tool-call") throw new TypeError("Tool-call update could not be projected into Slate state")
  const tool = step.tool as SlateToolCallValue & { readonly case?: string; readonly value?: unknown }
  const slateTool: SlateToolCallValue = "kind" in tool
    ? tool
    : {
        kind: "legacy",
        ...(tool.case === undefined ? {} : { case: tool.case }),
        ...(Object.prototype.hasOwnProperty.call(tool, "value") ? { value: tool.value } : {}),
      }
  return {
    ...(step.toolCallId === undefined ? {} : { toolCallId: step.toolCallId }),
    ...(step.startedAtMs === undefined ? {} : { startedAtMs: step.startedAtMs }),
    ...(step.completedAtMs === undefined ? {} : { completedAtMs: step.completedAtMs }),
    hookContexts: step.hookContexts.map(context => ({ event: context.event, text: context.text as never })),
    tool: slateTool,
  }
}

function conversationStepForSlateToolCall(value: SlateInteractionToolCallValue): SlateToolCallStep {
  return createSlateToolCallStep({
    ...(value.toolCallId === undefined ? {} : { toolCallId: value.toolCallId }),
    ...(value.startedAtMs === undefined ? {} : { startedAtMs: value.startedAtMs }),
    ...(value.completedAtMs === undefined ? {} : { completedAtMs: value.completedAtMs }),
    hookContexts: value.hookContexts.map(context => ({ event: context.event, text: context.text as never })),
    tool: value.tool,
  })
}

/** Projects generated tool values into the existing Slate tool-call domain, retaining unmapped values explicitly. */
export function slateInteractionToolCallValueFromInterop(value: unknown, toolCallId?: string): SlateInteractionToolCallValue {
  return projectSlateInteractionToolCallFromInterop(value, toolCallId)
}

/** Rebuilds the client-side projection payload only at its adapter boundary. */
export function interopToolCallFromSlateInteractionValue(value: SlateInteractionToolCallValue): ToolCall {
  const step = toInteropConversationStep(conversationStepForSlateToolCall(value))
  if (step.message.case !== "toolCall") throw new TypeError("Slate tool-call value did not encode as a tool call")
  return step.message.value
}

/** Converts Slate hook context entries into the persisted call's adapter-only representation. */
export function hookAdditionalContextsToInterop(values: readonly unknown[]): HookAdditionalContext[] {
  return values.map((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new TypeError("Slate hook context must be an object")
    }
    const entry = value as Record<string, unknown>
    const hookEventName = typeof entry.event === "string" ? entry.event : entry.hookEventName
    const content = typeof entry.text === "string" ? entry.text : entry.content
    if (typeof hookEventName !== "string" || typeof content !== "string") {
      throw new TypeError("Slate hook context must contain an event and text")
    }
    return new HookAdditionalContext({ hookEventName, content })
  })
}

/** Applies the field-specific privacy policy to Slate tool-call text through the schema adapter. */
export function redactSlateInteractionToolCallValue(
  value: SlateInteractionToolCallValue,
  privacyMode: PrivacyMode,
): SlateInteractionToolCallValue {
  return projectSlateInteractionToolCallFromInterop(
    toRedactedToolCall(interopToolCallFromSlateInteractionValue(value), privacyMode),
    value.toolCallId,
  )
}

/** Reveals a redacted Slate tool-call snapshot only for the local listener projection. */
export function unredactSlateInteractionToolCallValue(value: SlateInteractionToolCallValue): SlateInteractionToolCallValue {
  return projectSlateInteractionToolCallFromInterop(
    fromRedactedToolCall(
      interopToolCallFromSlateInteractionValue(value) as never,
      PrivacyCapability.UNSAFE_ALWAYS_ALLOWED,
      {},
    ),
    value.toolCallId,
  )
}

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
