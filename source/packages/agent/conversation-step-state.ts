/** Slate's product shape for one persisted conversation step. */
import { isRedactedString, type RedactedString } from "../redaction/redacted-values.ts"
import type {
  SlateAskQuestionAnswer,
  SlateAskQuestionArguments,
  SlateAskQuestionText,
} from "./actions/ask-question-completion.ts"
import type { SlateTodoStatus } from "./tools/core/todo/contracts.ts"
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

export interface SlateAskQuestionToolArguments extends SlateAskQuestionArguments {
  readonly responseMode: "blocking" | "deferred"
  readonly originalCallId: string
}

export type SlateAskQuestionToolOutcome =
  | { readonly kind: "answered"; readonly answers: readonly SlateAskQuestionAnswer[] }
  | { readonly kind: "error"; readonly message: SlateAskQuestionText }
  | { readonly kind: "rejected"; readonly reason: SlateAskQuestionText }
  | { readonly kind: "async" }
  | { readonly kind: "unknown" }

export interface SlateAskQuestionToolCall {
  readonly kind: "ask-question"
  readonly args?: SlateAskQuestionToolArguments
  readonly result?: SlateAskQuestionToolOutcome
  readonly case?: undefined
  readonly value?: undefined
}

export interface SlatePlanDraftTodo {
  readonly id: string
  readonly content: SlateToolCallText
  readonly status: SlateTodoStatus
  readonly createdAt: bigint
  readonly updatedAt: bigint
  readonly dependencies?: readonly string[]
  readonly compatibility?: { readonly legacyStatusCode?: number }
}

export interface SlatePlanDraftPhase {
  readonly name: SlateToolCallText
  readonly todos: readonly SlatePlanDraftTodo[]
}

export interface SlatePlanDraftToolArguments {
  readonly content: SlateToolCallText
  readonly todos: readonly SlatePlanDraftTodo[]
  readonly overview: SlateToolCallText
  readonly title: SlateToolCallText
  readonly isProjectPlan: boolean
  readonly phases: readonly SlatePlanDraftPhase[]
}

export type SlatePlanDraftToolOutcome =
  | { readonly kind: "created"; readonly planUri: SlateToolCallText }
  | { readonly kind: "error"; readonly message: SlateToolCallText; readonly planUri: SlateToolCallText }
  | { readonly kind: "unknown"; readonly planUri: SlateToolCallText }

export interface SlatePlanDraftToolCall {
  readonly kind: "plan-draft"
  readonly args?: SlatePlanDraftToolArguments
  readonly result?: SlatePlanDraftToolOutcome
  readonly case?: undefined
  readonly value?: undefined
}

export type SlateToolCallValue =
  | SlateLegacyToolCallValue
  | SlateConversationSummaryToolCall
  | SlateAskQuestionToolCall
  | SlatePlanDraftToolCall

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

export function createSlateAskQuestionToolCall(input: {
  readonly args?: SlateAskQuestionToolArguments
  readonly result?: SlateAskQuestionToolOutcome
}): SlateAskQuestionToolCall {
  const args = input.args === undefined
    ? undefined
    : {
        ...input.args,
        questions: input.args.questions.map(question => ({
          ...question,
          options: question.options.map(option => ({ ...option })),
        })),
      }
  const result = input.result === undefined
    ? undefined
    : input.result.kind === "answered"
      ? { ...input.result, answers: input.result.answers.map(answer => ({
          ...answer,
          selectedOptionIds: [...answer.selectedOptionIds],
        })) }
      : { ...input.result }
  const operation: SlateAskQuestionToolCall = {
    kind: "ask-question",
    ...(args === undefined ? {} : { args }),
    ...(result === undefined ? {} : { result }),
  }
  if (!isSlateAskQuestionToolCall(operation)) throw new TypeError("Slate ask-question operation is invalid")
  return operation
}

export function isSlateAskQuestionToolCall(value: unknown): value is SlateAskQuestionToolCall {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const tool = value as Record<string, unknown>
  if (tool.kind !== "ask-question" || !hasOnlyOwnKeys(tool, ["kind", "args", "result"])) return false
  if (tool.args !== undefined) {
    if (tool.args === null || typeof tool.args !== "object" || Array.isArray(tool.args)) return false
    const args = tool.args as Record<string, unknown>
    if (!hasOnlyOwnKeys(args, ["title", "questions", "responseMode", "originalCallId"]) ||
        !isToolCallText(args.title) || !Array.isArray(args.questions) ||
        (args.responseMode !== "blocking" && args.responseMode !== "deferred") ||
        typeof args.originalCallId !== "string") return false
    for (const candidate of args.questions) {
      if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) return false
      const question = candidate as Record<string, unknown>
      if (!hasOnlyOwnKeys(question, ["id", "prompt", "allowMultiple", "options"]) ||
          typeof question.id !== "string" || !isToolCallText(question.prompt) ||
          typeof question.allowMultiple !== "boolean" || !Array.isArray(question.options)) return false
      for (const optionValue of question.options) {
        if (optionValue === null || typeof optionValue !== "object" || Array.isArray(optionValue)) return false
        const option = optionValue as Record<string, unknown>
        if (!hasOnlyOwnKeys(option, ["id", "label"]) ||
            typeof option.id !== "string" || !isToolCallText(option.label)) return false
      }
    }
  }
  if (tool.result === undefined) return true
  if (tool.result === null || typeof tool.result !== "object" || Array.isArray(tool.result)) return false
  const result = tool.result as Record<string, unknown>
  switch (result.kind) {
    case "unknown":
    case "async":
      return hasOnlyOwnKeys(result, ["kind"])
    case "rejected":
      return hasOnlyOwnKeys(result, ["kind", "reason"]) && isToolCallText(result.reason)
    case "error":
      return hasOnlyOwnKeys(result, ["kind", "message"]) && isToolCallText(result.message)
    case "answered":
      if (!hasOnlyOwnKeys(result, ["kind", "answers"]) || !Array.isArray(result.answers)) return false
      return result.answers.every(answerValue => {
        if (answerValue === null || typeof answerValue !== "object" || Array.isArray(answerValue)) return false
        const answer = answerValue as Record<string, unknown>
        return hasOnlyOwnKeys(answer, ["questionId", "selectedOptionIds", "freeformText"]) &&
          typeof answer.questionId === "string" && Array.isArray(answer.selectedOptionIds) &&
          answer.selectedOptionIds.every((id: unknown) => typeof id === "string") &&
          isToolCallText(answer.freeformText)
      })
    default:
      return false
  }
}

export function createSlatePlanDraftToolCall(input: {
  readonly args?: SlatePlanDraftToolArguments
  readonly result?: SlatePlanDraftToolOutcome
}): SlatePlanDraftToolCall {
  const cloneTodo = (todo: SlatePlanDraftTodo): SlatePlanDraftTodo => ({
    ...todo,
    ...(todo.dependencies === undefined ? {} : { dependencies: [...todo.dependencies] }),
    ...(todo.compatibility === undefined ? {} : { compatibility: { ...todo.compatibility } }),
  })
  const args = input.args === undefined
    ? undefined
    : {
        ...input.args,
        todos: input.args.todos.map(cloneTodo),
        phases: input.args.phases.map(phase => ({
          ...phase,
          todos: phase.todos.map(cloneTodo),
        })),
      }
  const result = input.result === undefined ? undefined : { ...input.result }
  const operation: SlatePlanDraftToolCall = {
    kind: "plan-draft",
    ...(args === undefined ? {} : { args }),
    ...(result === undefined ? {} : { result }),
  }
  if (!isSlatePlanDraftToolCall(operation)) throw new TypeError("Slate plan-draft operation is invalid")
  return operation
}

export function isSlatePlanDraftToolCall(value: unknown): value is SlatePlanDraftToolCall {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const tool = value as Record<string, unknown>
  if (tool.kind !== "plan-draft" || !hasOnlyOwnKeys(tool, ["kind", "args", "result"])) return false
  if (tool.args !== undefined) {
    if (tool.args === null || typeof tool.args !== "object" || Array.isArray(tool.args)) return false
    const args = tool.args as Record<string, unknown>
    if (!hasOnlyOwnKeys(args, ["content", "todos", "overview", "title", "isProjectPlan", "phases"]) ||
        !isToolCallText(args.content) || !isToolCallText(args.overview) || !isToolCallText(args.title) ||
        typeof args.isProjectPlan !== "boolean" || !Array.isArray(args.todos) || !Array.isArray(args.phases) ||
        !args.todos.every(isPlanDraftTodo)) return false
    for (const phaseValue of args.phases) {
      if (phaseValue === null || typeof phaseValue !== "object" || Array.isArray(phaseValue)) return false
      const phase = phaseValue as Record<string, unknown>
      if (!hasOnlyOwnKeys(phase, ["name", "todos"]) || !isToolCallText(phase.name) ||
          !Array.isArray(phase.todos) || !phase.todos.every(isPlanDraftTodo)) return false
    }
  }
  if (tool.result === undefined) return true
  if (tool.result === null || typeof tool.result !== "object" || Array.isArray(tool.result)) return false
  const result = tool.result as Record<string, unknown>
  switch (result.kind) {
    case "created":
    case "unknown":
      return hasOnlyOwnKeys(result, ["kind", "planUri"]) && isToolCallText(result.planUri)
    case "error":
      return hasOnlyOwnKeys(result, ["kind", "message", "planUri"]) &&
        isToolCallText(result.message) && isToolCallText(result.planUri)
    default:
      return false
  }
}

function isPlanDraftTodo(value: unknown): value is SlatePlanDraftTodo {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const todo = value as Record<string, unknown>
  if (!hasOnlyOwnKeys(todo, ["id", "content", "status", "createdAt", "updatedAt", "dependencies", "compatibility"]) ||
      typeof todo.id !== "string" || !isToolCallText(todo.content) ||
      !["pending", "in_progress", "completed", "cancelled", "unspecified"].includes(todo.status as string) ||
      typeof todo.createdAt !== "bigint" || typeof todo.updatedAt !== "bigint" ||
      (todo.dependencies !== undefined &&
        (!Array.isArray(todo.dependencies) || !todo.dependencies.every((dependency: unknown) => typeof dependency === "string")))) return false
  if (todo.compatibility === undefined) return true
  if (todo.compatibility === null || typeof todo.compatibility !== "object" || Array.isArray(todo.compatibility)) return false
  const compatibility = todo.compatibility as Record<string, unknown>
  return hasOnlyOwnKeys(compatibility, ["legacyStatusCode"]) &&
    (compatibility.legacyStatusCode === undefined ||
      (Number.isInteger(compatibility.legacyStatusCode) &&
        (compatibility.legacyStatusCode as number) >= -2_147_483_648 &&
        (compatibility.legacyStatusCode as number) <= 2_147_483_647))
}

function hasOnlyOwnKeys(value: Readonly<Record<string, unknown>>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key))
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
