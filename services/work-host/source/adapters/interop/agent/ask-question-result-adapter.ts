import {
  AskQuestionAsync,
  AskQuestionError,
  AskQuestionRejected,
  AskQuestionResult,
  AskQuestionSuccess,
  AskQuestionSuccess_Answer,
} from "../proto/generated/agent/v1/ask_question_tool_pb.ts"
import {
  createRedactedAskQuestionArgs,
  createRedactedAskQuestionToolCall,
  fromRedactedAskQuestionResult,
  toRedactedAskQuestionResult,
} from "../redacted-protos/generated/agent/v1/ask_question_tool_redacted.ts"
import { createRedactedToolCall } from "../redacted-protos/generated/agent/v1/agent_redacted.ts"
import { DataClassification, PrivacyCapability } from "../../../packages/redaction/classification.ts"
import { createRedactedString } from "../../../packages/redaction/create.ts"
import type { PrivacyMode } from "../../../packages/redaction/privacy-mode.ts"
import { isRedactedString, type RedactedString } from "../../../packages/redaction/redacted-values.ts"

export type InteropRedactedToolCall = ReturnType<typeof createRedactedToolCall>
import { isAskQuestionAutoAnswerReason } from "../../../packages/constants/ask-question.ts"
import {
  formatAskQuestionOutcomeAsString,
  type SlateAskQuestionOutcome,
} from "../../../packages/agent/tools/core/ask-question/outcome-format.ts"
import type {
  AskQuestionCompletionAction,
  SlateAskQuestionCompletionResult,
  SlateAskQuestionText,
} from "../../../packages/agent/actions/ask-question-completion-contracts.ts"

const CLIENT_CALL_FAILED = "Tool call failed"

function projectAskQuestionResult(result: AskQuestionResult | undefined): SlateAskQuestionOutcome {
  if (result === undefined) return { kind: "unknown" }

  switch (result.result.case) {
    case "success":
      return {
        kind: "answered",
        answers: result.result.value.answers.map(answer => ({
          questionId: answer.questionId,
          selectedOptionIds: answer.selectedOptionIds,
          ...(answer.freeformText === undefined ? {} : { freeformText: answer.freeformText }),
        })),
      }
    case "async":
      return { kind: "async" }
    case "rejected":
      return { kind: "rejected", reason: result.result.value.reason }
    case "error":
      return {
        kind: "error",
        message: result.result.value.errorMessage,
        askWasTooEarly: result.result.value.errorMessage === CLIENT_CALL_FAILED,
      }
    case undefined:
      return { kind: "unknown" }
  }
}

export function formatAskQuestionResultAsString(result: AskQuestionResult): string {
  return formatAskQuestionOutcomeAsString(projectAskQuestionResult(result))
}

export function shouldReceiptAskQuestionResult(result: AskQuestionResult | undefined): boolean {
  if (result === undefined) return false
  switch (result.result.case) {
    case "success":
    case "error":
      return true
    case "rejected":
      return !isAskQuestionAutoAnswerReason(result.result.value.reason)
    default:
      return false
  }
}

export function formatRedactedAskQuestionResultAsString(result: unknown): string {
  const decoded = fromRedactedAskQuestionResult(
    result as never,
    PrivacyCapability.UNSAFE_ALWAYS_ALLOWED,
    undefined,
  )
  return formatAskQuestionResultAsString(decoded)
}

export function shouldReceiptRedactedAskQuestionResult(result: unknown): boolean {
  if (result === undefined) return false
  const decoded = fromRedactedAskQuestionResult(
    result as never,
    PrivacyCapability.UNSAFE_ALWAYS_ALLOWED,
    undefined,
  )
  return shouldReceiptAskQuestionResult(decoded)
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function slateText(value: unknown, field: string, privacyMode: PrivacyMode): SlateAskQuestionText {
  return isRedactedString(value)
    ? value
    : createRedactedString(typeof value === "string" ? value : "", DataClassification.CODE, field, privacyMode)
}

function slateOutcomeFromRedacted(value: unknown, privacyMode: PrivacyMode): SlateAskQuestionCompletionResult {
  const envelope = record(value)
  const selected = record(record(envelope?.result)?.value)
  switch (record(envelope?.result)?.case) {
    case "success":
      return {
        kind: "answered",
        answers: (Array.isArray(selected?.answers) ? selected.answers : []).map((answerValue, index) => {
          const answer = record(answerValue) ?? {}
          return {
            questionId: typeof answer.questionId === "string" ? answer.questionId : "",
            selectedOptionIds: Array.isArray(answer.selectedOptionIds)
              ? answer.selectedOptionIds.filter((id): id is string => typeof id === "string")
              : [],
            freeformText: slateText(answer.freeformText, `freeform_text_${index}`, privacyMode),
          }
        }),
      }
    case "rejected":
      return { kind: "rejected", reason: slateText(selected?.reason, "reason", privacyMode) }
    case "error": {
      const message = slateText(selected?.errorMessage, "error_message", privacyMode)
      const errorText = isRedactedString(message) ? message.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED) : message
      return { kind: "error", message, askWasTooEarly: errorText === CLIENT_CALL_FAILED }
    }
    case "async": return { kind: "async" }
    default: return { kind: "unknown" }
  }
}

/** Projects a redacted completion into Slate's owned question, answer and outcome records. */
export function slateAskQuestionCompletionFromRedacted(
  value: unknown,
  privacyMode: PrivacyMode,
): AskQuestionCompletionAction {
  const source = record(value)
  const args = record(source?.originalArgs)
  const originalArgs = args === undefined
    ? undefined
    : {
        title: slateText(args.title, "title", privacyMode),
        questions: (Array.isArray(args.questions) ? args.questions : []).map((questionValue, questionIndex) => {
          const question = record(questionValue) ?? {}
          return {
            id: typeof question.id === "string" ? question.id : "",
            prompt: slateText(question.prompt, `question_prompt_${questionIndex}`, privacyMode),
            allowMultiple: question.allowMultiple === true,
            options: (Array.isArray(question.options) ? question.options : []).map((optionValue, optionIndex) => {
              const option = record(optionValue) ?? {}
              return {
                id: typeof option.id === "string" ? option.id : "",
                label: slateText(option.label, `question_${questionIndex}_option_${optionIndex}`, privacyMode),
              }
            }),
          }
        }),
      }
  const result = source?.result
  const compatibility = source === undefined
    ? undefined
    : {
        ...(result === undefined ? {} : { legacyResult: result }),
        legacyPayload: source,
      }
  return {
    schema: "slate.agent-action.ask-question-completion",
    version: 1,
    privacyMode,
    originalToolCallId: typeof source?.originalToolCallId === "string" ? source.originalToolCallId : "",
    ...(originalArgs === undefined ? {} : { originalArgs }),
    ...(result === undefined ? {} : { result: slateOutcomeFromRedacted(result, privacyMode) }),
    ...(compatibility === undefined ? {} : { compatibility }),
  }
}

function textForWire(value: SlateAskQuestionText): string {
  return isRedactedString(value) ? value.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED) : value
}

function redactText(value: SlateAskQuestionText, fieldName: string, privacyMode: PrivacyMode): RedactedString {
  return createRedactedString(
    textForWire(value),
    isRedactedString(value) ? value.__classification : DataClassification.CODE,
    isRedactedString(value) ? value.__fieldName : fieldName,
    privacyMode,
  )
}

function askQuestionResultFromSlate(result: SlateAskQuestionCompletionResult | undefined): AskQuestionResult | undefined {
  if (result === undefined || result.kind === "unknown") return undefined
  switch (result.kind) {
    case "answered":
      return new AskQuestionResult({
        result: {
          case: "success",
          value: new AskQuestionSuccess({
            answers: result.answers.map(answer => new AskQuestionSuccess_Answer({
              questionId: answer.questionId,
              selectedOptionIds: [...answer.selectedOptionIds],
              freeformText: textForWire(answer.freeformText),
            })),
          }),
        },
      })
    case "error":
      return new AskQuestionResult({
        result: { case: "error", value: new AskQuestionError({ errorMessage: textForWire(result.message) }) },
      })
    case "rejected":
      return new AskQuestionResult({
        result: { case: "rejected", value: new AskQuestionRejected({ reason: textForWire(result.reason) }) },
      })
    case "async":
      return new AskQuestionResult({ result: { case: "async", value: new AskQuestionAsync() } })
  }
}

export function createAskQuestionCompletionToolCall(input: {
  readonly action: AskQuestionCompletionAction
  readonly originalToolCallId: string
}): InteropRedactedToolCall {
  const { action } = input
  const args = action.originalArgs === undefined
    ? undefined
    : createRedactedAskQuestionArgs(action.privacyMode, {
        title: redactText(action.originalArgs.title, "title", action.privacyMode),
        questions: action.originalArgs.questions.map((question, questionIndex) => ({
          id: question.id,
          prompt: redactText(question.prompt, `question_prompt_${questionIndex}`, action.privacyMode),
          allowMultiple: question.allowMultiple,
          options: question.options.map((option, optionIndex) => ({
            id: option.id,
            label: redactText(option.label, `question_${questionIndex}_option_${optionIndex}`, action.privacyMode),
          })),
        })),
        asyncOriginalToolCallId: input.originalToolCallId,
      })
  const legacyResult = action.compatibility?.legacyResult
  const slateResult = askQuestionResultFromSlate(action.result)
  // Known outcomes are serialized from Slate's contract. Preserve the historical result only when a
  // newer, unrecognized outcome cannot yet be represented without losing its data.
  const result = slateResult === undefined
    ? legacyResult
    : toRedactedAskQuestionResult(slateResult, action.privacyMode)
  const toolCall = createRedactedAskQuestionToolCall(action.privacyMode, { args, result: result as never })
  return createRedactedToolCall(action.privacyMode, {
    toolCallId: input.originalToolCallId,
    tool: { case: "askQuestionToolCall", value: toolCall },
  })
}
