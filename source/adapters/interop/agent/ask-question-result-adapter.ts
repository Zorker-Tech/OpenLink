import type { AskQuestionResult } from "../proto/generated/agent/v1/ask_question_tool_pb.ts"
import {
  createRedactedAskQuestionArgs,
  createRedactedAskQuestionToolCall,
  fromRedactedAskQuestionResult,
} from "../redacted-protos/generated/agent/v1/ask_question_tool_redacted.ts"
import { createRedactedToolCall } from "../redacted-protos/generated/agent/v1/agent_redacted.ts"
import { PrivacyCapability } from "../../../packages/redaction/classification.ts"
import type { PrivacyMode } from "../../../packages/redaction/privacy-mode.ts"
import type { RedactedString } from "../../../packages/redaction/redacted-values.ts"

export type InteropRedactedToolCall = ReturnType<typeof createRedactedToolCall>
import { isAskQuestionAutoAnswerReason } from "../../../packages/constants/ask-question.ts"
import {
  formatAskQuestionOutcomeAsString,
  type SlateAskQuestionOutcome,
} from "../../../packages/agent/tools/core/ask-question/outcome-format.ts"

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

export interface RedactedAskQuestionArguments {
  readonly title: RedactedString
  readonly questions: readonly {
    readonly id: string
    readonly prompt: RedactedString
    readonly allowMultiple: boolean
    readonly options: readonly { readonly id: string; readonly label: RedactedString }[]
  }[]
}

export function createAskQuestionCompletionToolCall(input: {
  readonly privacyMode: PrivacyMode
  readonly originalToolCallId: string
  readonly originalArgs?: RedactedAskQuestionArguments | undefined
  readonly result?: unknown | undefined
}): InteropRedactedToolCall {
  const args = input.originalArgs === undefined
    ? undefined
    : createRedactedAskQuestionArgs(input.privacyMode, {
      title: input.originalArgs.title,
      questions: input.originalArgs.questions,
      asyncOriginalToolCallId: input.originalToolCallId,
    })
  const toolCall = createRedactedAskQuestionToolCall(input.privacyMode, {
    args,
    result: input.result as never,
  })
  return createRedactedToolCall(input.privacyMode, {
    toolCallId: input.originalToolCallId,
    tool: { case: "askQuestionToolCall", value: toolCall },
  })
}
