import { PrivacyMode, type PrivacyMode as PrivacyModeValue } from "../../redaction/privacy-mode.ts"
import { isRedactedString, type RedactedString } from "../../redaction/redacted-values.ts"

export type SlateAskQuestionText = string | RedactedString

export interface SlateAskQuestionOption {
  readonly id: string
  readonly label: SlateAskQuestionText
}

export interface SlateAskQuestionQuestion {
  readonly id: string
  readonly prompt: SlateAskQuestionText
  readonly allowMultiple: boolean
  readonly options: readonly SlateAskQuestionOption[]
}

export interface SlateAskQuestionArguments {
  readonly title: SlateAskQuestionText
  readonly questions: readonly SlateAskQuestionQuestion[]
}

export interface SlateAskQuestionAnswer {
  readonly questionId: string
  readonly selectedOptionIds: readonly string[]
  readonly freeformText: SlateAskQuestionText
}

/** Slate outcome union, kept redaction-aware until text is written to a prompt or wire message. */
export type SlateAskQuestionCompletionResult =
  | { readonly kind: "answered"; readonly answers: readonly SlateAskQuestionAnswer[] }
  | { readonly kind: "error"; readonly message: SlateAskQuestionText; readonly askWasTooEarly: boolean }
  | { readonly kind: "rejected"; readonly reason: SlateAskQuestionText }
  | { readonly kind: "async" }
  | { readonly kind: "unknown" }

/** Slate's versioned completion contract for an asynchronous question. */
export interface AskQuestionCompletionAction {
  readonly schema: "slate.agent-action.ask-question-completion"
  readonly version: 1
  readonly privacyMode: PrivacyModeValue
  readonly originalToolCallId: string
  readonly originalArgs?: SlateAskQuestionArguments | undefined
  readonly result?: SlateAskQuestionCompletionResult | undefined
  readonly compatibility?: {
    readonly legacyResult?: unknown
    readonly legacyPayload?: Readonly<Record<string, unknown>>
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isSlateAskQuestionText(value: unknown): value is SlateAskQuestionText {
  return typeof value === "string" || isRedactedString(value)
}

function isSlateAskQuestionArguments(value: unknown): value is SlateAskQuestionArguments {
  const args = isRecord(value) ? value : undefined
  if (args === undefined || !isSlateAskQuestionText(args.title) || !Array.isArray(args.questions)) return false
  return args.questions.every(questionValue => {
    const question = isRecord(questionValue) ? questionValue : undefined
    if (question === undefined || typeof question.id !== "string" ||
        !isSlateAskQuestionText(question.prompt) || typeof question.allowMultiple !== "boolean" ||
        !Array.isArray(question.options)) return false
    return question.options.every(optionValue => {
      const option = isRecord(optionValue) ? optionValue : undefined
      return option !== undefined && typeof option.id === "string" && isSlateAskQuestionText(option.label)
    })
  })
}

function isSlateAskQuestionCompletionResult(value: unknown): value is SlateAskQuestionCompletionResult {
  const result = isRecord(value) ? value : undefined
  if (result === undefined) return false
  switch (result.kind) {
    case "answered":
      return Array.isArray(result.answers) && result.answers.every(answerValue => {
        const answer = isRecord(answerValue) ? answerValue : undefined
        return answer !== undefined && typeof answer.questionId === "string" &&
          Array.isArray(answer.selectedOptionIds) && answer.selectedOptionIds.every(id => typeof id === "string") &&
          isSlateAskQuestionText(answer.freeformText)
      })
    case "error":
      return isSlateAskQuestionText(result.message) && typeof result.askWasTooEarly === "boolean"
    case "rejected":
      return isSlateAskQuestionText(result.reason)
    case "async":
    case "unknown":
      return true
    default:
      return false
  }
}

/** Validates the versioned Slate completion payload before action-kind narrowing. */
export function isSlateAskQuestionCompletionAction(value: unknown): value is AskQuestionCompletionAction {
  const action = isRecord(value) ? value : undefined
  if (action === undefined || action.schema !== "slate.agent-action.ask-question-completion" ||
      action.version !== 1 || !Object.values(PrivacyMode).includes(action.privacyMode as PrivacyModeValue) ||
      typeof action.originalToolCallId !== "string") return false
  if (action.originalArgs !== undefined && !isSlateAskQuestionArguments(action.originalArgs)) return false
  if (action.result !== undefined && !isSlateAskQuestionCompletionResult(action.result)) return false
  if (action.compatibility !== undefined) {
    const compatibility = isRecord(action.compatibility) ? action.compatibility : undefined
    if (compatibility === undefined ||
        (compatibility.legacyPayload !== undefined && !isRecord(compatibility.legacyPayload))) return false
  }
  return true
}
