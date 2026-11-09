import { ToolCall, ToolCallDelta } from "../proto/generated/agent/v1/agent_pb.ts"
import { EditArgs, EditToolCallDelta } from "../proto/generated/agent/v1/edit_tool_pb.ts"
import { HookAdditionalContext } from "../proto/generated/agent/v1/hook_additional_context_pb.ts"
import { ReplaceEnvToolCallDelta } from "../proto/generated/agent/v1/replace_env_tool_pb.ts"
import { ShellToolCallDelta, ShellToolCallStderrDelta, ShellToolCallStdoutDelta } from "../proto/generated/agent/v1/shell_tool_pb.ts"
import {
  fromRedactedToolCall,
  fromRedactedToolCallDelta,
  toRedactedToolCall,
  toRedactedToolCallDelta,
} from "../redacted-protos/generated/agent/v1/agent_redacted.ts"
import { PrivacyCapability } from "../../../packages/redaction/classification.ts"
import type { PrivacyMode } from "../../../packages/redaction/privacy-mode.ts"
import { isRedactedString } from "../../../packages/redaction/redacted-values.ts"
import { createSlateToolCallStep, type SlateToolCallStep, type SlateToolCallText, type SlateToolCallValue } from "../../../packages/agent/conversation-step-state.ts"
import type { SlateInteractionToolCallValue } from "../../../packages/agent-core/interaction-update-contracts.ts"
import type { SlateToolCallDeltaValue } from "../../../packages/agent-core/interaction-update-contracts.ts"
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

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function legacyToolCallDelta(
  sourceCase?: string,
  value?: unknown,
  includeValue = value !== undefined,
): SlateToolCallDeltaValue {
  return {
    kind: "legacy",
    ...(sourceCase === undefined ? {} : { sourceCase }),
    ...(includeValue ? { value } : {}),
  }
}

/** Projects simple streamed operation deltas into Slate values and quarantines nested historical payloads. */
export function slateToolCallDeltaValueFromInterop(value: unknown): SlateToolCallDeltaValue | undefined {
  if (value === undefined) return undefined
  const envelope = recordOf(value)
  if (envelope === undefined) return legacyToolCallDelta(undefined, value)
  const operation = recordOf(envelope.delta)
  if (operation === undefined) return legacyToolCallDelta(undefined, value)
  const payload = recordOf(operation.value)
  switch (operation.case) {
    case "editToolCallDelta":
      if (payload !== undefined && (typeof payload.streamContentDelta === "string" || isRedactedString(payload.streamContentDelta))) {
        return { kind: "edit-content", textDelta: payload.streamContentDelta }
      }
      return legacyToolCallDelta(operation.case, operation.value, Object.prototype.hasOwnProperty.call(operation, "value"))
    case "shellToolCallDelta": {
      const stream = recordOf(payload?.delta)
      const streamValue = recordOf(stream?.value)
      if ((stream?.case === "stdout" || stream?.case === "stderr") &&
          streamValue !== undefined && (typeof streamValue.content === "string" || isRedactedString(streamValue.content))) {
        return {
          kind: "shell-output",
          stream: stream.case,
          text: streamValue.content,
        }
      }
      return legacyToolCallDelta(operation.case, operation.value, Object.prototype.hasOwnProperty.call(operation, "value"))
    }
    case "replaceEnvToolCallDelta":
      if (payload !== undefined && (typeof payload.associatedPodKey === "string" || isRedactedString(payload.associatedPodKey))) {
        return { kind: "environment-assignment", environmentId: payload.associatedPodKey }
      }
      return legacyToolCallDelta(operation.case, operation.value, Object.prototype.hasOwnProperty.call(operation, "value"))
    case "taskToolCallDelta":
      return legacyToolCallDelta(
        operation.case,
        operation.value,
        Object.prototype.hasOwnProperty.call(operation, "value"),
      )
    default:
      return typeof operation.case === "string"
        ? legacyToolCallDelta(operation.case, operation.value, Object.prototype.hasOwnProperty.call(operation, "value"))
        : legacyToolCallDelta(undefined, value, true)
  }
}

function plainDeltaText(value: SlateToolCallText): string {
  return isRedactedString(value) ? value.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED) : value
}

/** Reconstructs the transient generated delta only where the existing interop and redaction machinery needs it. */
export function interopToolCallDeltaFromSlateValue(value: SlateToolCallDeltaValue): ToolCallDelta {
  switch (value.kind) {
    case "edit-content":
      return new ToolCallDelta({
        delta: { case: "editToolCallDelta", value: new EditToolCallDelta({ streamContentDelta: plainDeltaText(value.textDelta) }) },
      })
    case "shell-output":
      return new ToolCallDelta({
        delta: {
          case: "shellToolCallDelta",
          value: new ShellToolCallDelta({
            delta: value.stream === "stdout"
              ? { case: "stdout", value: new ShellToolCallStdoutDelta({ content: plainDeltaText(value.text) }) }
              : { case: "stderr", value: new ShellToolCallStderrDelta({ content: plainDeltaText(value.text) }) },
          }),
        },
      })
    case "environment-assignment":
      return new ToolCallDelta({
        delta: {
          case: "replaceEnvToolCallDelta",
          value: new ReplaceEnvToolCallDelta({ associatedPodKey: plainDeltaText(value.environmentId) }),
        },
      })
    case "legacy":
      if (value.sourceCase === undefined) {
        return value.value instanceof ToolCallDelta ? value.value.clone() : new ToolCallDelta()
      }
      return new ToolCallDelta({ delta: { case: value.sourceCase, value: value.value } as never })
  }
}

function redactedInteropToolCallDeltaFromSlateValue(value: SlateToolCallDeltaValue): unknown {
  switch (value.kind) {
    case "edit-content":
      return { delta: { case: "editToolCallDelta", value: { streamContentDelta: value.textDelta } } }
    case "shell-output":
      return {
        delta: {
          case: "shellToolCallDelta",
          value: {
            delta: {
              case: value.stream,
              value: { content: value.text },
            },
          },
        },
      }
    case "environment-assignment":
      return { delta: { case: "replaceEnvToolCallDelta", value: { associatedPodKey: value.environmentId } } }
    case "legacy":
      return value.sourceCase === undefined
        ? { delta: { case: undefined, value: undefined } }
        : { delta: { case: value.sourceCase, ...(Object.hasOwn(value, "value") ? { value: value.value } : {}) } }
  }
}

/** Applies the generated field-level privacy policy to a Slate delta at the one owning boundary. */
export function redactSlateToolCallDeltaValue(value: SlateToolCallDeltaValue, privacyMode: PrivacyMode): SlateToolCallDeltaValue {
  return slateToolCallDeltaValueFromInterop(
    toRedactedToolCallDelta(interopToolCallDeltaFromSlateValue(value), privacyMode),
  ) ?? { kind: "legacy" }
}

/** Reveals a redacted delta only for the listener's explicit in-process projection. */
export function unredactSlateToolCallDeltaValue(value: SlateToolCallDeltaValue): SlateToolCallDeltaValue {
  const plain = fromRedactedToolCallDelta(
    redactedInteropToolCallDeltaFromSlateValue(value) as never,
    PrivacyCapability.UNSAFE_ALWAYS_ALLOWED,
    {},
  )
  return slateToolCallDeltaValueFromInterop(plain) ?? { kind: "legacy" }
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
