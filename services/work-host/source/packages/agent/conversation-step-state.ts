/** Slate's product shape for one persisted conversation step. */
import { isRedactedString, type RedactedString } from "../redaction/redacted-values.ts"
import type {
  SlateAskQuestionAnswer,
  SlateAskQuestionArguments,
  SlateAskQuestionText,
} from "./actions/ask-question-completion.ts"
import type { SlateTodoStatus } from "./tools/core/todo/contracts.ts"
import type { SlateCheckpointUnknownField } from "./conversation-checkpoint-state.ts"
import { isSlateShellToolCall, type SlateShellToolCall, type SlateShellToolCallText } from "./shell-tool-call-state.ts"
import { isSlateTaskToolCall, type SlateTaskToolCall, type SlateTaskToolText } from "./task-tool-call-state.ts"

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

export type SlateSendMessageContent =
  | { readonly kind: "text"; readonly content: SlateToolCallText }
  | { readonly kind: "attachment"; readonly url: SlateToolCallText; readonly alt?: SlateToolCallText }
  | { readonly kind: "missing" }
  | { readonly kind: "unsupported"; readonly sourceCase: string; readonly payload?: unknown }

export interface SlateSendMessageToolArguments {
  readonly message?: SlateSendMessageContent
}

export type SlateSendMessageToolOutcome =
  | { readonly kind: "delivered"; readonly timestampMs: bigint; readonly messageId: string }
  | { readonly kind: "error"; readonly message: SlateToolCallText }
  | { readonly kind: "unknown" }

export interface SlateSendMessageToolCall {
  readonly kind: "send-message"
  readonly args?: SlateSendMessageToolArguments
  readonly result?: SlateSendMessageToolOutcome
  readonly case?: undefined
  readonly value?: undefined
}

export interface SlateComputerCoordinate {
  readonly x: number
  readonly y: number
}

export type SlateComputerMouseButton =
  | "unspecified"
  | "left"
  | "right"
  | "middle"
  | "back"
  | "forward"
  | { readonly kind: "unknown"; readonly code: number }

export type SlateComputerScrollDirection =
  | "unspecified"
  | "up"
  | "down"
  | "left"
  | "right"
  | { readonly kind: "unknown"; readonly code: number }

export type SlateComputerUseAction<Text extends SlateToolCallText = SlateToolCallText> =
  | { readonly kind: "mouse-move"; readonly coordinate?: SlateComputerCoordinate }
  | {
      readonly kind: "click"
      readonly coordinate?: SlateComputerCoordinate
      readonly button: SlateComputerMouseButton
      readonly count: number
      readonly modifierKeys?: Text
    }
  | { readonly kind: "mouse-down"; readonly button: SlateComputerMouseButton }
  | { readonly kind: "mouse-up"; readonly button: SlateComputerMouseButton }
  | {
      readonly kind: "drag"
      readonly path: readonly SlateComputerCoordinate[]
      readonly button: SlateComputerMouseButton
      readonly modifierKeys?: Text
    }
  | {
      readonly kind: "scroll"
      readonly coordinate?: SlateComputerCoordinate
      readonly direction: SlateComputerScrollDirection
      readonly amount: number
      readonly modifierKeys?: Text
    }
  | { readonly kind: "type"; readonly text: Text }
  | { readonly kind: "key"; readonly key: Text; readonly holdDurationMs?: number }
  | { readonly kind: "wait"; readonly durationMs: number }
  | { readonly kind: "screenshot" }
  | { readonly kind: "cursor-position" }
  | { readonly kind: "missing" }
  | { readonly kind: "unsupported"; readonly sourceCase: string; readonly payload?: unknown }

export interface SlateComputerUseToolArguments<Text extends SlateToolCallText = SlateToolCallText> {
  readonly originalCallId: string
  readonly actions: readonly SlateComputerUseAction<Text>[]
  readonly description?: Text
  readonly bindUnmappedCharacters?: boolean
}

export type SlateComputerUseToolOutcome<Text extends SlateToolCallText = SlateToolCallText> =
  | {
      readonly kind: "success"
      readonly actionCount: number
      readonly durationMs: number
      readonly screenshot?: Text
      readonly log?: Text
      readonly screenshotPath?: Text
      readonly cursorPosition?: SlateComputerCoordinate
    }
  | {
      readonly kind: "error"
      readonly message: Text
      readonly actionCount: number
      readonly durationMs: number
      readonly log?: Text
      readonly screenshot?: Text
      readonly screenshotPath?: Text
    }
  | { readonly kind: "unknown" }

export interface SlateComputerUseToolCall {
  readonly kind: "computer-use"
  readonly args?: SlateComputerUseToolArguments
  readonly result?: SlateComputerUseToolOutcome
  readonly case?: undefined
  readonly value?: undefined
}

/** Slate's request and outcome for one executor call, before it becomes a conversation step. */
export interface SlateComputerUseExecutorRequest {
  readonly toolCallId: string
  readonly actions: readonly SlateComputerUseAction<string>[]
  readonly description?: string
  readonly bindUnmappedCharacters?: boolean
}

export type SlateComputerUseExecutorResult = SlateComputerUseToolOutcome<string>

export type SlateToolCallValue =
  | SlateLegacyToolCallValue
  | SlateTaskToolCall<SlateTaskToolText>
  | SlateShellToolCall<SlateShellToolCallText>
  | SlateConversationSummaryToolCall
  | SlateAskQuestionToolCall
  | SlatePlanDraftToolCall
  | SlateSendMessageToolCall
  | SlateComputerUseToolCall

/** The closed Slate call families plus an explicit lossless compatibility value for unmapped calls. */
export function isSlateToolCallValue(value: unknown): value is SlateToolCallValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const tool = value as Record<string, unknown>
  switch (tool.kind) {
    case "task": return isSlateTaskToolCall(tool)
    case "shell": return isSlateShellToolCall(tool)
    case "conversation-summary": return isSlateConversationSummaryToolCall(tool)
    case "ask-question": return isSlateAskQuestionToolCall(tool)
    case "plan-draft": return isSlatePlanDraftToolCall(tool)
    case "send-message": return isSlateSendMessageToolCall(tool)
    case "computer-use": return isSlateComputerUseToolCall(tool)
    case "legacy":
      return hasOnlyOwnKeys(tool, ["kind", "case", "value"]) &&
        (tool.case === undefined || typeof tool.case === "string")
    case undefined:
      return hasOnlyOwnKeys(tool, ["case", "value"]) &&
        (tool.case === undefined || typeof tool.case === "string")
    default:
      return false
  }
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

export function createSlateSendMessageToolCall(input: {
  readonly args?: SlateSendMessageToolArguments
  readonly result?: SlateSendMessageToolOutcome
}): SlateSendMessageToolCall {
  const message = input.args?.message
  const args = input.args === undefined
    ? undefined
    : {
        ...(message === undefined ? {} : {
          message: message.kind === "text"
            ? { ...message }
            : message.kind === "attachment"
              ? { ...message }
              : message.kind === "unsupported"
                ? { ...message }
                : { kind: "missing" as const },
        }),
      }
  const result = input.result === undefined ? undefined : { ...input.result }
  const operation: SlateSendMessageToolCall = {
    kind: "send-message",
    ...(args === undefined ? {} : { args }),
    ...(result === undefined ? {} : { result }),
  }
  if (!isSlateSendMessageToolCall(operation)) throw new TypeError("Slate send-message operation is invalid")
  return operation
}

export function isSlateSendMessageToolCall(value: unknown): value is SlateSendMessageToolCall {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const tool = value as Record<string, unknown>
  if (tool.kind !== "send-message" || !hasOnlyOwnKeys(tool, ["kind", "args", "result"])) return false
  if (tool.args !== undefined) {
    if (tool.args === null || typeof tool.args !== "object" || Array.isArray(tool.args)) return false
    const args = tool.args as Record<string, unknown>
    if (!hasOnlyOwnKeys(args, ["message"])) return false
    if (args.message !== undefined) {
      if (args.message === null || typeof args.message !== "object" || Array.isArray(args.message)) return false
      const message = args.message as Record<string, unknown>
      switch (message.kind) {
        case "text":
          if (!hasOnlyOwnKeys(message, ["kind", "content"]) || !isToolCallText(message.content)) return false
          break
        case "attachment":
          if (!hasOnlyOwnKeys(message, ["kind", "url", "alt"]) || !isToolCallText(message.url) ||
              (message.alt !== undefined && !isToolCallText(message.alt))) return false
          break
        case "missing":
          if (!hasOnlyOwnKeys(message, ["kind"])) return false
          break
        case "unsupported":
          if (!hasOnlyOwnKeys(message, ["kind", "sourceCase", "payload"]) ||
              typeof message.sourceCase !== "string") return false
          break
        default:
          return false
      }
    }
  }
  if (tool.result === undefined) return true
  if (tool.result === null || typeof tool.result !== "object" || Array.isArray(tool.result)) return false
  const result = tool.result as Record<string, unknown>
  switch (result.kind) {
    case "unknown":
      return hasOnlyOwnKeys(result, ["kind"])
    case "error":
      return hasOnlyOwnKeys(result, ["kind", "message"]) && isToolCallText(result.message)
    case "delivered":
      return hasOnlyOwnKeys(result, ["kind", "timestampMs", "messageId"]) &&
        typeof result.timestampMs === "bigint" && result.timestampMs >= 0n &&
        result.timestampMs <= (1n << 64n) - 1n && typeof result.messageId === "string"
    default:
      return false
  }
}

export function createSlateComputerUseToolCall(input: {
  readonly args?: SlateComputerUseToolArguments
  readonly result?: SlateComputerUseToolOutcome
}): SlateComputerUseToolCall {
  const cloneCoordinate = (coordinate: SlateComputerCoordinate): SlateComputerCoordinate => ({ ...coordinate })
  const cloneAction = (action: SlateComputerUseAction): SlateComputerUseAction => {
    switch (action.kind) {
      case "mouse-move":
        return { ...action, ...(action.coordinate === undefined ? {} : { coordinate: cloneCoordinate(action.coordinate) }) }
      case "click":
      case "scroll":
        return { ...action, ...(action.coordinate === undefined ? {} : { coordinate: cloneCoordinate(action.coordinate) }) }
      case "drag":
        return { ...action, path: action.path.map(cloneCoordinate) }
      default:
        return { ...action }
    }
  }
  const args = input.args === undefined
    ? undefined
    : {
        ...input.args,
        actions: input.args.actions.map(cloneAction),
      }
  const result = input.result === undefined
    ? undefined
    : {
        ...input.result,
        ...(input.result.kind === "success" && input.result.cursorPosition !== undefined
          ? { cursorPosition: cloneCoordinate(input.result.cursorPosition) }
          : {}),
      }
  const operation: SlateComputerUseToolCall = {
    kind: "computer-use",
    ...(args === undefined ? {} : { args }),
    ...(result === undefined ? {} : { result }),
  }
  if (!isSlateComputerUseToolCall(operation)) throw new TypeError("Slate computer-use operation is invalid")
  return operation
}

export function isSlateComputerUseToolCall(value: unknown): value is SlateComputerUseToolCall {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const tool = value as Record<string, unknown>
  if (tool.kind !== "computer-use" || !hasOnlyOwnKeys(tool, ["kind", "args", "result"])) return false
  if (tool.args !== undefined) {
    if (tool.args === null || typeof tool.args !== "object" || Array.isArray(tool.args)) return false
    const args = tool.args as Record<string, unknown>
    if (!hasOnlyOwnKeys(args, ["originalCallId", "actions", "description", "bindUnmappedCharacters"]) ||
        typeof args.originalCallId !== "string" || !Array.isArray(args.actions) ||
        (args.description !== undefined && !isToolCallText(args.description)) ||
        (args.bindUnmappedCharacters !== undefined && typeof args.bindUnmappedCharacters !== "boolean") ||
        !args.actions.every(isSlateComputerUseAction)) return false
  }
  if (tool.result === undefined) return true
  if (tool.result === null || typeof tool.result !== "object" || Array.isArray(tool.result)) return false
  const result = tool.result as Record<string, unknown>
  switch (result.kind) {
    case "unknown":
      return hasOnlyOwnKeys(result, ["kind"])
    case "success":
      return hasOnlyOwnKeys(result, ["kind", "actionCount", "durationMs", "screenshot", "log", "screenshotPath", "cursorPosition"]) &&
        isInt32Value(result.actionCount) && isInt32Value(result.durationMs) &&
        (result.screenshot === undefined || isToolCallText(result.screenshot)) &&
        (result.log === undefined || isToolCallText(result.log)) &&
        (result.screenshotPath === undefined || isToolCallText(result.screenshotPath)) &&
        (result.cursorPosition === undefined || isSlateComputerCoordinate(result.cursorPosition))
    case "error":
      return hasOnlyOwnKeys(result, ["kind", "message", "actionCount", "durationMs", "log", "screenshot", "screenshotPath"]) &&
        isToolCallText(result.message) && isInt32Value(result.actionCount) && isInt32Value(result.durationMs) &&
        (result.log === undefined || isToolCallText(result.log)) &&
        (result.screenshot === undefined || isToolCallText(result.screenshot)) &&
        (result.screenshotPath === undefined || isToolCallText(result.screenshotPath))
    default:
      return false
  }
}

function isSlateComputerUseAction(value: unknown): value is SlateComputerUseAction {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const action = value as Record<string, unknown>
  switch (action.kind) {
    case "mouse-move":
      return hasOnlyOwnKeys(action, ["kind", "coordinate"]) &&
        (action.coordinate === undefined || isSlateComputerCoordinate(action.coordinate))
    case "click":
      return hasOnlyOwnKeys(action, ["kind", "coordinate", "button", "count", "modifierKeys"]) &&
        (action.coordinate === undefined || isSlateComputerCoordinate(action.coordinate)) &&
        isSlateComputerMouseButton(action.button) && isInt32Value(action.count) &&
        (action.modifierKeys === undefined || isToolCallText(action.modifierKeys))
    case "mouse-down":
    case "mouse-up":
      return hasOnlyOwnKeys(action, ["kind", "button"]) && isSlateComputerMouseButton(action.button)
    case "drag":
      return hasOnlyOwnKeys(action, ["kind", "path", "button", "modifierKeys"]) &&
        Array.isArray(action.path) && action.path.every(isSlateComputerCoordinate) &&
        isSlateComputerMouseButton(action.button) &&
        (action.modifierKeys === undefined || isToolCallText(action.modifierKeys))
    case "scroll":
      return hasOnlyOwnKeys(action, ["kind", "coordinate", "direction", "amount", "modifierKeys"]) &&
        (action.coordinate === undefined || isSlateComputerCoordinate(action.coordinate)) &&
        isSlateComputerScrollDirection(action.direction) && isInt32Value(action.amount) &&
        (action.modifierKeys === undefined || isToolCallText(action.modifierKeys))
    case "type":
      return hasOnlyOwnKeys(action, ["kind", "text"]) && isToolCallText(action.text)
    case "key":
      return hasOnlyOwnKeys(action, ["kind", "key", "holdDurationMs"]) && isToolCallText(action.key) &&
        (action.holdDurationMs === undefined || isInt32Value(action.holdDurationMs))
    case "wait":
      return hasOnlyOwnKeys(action, ["kind", "durationMs"]) && isInt32Value(action.durationMs)
    case "screenshot":
    case "cursor-position":
    case "missing":
      return hasOnlyOwnKeys(action, ["kind"])
    case "unsupported":
      return hasOnlyOwnKeys(action, ["kind", "sourceCase", "payload"]) && typeof action.sourceCase === "string"
    default:
      return false
  }
}

function isSlateComputerCoordinate(value: unknown): value is SlateComputerCoordinate {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const coordinate = value as Record<string, unknown>
  return hasOnlyOwnKeys(coordinate, ["x", "y"]) && isInt32Value(coordinate.x) && isInt32Value(coordinate.y)
}

function isSlateComputerMouseButton(value: unknown): value is SlateComputerMouseButton {
  if (typeof value === "string") return ["unspecified", "left", "right", "middle", "back", "forward"].includes(value)
  return isUnknownSlateEnumCode(value)
}

function isSlateComputerScrollDirection(value: unknown): value is SlateComputerScrollDirection {
  if (typeof value === "string") return ["unspecified", "up", "down", "left", "right"].includes(value)
  return isUnknownSlateEnumCode(value)
}

function isUnknownSlateEnumCode(value: unknown): value is { readonly kind: "unknown"; readonly code: number } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const unknown = value as Record<string, unknown>
  return hasOnlyOwnKeys(unknown, ["kind", "code"]) && unknown.kind === "unknown" && isInt32Value(unknown.code)
}

function isInt32Value(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= -2_147_483_648 && value <= 2_147_483_647
}

/** Product-facing metric labels remain stable when a call moves from the legacy envelope to a Slate kind. */
export function slateToolCallMetricLabel(tool: SlateToolCallValue): string | undefined {
  if (isSlateTaskToolCall(tool)) return "task"
  if (isSlateShellToolCall(tool)) return "shell"
  if (tool.kind === "send-message") return "sendMessage"
  if (tool.kind === "ask-question") return "askQuestion"
  if (tool.kind === "plan-draft") return "createPlan"
  if (tool.kind === "conversation-summary") {
    return tool.source === "final" ? "sendFinalSummary" : "communicateUpdate"
  }
  const operation = tool.case
  return operation === undefined ? undefined : operation.replace("ToolCall", "").replace(/_/g, "-")
}

export function isSuccessfulSlateSendMessage(tool: SlateToolCallValue): boolean {
  return isSlateSendMessageToolCall(tool) && tool.result?.kind === "delivered"
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
