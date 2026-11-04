/** Slate's product shape for one persisted conversation step. */
import type { RedactedString } from "../redaction/redacted-values.ts"
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

export interface SlateToolCallValue {
  readonly case?: string | undefined
  readonly value?: unknown
}

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
