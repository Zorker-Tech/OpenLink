/** Slate's product shape for one persisted conversation step. */
import type { RedactedString } from "../redaction/redacted-values.ts"

export interface SlateAssistantMessageStep {
  readonly kind: "assistant-message"
  readonly text: RedactedString
}

export interface SlateThinkingMessageStep {
  readonly kind: "thinking-message"
  readonly text: RedactedString
  readonly durationMs: number
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
}

export interface SlateUnsupportedConversationStep {
  readonly kind: "unsupported"
  readonly sourceCase?: string
  readonly value?: unknown
}

export type SlateConversationStep =
  | SlateAssistantMessageStep
  | SlateThinkingMessageStep
  | SlateToolCallStep
  | SlateUnsupportedConversationStep

export function createSlateAssistantMessageStep(text: RedactedString): SlateAssistantMessageStep {
  return { kind: "assistant-message", text }
}

export function createSlateThinkingMessageStep(input: {
  readonly text: RedactedString
  readonly durationMs: number
}): SlateThinkingMessageStep {
  return {
    kind: "thinking-message",
    text: input.text,
    durationMs: input.durationMs,
  }
}

export function createSlateToolCallStep(input: {
  readonly toolCallId?: string
  readonly startedAtMs?: bigint
  readonly completedAtMs?: bigint
  readonly hookContexts?: readonly SlateStepHookContextEntry[]
  readonly tool: SlateToolCallValue
}): SlateToolCallStep {
  return {
    kind: "tool-call",
    ...(input.toolCallId === undefined ? {} : { toolCallId: input.toolCallId }),
    ...(input.startedAtMs === undefined ? {} : { startedAtMs: input.startedAtMs }),
    ...(input.completedAtMs === undefined ? {} : { completedAtMs: input.completedAtMs }),
    hookContexts: [...(input.hookContexts ?? [])],
    tool: input.tool,
  }
}
