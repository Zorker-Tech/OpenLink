import { isDeepStrictEqual } from "node:util"
import type { JsonValue as ProtocolJsonValue } from "@bufbuild/protobuf"
import {
  ConversationStep,
  InteractionUpdate,
  TaskToolCallDelta,
  ToolCallDelta,
  ToolCallDeltaUpdate,
  type ToolCall,
} from "../proto/generated/agent/v1/agent_pb.ts"
import {
  fromRedactedInteractionUpdate,
  toRedactedInteractionUpdate,
} from "../redacted-protos/generated/agent/v1/agent_redacted.ts"
import type { JsonValue } from "@slate/work-domain"
import { PrivacyCapability } from "../../../packages/redaction/classification.ts"
import type { PrivacyMode } from "../../../packages/redaction/privacy-mode.ts"
import type { SlateInteractionQuery, SlateInteractionResponse } from "../../../packages/agent-core/interaction-queries.ts"
import type {
  SlateTaskProgressCompatibility,
  SlateTaskProgressUpdate,
} from "../../../packages/agent/tools/task-progress-state.ts"
import type { SlateToolCallStep } from "../../../packages/agent/conversation-step-state.ts"
import { fromInteropConversationStep, toPlainInteropConversationStep } from "./agent-state-message-serdes-adapter.ts"
import { fromInteropUserMessage, toInteropUserMessage } from "./user-message-action-protocol-adapter.ts"

type TaskProgressListener<Context> = {
  sendUpdate(context: Context, update: SlateTaskProgressUpdate): Promise<void>
  sendTaskProgressUpdate?(
    context: Context,
    toolCallId: string,
    modelCallId: string,
    update: SlateTaskProgressUpdate,
  ): Promise<void>
  query(context: Context, query: SlateInteractionQuery): Promise<SlateInteractionResponse>
  enqueuePostTurnEndedWork?: ((work: () => Promise<unknown>) => void) | undefined
  flushPostTurnEndedWork?: ((context: Context) => Promise<void>) | undefined
}

type LegacyMessage = { toJson(): JsonValue }

function compatibility(update: InteractionUpdate): SlateTaskProgressCompatibility {
  return { format: "legacy-binary", payload: update.toBinary().slice() }
}

function eventJson(value: unknown): { readonly kind: string; readonly value: JsonValue } | undefined {
  if (value === null || typeof value !== "object") return undefined
  const event = value as { readonly case?: unknown; readonly value?: unknown }
  if (
    typeof event.case !== "string" ||
    event.value === null ||
    typeof event.value !== "object" ||
    !("toJson" in event.value) ||
    typeof event.value.toJson !== "function"
  ) return undefined
  return { kind: event.case, value: (event.value as LegacyMessage).toJson() }
}

function slateToolCallStepFromInterop(value: undefined): undefined
function slateToolCallStepFromInterop(value: ToolCall): SlateToolCallStep
function slateToolCallStepFromInterop(value: ToolCall | undefined): SlateToolCallStep | undefined {
  if (value === undefined) return undefined
  const step = fromInteropConversationStep(new ConversationStep({
    message: { case: "toolCall", value },
  }))
  if (step.kind !== "tool-call") throw new TypeError("Task progress tool call could not be projected")
  return step
}

function interopToolCallFromSlate(value: SlateToolCallStep): ToolCall {
  const step = toPlainInteropConversationStep(value)
  if (step.message.case !== "toolCall") throw new TypeError("Task progress tool call could not be encoded")
  return step.message.value
}

function taskProgressUpdateFromMessage(update: InteractionUpdate): SlateTaskProgressUpdate {
  const compat = compatibility(update)
  const message = update.message
  switch (message.case) {
    case "textDelta":
      return { schemaVersion: 1, kind: "assistant-text", text: message.value.text, serverNotice: message.value.isServerNotice, compatibility: compat }
    case "toolCallStarted":
    case "toolCallCompleted":
      return {
        schemaVersion: 1,
        kind: message.case === "toolCallStarted" ? "tool-call-started" : "tool-call-completed",
        callId: message.value.callId,
        modelCallId: message.value.modelCallId,
        ...(message.value.toolCall === undefined ? {} : { toolCall: slateToolCallStepFromInterop(message.value.toolCall) }),
        compatibility: compat,
      }
    case "thinkingDelta":
      return {
        schemaVersion: 1,
        kind: "reasoning-text",
        text: message.value.text,
        ...(message.value.thinkingStyle === undefined ? {} : { style: message.value.thinkingStyle }),
        compatibility: compat,
      }
    case "thinkingCompleted":
      return { schemaVersion: 1, kind: "reasoning-completed", durationMs: message.value.thinkingDurationMs, compatibility: compat }
    case "userMessageAppended":
      return {
        schemaVersion: 1,
        kind: "user-message-appended",
        ...(message.value.userMessage === undefined ? {} : { message: fromInteropUserMessage(message.value.userMessage) }),
        compatibility: compat,
      }
    case "partialToolCall":
      return {
        schemaVersion: 1,
        kind: "tool-arguments-progress",
        callId: message.value.callId,
        modelCallId: message.value.modelCallId,
        argumentsDelta: message.value.argsTextDelta,
        ...(message.value.toolCall === undefined ? {} : { toolCall: slateToolCallStepFromInterop(message.value.toolCall) }),
        compatibility: compat,
      }
    case "tokenDelta":
      return { schemaVersion: 1, kind: "token-count", tokens: message.value.tokens, compatibility: compat }
    case "summary":
      return { schemaVersion: 1, kind: "summary-progress", text: message.value.summary, compatibility: compat }
    case "summaryStarted":
      return { schemaVersion: 1, kind: "summary-started", compatibility: compat }
    case "summaryCompleted":
      return {
        schemaVersion: 1,
        kind: "summary-completed",
        ...(message.value.hookMessage === undefined ? {} : { hookMessage: message.value.hookMessage }),
        compatibility: compat,
      }
    case "shellOutputDelta": {
      const output = eventJson(message.value.event)
      return { schemaVersion: 1, kind: "shell-output-progress", ...(output === undefined ? {} : { output }), compatibility: compat }
    }
    case "heartbeat":
      return { schemaVersion: 1, kind: "heartbeat", compatibility: compat }
    case "turnEnded": {
      const value = message.value
      const usage = {
        ...(value.inputTokens === undefined ? {} : { inputTokens: value.inputTokens.toString() }),
        ...(value.outputTokens === undefined ? {} : { outputTokens: value.outputTokens.toString() }),
        ...(value.cacheReadTokens === undefined ? {} : { cacheReadTokens: value.cacheReadTokens.toString() }),
        ...(value.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: value.cacheWriteTokens.toString() }),
        ...(value.reasoningTokens === undefined ? {} : { reasoningTokens: value.reasoningTokens.toString() }),
      }
      return {
        schemaVersion: 1,
        kind: "turn-ended",
        ...(Object.keys(usage).length === 0 ? {} : { usage }),
        compatibility: compat,
      }
    }
    case "toolCallDelta": {
      const delta = message.value.toolCallDelta
      if (delta?.delta.case === "taskToolCallDelta" && delta.delta.value.interactionUpdate !== undefined) {
        const nestedMessage = delta.delta.value.interactionUpdate
        const nestedUpdate = nestedMessage.message.case === undefined &&
          InteractionUpdate.runtime.bin.listUnknownFields(nestedMessage).length === 0
          ? { schemaVersion: 1 as const, kind: "unrecognized" as const }
          : taskProgressUpdateFromMessage(nestedMessage)
        return {
          schemaVersion: 1,
          kind: "nested-task-progress",
          toolCallId: message.value.callId,
          modelCallId: message.value.modelCallId,
          update: nestedUpdate,
          compatibility: compat,
        }
      }
      return {
        schemaVersion: 1,
        kind: "tool-call-progress",
        callId: message.value.callId,
        modelCallId: message.value.modelCallId,
        ...(message.value.toolCallDelta === undefined ? {} : { delta: message.value.toolCallDelta.toJson() }),
        compatibility: compat,
      }
    }
    case "stepStarted":
      return { schemaVersion: 1, kind: "step-started", stepId: message.value.stepId.toString(), compatibility: compat }
    case "stepCompleted":
      return {
        schemaVersion: 1,
        kind: "step-completed",
        stepId: message.value.stepId.toString(),
        durationMs: message.value.stepDurationMs.toString(),
        compatibility: compat,
      }
    case "promptSuggestion":
      return { schemaVersion: 1, kind: "prompt-suggestion", suggestion: message.value.suggestion, compatibility: compat }
    case "postRequestPrompt":
      return {
        schemaVersion: 1,
        kind: "post-request-prompt",
        title: message.value.title,
        message: message.value.message,
        buttonLabel: message.value.buttonLabel,
        buttonUrl: message.value.buttonUrl,
        compatibility: compat,
      }
    case "activeBranchChange":
      return {
        schemaVersion: 1,
        kind: "branch-changed",
        path: message.value.path,
        branchName: message.value.branchName,
        compatibility: compat,
      }
    case "feedbackRequest":
      return {
        schemaVersion: 1,
        kind: "feedback-request",
        requestId: message.value.requestId,
        ...(message.value.canonicalModelName === undefined ? {} : { canonicalModelName: message.value.canonicalModelName }),
        categories: message.value.categories.map(category => category.toJson()),
        categoryGroups: message.value.categoryGroups.map(group => group.toJson()),
        showImmediately: message.value.showFormImmediately,
        ...(message.value.title === undefined ? {} : { title: message.value.title }),
        ...(message.value.negativeTitle === undefined ? {} : { negativeTitle: message.value.negativeTitle }),
        ...(message.value.commentPlaceholder === undefined ? {} : { commentPlaceholder: message.value.commentPlaceholder }),
        compatibility: compat,
      }
    case "responseComparison": {
      const event = eventJson(message.value.event)
      return {
        schemaVersion: 1,
        kind: "model-comparison",
        comparisonId: message.value.comparisonId,
        ...(event === undefined ? {} : { event }),
        compatibility: compat,
      }
    }
    case "contextInjectionState": {
      const state = eventJson(message.value.state?.state)
      return {
        schemaVersion: 1,
        kind: "context-injection-state",
        injectionId: message.value.injectionId,
        ...(state === undefined ? {} : { state }),
        compatibility: compat,
      }
    }
    case "routedModel":
      return { schemaVersion: 1, kind: "routed-model", displayName: message.value.displayName, compatibility: compat }
    default:
      if (InteractionUpdate.runtime.bin.listUnknownFields(update).length === 0) {
        throw new TypeError("Task progress update has no recognized event")
      }
      return { schemaVersion: 1, kind: "unrecognized", compatibility: compat }
  }
}

export function slateTaskProgressUpdateFromInterop(value: unknown): SlateTaskProgressUpdate {
  if (!(value instanceof InteractionUpdate)) throw new TypeError("Task progress update is invalid")
  return taskProgressUpdateFromMessage(value)
}

function semanticFields(value: SlateTaskProgressUpdate): unknown {
  const { compatibility: _compatibility, ...semantic } = value
  return semantic
}

function legacyJsonFromSlate(value: SlateTaskProgressUpdate): JsonValue {
  switch (value.kind) {
    case "assistant-text":
      return { textDelta: { text: value.text, isServerNotice: value.serverNotice } }
    case "tool-call-started":
    case "tool-call-completed":
      return {
        [value.kind === "tool-call-started" ? "toolCallStarted" : "toolCallCompleted"]: {
          callId: value.callId,
          modelCallId: value.modelCallId,
          ...(value.toolCall === undefined ? {} : { toolCall: interopToolCallFromSlate(value.toolCall).toJson() }),
        },
      }
    case "reasoning-text":
      return { thinkingDelta: { text: value.text, ...(value.style === undefined ? {} : { thinkingStyle: value.style }) } }
    case "reasoning-completed":
      return { thinkingCompleted: { thinkingDurationMs: value.durationMs } }
    case "user-message-appended":
      return { userMessageAppended: value.message === undefined ? {} : { userMessage: toInteropUserMessage(value.message).toJson() } }
    case "tool-arguments-progress":
      return {
        partialToolCall: {
          callId: value.callId,
          modelCallId: value.modelCallId,
          argsTextDelta: value.argumentsDelta,
          ...(value.toolCall === undefined ? {} : { toolCall: interopToolCallFromSlate(value.toolCall).toJson() }),
        },
      }
    case "token-count":
      return { tokenDelta: { tokens: value.tokens } }
    case "summary-progress":
      return { summary: { summary: value.text } }
    case "summary-started":
      return { summaryStarted: {} }
    case "summary-completed":
      return { summaryCompleted: value.hookMessage === undefined ? {} : { hookMessage: value.hookMessage } }
    case "shell-output-progress":
      return { shellOutputDelta: value.output === undefined ? {} : { [value.output.kind]: value.output.value } }
    case "heartbeat":
      return { heartbeat: {} }
    case "turn-ended":
      return {
        turnEnded: value.usage === undefined
          ? {}
          : {
              ...(value.usage.inputTokens === undefined ? {} : { inputTokens: value.usage.inputTokens }),
              ...(value.usage.outputTokens === undefined ? {} : { outputTokens: value.usage.outputTokens }),
              ...(value.usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: value.usage.cacheReadTokens }),
              ...(value.usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: value.usage.cacheWriteTokens }),
              ...(value.usage.reasoningTokens === undefined ? {} : { reasoningTokens: value.usage.reasoningTokens }),
            },
      }
    case "tool-call-progress":
      return {
        toolCallDelta: {
          callId: value.callId,
          modelCallId: value.modelCallId,
          ...(value.delta === undefined ? {} : { toolCallDelta: value.delta }),
        },
      }
    case "nested-task-progress":
      throw new TypeError("Nested task progress requires the structured message encoder")
    case "step-started":
      return { stepStarted: { stepId: value.stepId } }
    case "step-completed":
      return { stepCompleted: { stepId: value.stepId, stepDurationMs: value.durationMs } }
    case "prompt-suggestion":
      return { promptSuggestion: { suggestion: value.suggestion } }
    case "post-request-prompt":
      return {
        postRequestPrompt: {
          title: value.title,
          message: value.message,
          buttonLabel: value.buttonLabel,
          buttonUrl: value.buttonUrl,
        },
      }
    case "branch-changed":
      return { activeBranchChange: { path: value.path, branchName: value.branchName } }
    case "feedback-request":
      return {
        feedbackRequest: {
          requestId: value.requestId,
          ...(value.canonicalModelName === undefined ? {} : { canonicalModelName: value.canonicalModelName }),
          categories: [...value.categories],
          categoryGroups: [...value.categoryGroups],
          showFormImmediately: value.showImmediately,
          ...(value.title === undefined ? {} : { title: value.title }),
          ...(value.negativeTitle === undefined ? {} : { negativeTitle: value.negativeTitle }),
          ...(value.commentPlaceholder === undefined ? {} : { commentPlaceholder: value.commentPlaceholder }),
        },
      }
    case "model-comparison":
      return {
        responseComparison: {
          comparisonId: value.comparisonId,
          ...(value.event === undefined ? {} : { [value.event.kind]: value.event.value }),
        },
      }
    case "context-injection-state":
      return {
        contextInjectionState: {
          injectionId: value.injectionId,
          ...(value.state === undefined ? {} : { state: { [value.state.kind]: value.state.value } }),
        },
      }
    case "routed-model":
      return { routedModel: { displayName: value.displayName } }
    case "unrecognized":
      throw new TypeError("An unrecognized task progress event requires compatibility data")
  }
}

export function slateTaskProgressUpdateToInterop(value: unknown): InteractionUpdate {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Task progress update is invalid")
  }
  const update = value as SlateTaskProgressUpdate
  if (update.schemaVersion !== 1 || typeof update.kind !== "string") {
    throw new TypeError("Task progress update is invalid")
  }

  if (update.kind === "nested-task-progress" && update.compatibility === undefined) {
    const nestedUpdate = slateTaskProgressUpdateToInterop(update.update)
    return new InteractionUpdate({
      message: {
        case: "toolCallDelta",
        value: new ToolCallDeltaUpdate({
          callId: update.toolCallId,
          modelCallId: update.modelCallId,
          toolCallDelta: new ToolCallDelta({
            delta: {
              case: "taskToolCallDelta",
              value: new TaskToolCallDelta({ interactionUpdate: nestedUpdate }),
            },
          }),
        }),
      },
    })
  }

  if (update.compatibility !== undefined) {
    if (
      update.compatibility === null ||
      typeof update.compatibility !== "object" ||
      update.compatibility.format !== "legacy-binary" ||
      !(update.compatibility.payload instanceof Uint8Array)
    ) {
      throw new TypeError("Task progress update is invalid")
    }
    let interop: InteractionUpdate
    try {
      interop = InteractionUpdate.fromBinary(update.compatibility.payload)
    } catch (cause) {
      throw new TypeError("Task progress compatibility data is invalid", { cause })
    }
    const restored = taskProgressUpdateFromMessage(interop)
    if (!isDeepStrictEqual(semanticFields(restored), semanticFields(update))) {
      throw new TypeError("Task progress fields do not match their compatibility data")
    }
    return interop
  }

  try {
    return InteractionUpdate.fromJson(legacyJsonFromSlate(update) as unknown as ProtocolJsonValue)
  } catch (cause) {
    throw new TypeError("Slate task progress fields are invalid", { cause })
  }
}

/** Removes the private migration bytes and applies the same field redaction policy as the interaction stream. */
export function taskProgressUpdateForListener(
  update: SlateTaskProgressUpdate,
  privacyMode: PrivacyMode,
): SlateTaskProgressUpdate | undefined {
  if (update.compatibility === undefined && hasUnrecognizedTaskProgress(update)) return undefined
  const legacy = slateTaskProgressUpdateToInterop(update)
  const redacted = toRedactedInteractionUpdate(legacy, privacyMode)
  const projected = (fromRedactedInteractionUpdate as unknown as (
    value: ReturnType<typeof toRedactedInteractionUpdate>,
    purpose: PrivacyCapability,
    options: { readonly redactUnallowedFieldsInsteadOfThrowing: true; readonly enforcing: true },
  ) => InteractionUpdate)(redacted, PrivacyCapability.STORAGE_FOR_TRAINING, {
    redactUnallowedFieldsInsteadOfThrowing: true,
    enforcing: true,
  })
  if (projected.message.case === undefined && InteractionUpdate.runtime.bin.listUnknownFields(projected).length === 0) return undefined
  const safeUpdate = taskProgressUpdateFromMessage(projected)
  return safeUpdate
}

function hasUnrecognizedTaskProgress(update: SlateTaskProgressUpdate): boolean {
  if (update.kind === "unrecognized") return update.compatibility === undefined
  return update.kind === "nested-task-progress" && hasUnrecognizedTaskProgress(update.update)
}

export function createTaskProgressListenerInterop<Context>(listener: TaskProgressListener<Context>) {
  return {
    async sendUpdate(context: Context, update: InteractionUpdate): Promise<void> {
      await listener.sendUpdate(context, slateTaskProgressUpdateFromInterop(update))
    },
    sendTaskProgressUpdate: listener.sendTaskProgressUpdate
      ? (context: Context, toolCallId: string, modelCallId: string, update: SlateTaskProgressUpdate) =>
          listener.sendTaskProgressUpdate?.(context, toolCallId, modelCallId, update)
      : undefined,
    query(context: Context, query: SlateInteractionQuery): Promise<SlateInteractionResponse> {
      return listener.query(context, query)
    },
    enqueuePostTurnEndedWork: listener.enqueuePostTurnEndedWork,
    flushPostTurnEndedWork: listener.flushPostTurnEndedWork,
  }
}
