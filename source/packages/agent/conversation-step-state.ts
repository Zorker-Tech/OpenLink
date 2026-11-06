/** Slate's product shape for one persisted conversation step. */
import { isRedactedString, type RedactedString } from "../redaction/redacted-values.ts"
import type { SlateCheckpointUnknownField } from "./conversation-checkpoint-state.ts"

export interface SlateConversationStepCompatibility {
  readonly legacyUnknownFields?: readonly SlateCheckpointUnknownField[]
}

export interface SlateAssistantMessageStep {
  readonly kind: "assistant-message"
  readonly text: RedactedString
  readonly compatibility?: SlateConversationStepCompatibility
}

export interface SlateThinkingMessageStep {
  readonly kind: "thinking-message"
  readonly text: RedactedString
  readonly durationMs: number
  readonly compatibility?: SlateConversationStepCompatibility
}

export type SlateToolCallText = string | RedactedString

export type SlateConversationSummaryResult =
  | { readonly kind: "success"; readonly summary: SlateToolCallText }
  | { readonly kind: "error"; readonly message: SlateToolCallText }
  | { readonly kind: "unspecified" }

export type SlateProgressUpdateResult =
  | { readonly kind: "success"; readonly currentStep: SlateToolCallText; readonly messageIndex: number }
  | { readonly kind: "error"; readonly message: SlateToolCallText }
  | { readonly kind: "unspecified" }

/** Slate's typed operation for the summary and progress records attached to task turns. */
export type SlateConversationSummaryToolCall =
  | {
      readonly kind: "conversation-summary"
      readonly source: "final"
      readonly args?: { readonly finalSummary?: SlateToolCallText }
      readonly result?: SlateConversationSummaryResult
      readonly case?: undefined
      readonly value?: undefined
    }
  | {
      readonly kind: "conversation-summary"
      readonly source: "progress"
      readonly args?: {
        readonly currentStep?: SlateToolCallText
        readonly finalSummary?: SlateToolCallText
        readonly completedSubtitle?: SlateToolCallText
      }
      readonly result?: SlateProgressUpdateResult
      readonly case?: undefined
      readonly value?: undefined
    }

/** Opaque historical tool data retained while each operation family gets its Slate-owned model. */
export interface SlateLegacyToolCallValue {
  readonly kind?: "legacy"
  readonly case?: string | undefined
  readonly value?: unknown
}

export type SlateToolCallValue = SlateLegacyToolCallValue | SlateConversationSummaryToolCall

export interface SlateStepHookContextEntry {
  readonly event: string
  readonly text: RedactedString
}

export interface SlateToolCallStep {
  readonly kind: "tool-call"
  readonly toolCallId?: string
  readonly startedAtMs?: bigint
  readonly completedAtMs?: bigint
  readonly hookContexts: readonly SlateStepHookContextEntry[]
  readonly tool: SlateToolCallValue
  readonly compatibility?: SlateConversationStepCompatibility
}

export interface SlateUnsupportedConversationStep {
  readonly kind: "unsupported"
  readonly sourceCase?: string
  readonly value?: unknown
  readonly compatibility?: SlateConversationStepCompatibility
}

export type SlateConversationStep =
  | SlateAssistantMessageStep
  | SlateThinkingMessageStep
  | SlateToolCallStep
  | SlateUnsupportedConversationStep

export function createSlateAssistantMessageStep(
  text: RedactedString,
  compatibility?: SlateConversationStepCompatibility,
): SlateAssistantMessageStep {
  return {
    kind: "assistant-message",
    text,
    ...(compatibility === undefined ? {} : { compatibility: cloneStepCompatibility(compatibility) }),
  }
}

export function createSlateThinkingMessageStep(input: {
  readonly text: RedactedString
  readonly durationMs: number
  readonly compatibility?: SlateConversationStepCompatibility
}): SlateThinkingMessageStep {
  return {
    kind: "thinking-message",
    text: input.text,
    durationMs: input.durationMs,
    ...(input.compatibility === undefined ? {} : { compatibility: cloneStepCompatibility(input.compatibility) }),
  }
}

export function createSlateToolCallStep(input: {
  readonly toolCallId?: string
  readonly startedAtMs?: bigint
  readonly completedAtMs?: bigint
  readonly hookContexts?: readonly SlateStepHookContextEntry[]
  readonly tool: SlateToolCallValue
  readonly compatibility?: SlateConversationStepCompatibility
}): SlateToolCallStep {
  return {
    kind: "tool-call",
    ...(input.toolCallId === undefined ? {} : { toolCallId: input.toolCallId }),
    ...(input.startedAtMs === undefined ? {} : { startedAtMs: input.startedAtMs }),
    ...(input.completedAtMs === undefined ? {} : { completedAtMs: input.completedAtMs }),
    hookContexts: [...(input.hookContexts ?? [])],
    tool: input.tool,
    ...(input.compatibility === undefined ? {} : { compatibility: cloneStepCompatibility(input.compatibility) }),
  }
}

export function createSlateConversationSummaryToolCall(input: {
  readonly source: "final"
  readonly args?: { readonly finalSummary?: SlateToolCallText }
  readonly result?: SlateConversationSummaryResult
} | {
  readonly source: "progress"
  readonly args?: {
    readonly currentStep?: SlateToolCallText
    readonly finalSummary?: SlateToolCallText
    readonly completedSubtitle?: SlateToolCallText
  }
  readonly result?: SlateProgressUpdateResult
}): SlateConversationSummaryToolCall {
  const args = input.args === undefined
    ? undefined
    : input.source === "final"
      ? { ...(input.args.finalSummary === undefined ? {} : { finalSummary: input.args.finalSummary }) }
      : {
          ...(input.args.currentStep === undefined ? {} : { currentStep: input.args.currentStep }),
          ...(input.args.finalSummary === undefined ? {} : { finalSummary: input.args.finalSummary }),
          ...(input.args.completedSubtitle === undefined ? {} : { completedSubtitle: input.args.completedSubtitle }),
        }
  const result = input.result === undefined ? undefined : { ...input.result }
  const operation = {
    kind: "conversation-summary",
    source: input.source,
    ...(args === undefined ? {} : { args }),
    ...(result === undefined ? {} : { result }),
  } as SlateConversationSummaryToolCall
  if (!isSlateConversationSummaryToolCall(operation)) {
    throw new TypeError("Slate conversation summary operation is invalid")
  }
  return operation
}

export function isSlateConversationSummaryToolCall(value: unknown): value is SlateConversationSummaryToolCall {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const tool = value as Record<string, unknown>
  if (tool.kind !== "conversation-summary" || (tool.source !== "final" && tool.source !== "progress")) return false
  const allowedToolFields = ["kind", "source", "args", "result"]
  if (Object.keys(tool).some(key => !allowedToolFields.includes(key))) return false
  if (tool.args !== undefined) {
    if (tool.args === null || typeof tool.args !== "object" || Array.isArray(tool.args)) return false
    const args = tool.args as Record<string, unknown>
    const fields = tool.source === "final"
      ? ["finalSummary"]
      : ["currentStep", "finalSummary", "completedSubtitle"]
    if (Object.keys(args).some(key => !fields.includes(key))) return false
    if (fields.some(field => args[field] !== undefined && !isToolCallText(args[field]))) return false
  }
  if (tool.result === undefined) return true
  if (tool.result === null || typeof tool.result !== "object" || Array.isArray(tool.result)) return false
  const result = tool.result as Record<string, unknown>
  if (result.kind === "unspecified") return Object.keys(result).every(key => key === "kind")
  if (result.kind === "error") {
    return Object.keys(result).every(key => key === "kind" || key === "message") &&
      isToolCallText(result.message)
  }
  if (result.kind !== "success") return false
  if (tool.source === "final") {
    return Object.keys(result).every(key => key === "kind" || key === "summary") &&
      isToolCallText(result.summary)
  }
  return Object.keys(result).every(key => key === "kind" || key === "currentStep" || key === "messageIndex") &&
    isToolCallText(result.currentStep) && Number.isInteger(result.messageIndex) &&
    (result.messageIndex as number) >= 0 && (result.messageIndex as number) <= 0xffff_ffff
}

function isToolCallText(value: unknown): value is SlateToolCallText {
  return typeof value === "string" || isRedactedString(value)
}

export function createSlateUnsupportedConversationStep(input: {
  readonly sourceCase?: string
  readonly value?: unknown
  readonly compatibility?: SlateConversationStepCompatibility
} = {}): SlateUnsupportedConversationStep {
  return {
    kind: "unsupported",
    ...(input.sourceCase === undefined ? {} : { sourceCase: input.sourceCase }),
    ...(input.value === undefined ? {} : { value: input.value }),
    ...(input.compatibility === undefined ? {} : { compatibility: cloneStepCompatibility(input.compatibility) }),
  }
}

function cloneStepCompatibility(value: SlateConversationStepCompatibility): SlateConversationStepCompatibility {
  return value.legacyUnknownFields === undefined
    ? {}
    : { legacyUnknownFields: value.legacyUnknownFields.map(field => ({ ...field, path: field.path.map(step => ({ ...step })) })) }
}
