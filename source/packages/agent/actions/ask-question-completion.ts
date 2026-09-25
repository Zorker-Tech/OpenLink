/**
 * What happens to a question that was asked asynchronously and answered later.
 *
 * A question can be asked without blocking the turn — the agent asks and carries on — and the answer
 * arrives afterwards, as its own action. By then the turn that asked it is gone, so the conversation has to
 * be told what happened in a form it can read: the question the agent asked, and the answer it got, written
 * as the assistant's call and the tool's result it would have been if the turn had waited. That is the
 * whole job here, and it is why the arguments are rebuilt from the action rather than re-derived: the
 * question that was actually asked is the one in the action.
 *
 * The same answer can arrive twice — a retry, a replayed action, a resumed conversation — so the
 * completion is applied once and the fact that it was applied is recorded. Two things are checked before
 * anything is written: the action has to be a completion at all (an id and one of the three results that
 * mean something happened), and it must not have been applied already. An answer that is only an
 * acknowledgement is not recorded as completed, so a later real answer is still applied.
 *
 * The answer is written in whichever shape the session's tool expects: the formatted sentence a model
 * reads, or the raw object a structured caller does. Both come from the same result, so the two cannot
 * disagree about what the user chose.
 */

import { randomUUID } from "node:crypto"

import type { Context } from "../../context/context.ts"
import { createLogger } from "../../context/index.ts"
import type { AskQuestionResult } from "../../proto/generated/agent/v1/ask_question_tool_pb.ts"
import type { PrivacyMode } from "../../redaction/privacy-mode.ts"
import { PrivacyCapability } from "../../redaction/classification.ts"
import { toRedactedCoreMessages } from "../../redaction/message-redaction.ts"
import type { RedactedString } from "../../redaction/redacted-values.ts"
import {
  createRedactedAskQuestionArgs,
  createRedactedAskQuestionToolCall,
  fromRedactedAskQuestionResult,
} from "../../redacted-protos/generated/agent/v1/ask_question_tool_redacted.ts"
import { createRedactedToolCall } from "../../redacted-protos/generated/agent/v1/agent_redacted.ts"
import {
  formatAskQuestionResultAsString,
  shouldReceiptAskQuestionResult,
} from "../tools/core/ask-question/index.ts"

interface RedactedAskQuestionOption {
  readonly id: string
  readonly label: RedactedString
}

interface RedactedAskQuestionQuestion {
  readonly id: string
  readonly prompt: RedactedString
  readonly allowMultiple: boolean
  readonly options: readonly RedactedAskQuestionOption[]
}

interface RedactedAskQuestionArgs {
  readonly title: RedactedString
  readonly questions: readonly RedactedAskQuestionQuestion[]
}

interface RedactedAskQuestionSuccessAnswer {
  readonly questionId: string
  readonly selectedOptionIds: readonly string[]
  readonly freeformText: RedactedString
}

type RedactedAskQuestionResult = {
  readonly result:
    | { readonly case: "success"; readonly value: { readonly answers: readonly RedactedAskQuestionSuccessAnswer[] } }
    | { readonly case: "error"; readonly value: { readonly errorMessage: RedactedString } }
    | { readonly case: "rejected"; readonly value: { readonly reason: RedactedString } }
    | { readonly case: "async"; readonly value: unknown }
    | { readonly case: undefined; readonly value?: undefined }
}

export interface AskQuestionCompletionAction {
  readonly _privacyMode: PrivacyMode
  readonly originalToolCallId: string
  readonly originalArgs?: RedactedAskQuestionArgs | undefined
  readonly result?: RedactedAskQuestionResult | undefined
}

interface AskQuestionCompletionStateHandler {
  hasCompletedAskQuestion(toolCallId: string): boolean
  markAskQuestionCompleted(toolCallId: string): void
  getPrivacyMode(): PrivacyMode
}

interface AskQuestionCompletionTurn {
  upsertToolCall(ctx: Context, toolCall: unknown, toolCallId: string): Promise<unknown>
}

interface AskQuestionCompletionPromptExecutor {
  appendMessages(messages: readonly unknown[]): unknown
}

interface ApplyAskQuestionCompletionArgs {
  readonly action: AskQuestionCompletionAction
  readonly stateHandler: AskQuestionCompletionStateHandler
  readonly turn: AskQuestionCompletionTurn
  readonly rootPromptExecutor: AskQuestionCompletionPromptExecutor
  readonly resultFormat: "formatted-string" | string
}

interface AppliedAskQuestionCompletion {
  readonly outcome: "applied"
  readonly recordedToolCallId: string
  readonly toolCall: ReturnType<typeof createRedactedToolCall>
  readonly promptMessages: ReturnType<typeof toRedactedCoreMessages>
}

type AskQuestionCompletionApplication =
  | AppliedAskQuestionCompletion
  | { readonly outcome: "invalid" | "already-applied" }

const logger = createLogger("@slate/agent/ask-question-completion")

/** A completion is only a completion when it names the question and says what came of it. */
export function isValidAskQuestionCompletion(action: AskQuestionCompletionAction): boolean {
  const resultCase = action.result?.result.case
  return action.originalToolCallId.length > 0 &&
    (resultCase === "success" || resultCase === "rejected" || resultCase === "error")
}

export function hasAppliedAskQuestionCompletion(
  stateHandler: AskQuestionCompletionStateHandler,
  originalToolCallId: string,
): boolean {
  return originalToolCallId.length > 0 &&
    stateHandler.hasCompletedAskQuestion(originalToolCallId)
}

export async function applyAskQuestionCompletion(
  ctx: Context,
  args: ApplyAskQuestionCompletionArgs,
): Promise<AskQuestionCompletionApplication> {
  const { action, stateHandler, turn, rootPromptExecutor, resultFormat } = args
  const originalToolCallId = action.originalToolCallId
  if (!isValidAskQuestionCompletion(action)) {
    logger.warn(ctx, "Dropping invalid ask_question completion", {
      originalToolCallId,
      resultCase: action.result?.result.case,
    })
    return { outcome: "invalid" }
  }
  // The same answer can arrive twice; it is written into the conversation once.
  if (
    originalToolCallId.length > 0 &&
    stateHandler.hasCompletedAskQuestion(originalToolCallId)
  ) {
    logger.info(ctx, "Dropping duplicate ask_question completion (already applied)", {
      originalToolCallId,
    })
    return { outcome: "already-applied" }
  }
  // The question is rebuilt from the action, since the turn that asked it is over.
  const syntheticArgs = action.originalArgs
    ? createRedactedAskQuestionArgs(action._privacyMode, {
      title: action.originalArgs.title,
      questions: action.originalArgs.questions,
      asyncOriginalToolCallId: originalToolCallId,
    })
    : undefined
  const syntheticToolCall = createRedactedAskQuestionToolCall(action._privacyMode, {
    args: syntheticArgs,
    result: action.result,
  })
  const recordedToolCallId = originalToolCallId.length > 0 ? originalToolCallId : randomUUID()
  const promptToolCallId = randomUUID()
  const toolCall = createRedactedToolCall(action._privacyMode, {
    toolCallId: recordedToolCallId,
    tool: {
      case: "askQuestionToolCall",
      value: syntheticToolCall,
    },
  })
  const argsPlainObject = {
    title: action.originalArgs?.title?.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED) ?? "",
    questions: action.originalArgs?.questions.map(question => ({
      id: question.id,
      prompt: question.prompt.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED),
      allow_multiple: question.allowMultiple,
      options: question.options.map(option => ({
        id: option.id,
        label: option.label.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED),
      })),
    })) ?? [],
    async_original_tool_call_id: originalToolCallId,
  }
  // Written as the call and the result the turn would have produced had it waited.
  const assistantMessage = {
    role: "assistant",
    content: [{
      type: "tool-call",
      toolCallId: promptToolCallId,
      toolName: "ask_question",
      args: argsPlainObject,
    }],
  }
  const toolMessage = {
    role: "tool",
    content: [{
      type: "tool-result",
      toolCallId: promptToolCallId,
      toolName: "ask_question",
      result: formatCompletionResult(action, resultFormat),
    }],
  }
  const promptMessages = toRedactedCoreMessages(
    [assistantMessage, toolMessage],
    stateHandler.getPrivacyMode(),
  )
  await turn.upsertToolCall(ctx, toolCall, recordedToolCallId)
  rootPromptExecutor.appendMessages(promptMessages)
  // An acknowledgement is not an answer, so the question stays open for the answer that follows.
  if (
    originalToolCallId.length > 0 &&
    shouldReceiptAskQuestionResult(
      action.result
        ? (fromRedactedAskQuestionResult as unknown as (
          value: RedactedAskQuestionResult,
          purpose: PrivacyCapability,
        ) => AskQuestionResult)(
          action.result,
          PrivacyCapability.UNSAFE_ALWAYS_ALLOWED,
        )
        : undefined,
    )
  ) {
    stateHandler.markAskQuestionCompleted(originalToolCallId)
  }
  return {
    outcome: "applied",
    recordedToolCallId,
    toolCall,
    promptMessages,
  }
}

function formatCompletionResult(
  action: AskQuestionCompletionAction,
  resultFormat: string,
): string {
  if (resultFormat === "formatted-string") {
    return action.result
      ? formatAskQuestionResultAsString(
        (fromRedactedAskQuestionResult as unknown as (
          value: RedactedAskQuestionResult,
          purpose: PrivacyCapability,
        ) => AskQuestionResult)(action.result, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED),
      )
      : "Unknown error"
  }
  // The structured shape is written the way the tool's own arguments are spelled.
  let resultPlainObject: Record<string, unknown>
  if (action.result?.result.case === "success") {
    resultPlainObject = {
      success: {
        answers: action.result.result.value.answers.map(answer => ({
          question_id: answer.questionId,
          selected_option_ids: answer.selectedOptionIds,
          freeform_text: answer.freeformText.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED),
        })),
      },
    }
  } else if (action.result?.result.case === "rejected") {
    resultPlainObject = {
      rejected: {
        reason: action.result.result.value.reason.unwrap(
          PrivacyCapability.UNSAFE_ALWAYS_ALLOWED,
        ),
      },
    }
  } else if (action.result?.result.case === "error") {
    resultPlainObject = {
      error: {
        error_message: action.result.result.value.errorMessage.unwrap(
          PrivacyCapability.UNSAFE_ALWAYS_ALLOWED,
        ),
      },
    }
  } else {
    resultPlainObject = {}
  }
  return JSON.stringify(resultPlainObject)
}
