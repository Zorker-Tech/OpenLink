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

/** The redacted question, as the action carries it. */
interface RedactedAskQuestionOption {
  readonly id: string
  readonly label: RedactedString
}

/** One question of a redacted ask, with what it offers. */
interface RedactedAskQuestionQuestion {
  readonly id: string
  readonly prompt: RedactedString
  readonly allowMultiple: boolean
  readonly options: readonly RedactedAskQuestionOption[]
}

/** The arguments an ask action carries. */
interface RedactedAskQuestionArgs {
  readonly title: RedactedString
  readonly questions: readonly RedactedAskQuestionQuestion[]
}

/** One answer a completed ask carries. */
interface RedactedAskQuestionSuccessAnswer {
  readonly questionId: string
  readonly selectedOptionIds: readonly string[]
  readonly freeformText: RedactedString
}

/** What came of an ask, in the redacted shape the action carries it. */
type RedactedAskQuestionResult = {
  readonly result:
    | { readonly case: "success"; readonly value: { readonly answers: readonly RedactedAskQuestionSuccessAnswer[] } }
    | { readonly case: "error"; readonly value: { readonly errorMessage: RedactedString } }
    | { readonly case: "rejected"; readonly value: { readonly reason: RedactedString } }
    | { readonly case: "async"; readonly value: unknown }
    | { readonly case: undefined; readonly value?: undefined }
}

/** The completion of an asynchronous ask: which question, what was asked, and what came back. */
export interface AskQuestionCompletionAction {
  readonly _privacyMode: PrivacyMode
  readonly originalToolCallId: string
  readonly originalArgs?: RedactedAskQuestionArgs | undefined
  readonly result?: RedactedAskQuestionResult | undefined
}

/** What the session remembers about completions it has applied. */
interface AskQuestionCompletionStateHandler {
  hasCompletedAskQuestion(toolCallId: string): boolean
  markAskQuestionCompleted(toolCallId: string): void
  getPrivacyMode(): PrivacyMode
}

/** The turn the call and the result are written into. */
interface AskQuestionCompletionTurn {
  upsertToolCall(ctx: Context, toolCall: unknown, toolCallId: string): Promise<unknown>
}

/** The prompt the messages are appended to. */
interface AskQuestionCompletionPromptExecutor {
  appendMessages(messages: readonly unknown[]): unknown
}

/** What applying one completion needs from the session. */
interface ApplyAskQuestionCompletionArgs {
  readonly action: AskQuestionCompletionAction
  readonly stateHandler: AskQuestionCompletionStateHandler
  readonly turn: AskQuestionCompletionTurn
  readonly rootPromptExecutor: AskQuestionCompletionPromptExecutor
  readonly resultFormat: "formatted-string" | string
}

/** The completion that was written into a conversation. */
interface AppliedAskQuestionCompletion {
  readonly outcome: "applied"
  readonly recordedToolCallId: string
  readonly toolCall: ReturnType<typeof createRedactedToolCall>
  readonly promptMessages: ReturnType<typeof toRedactedCoreMessages>
}

/** What applying a completion answered: it was written, or it was refused. */
type AskQuestionCompletionApplication =
  | AppliedAskQuestionCompletion
  | { readonly outcome: "invalid" | "already-applied" }

/** The capability these reads use: the value is being written out of redaction, not shown to a surface. */
const UNSAFE_CAPABILITY = PrivacyCapability.UNSAFE_ALWAYS_ALLOWED

const logger = createLogger("@slate/agent/ask-question-completion")

/** The printable text of a redacted value. */
function displayText(value: RedactedString): string {
  return value.unwrap(UNSAFE_CAPABILITY)
}

/** The protocol result behind a redacted one. */
function protocolResult(result: RedactedAskQuestionResult): AskQuestionResult {
  return (fromRedactedAskQuestionResult as unknown as (
    value: RedactedAskQuestionResult,
    purpose: PrivacyCapability,
  ) => AskQuestionResult)(result, UNSAFE_CAPABILITY)
}

/** The result behind an action, when the action carries one. */
function actionProtocolResult(completion: AskQuestionCompletionAction): AskQuestionResult | undefined {
  return completion.result ? protocolResult(completion.result) : undefined
}

/** A completion is only a completion when it names the question and says what came of it. */
export function isValidAskQuestionCompletion(completion: AskQuestionCompletionAction): boolean {
  const resultCase = completion.result?.result.case
  return completion.originalToolCallId.length > 0 &&
    (resultCase === "success" || resultCase === "rejected" || resultCase === "error")
}

/** Whether this completion has already been written into the conversation. */
export function hasAppliedAskQuestionCompletion(
  stateHandler: AskQuestionCompletionStateHandler,
  originalToolCallId: string,
): boolean {
  return originalToolCallId.length > 0 && stateHandler.hasCompletedAskQuestion(originalToolCallId)
}

/** The tool call the completed ask is recorded as. */
function syntheticToolCallOf(
  completion: AskQuestionCompletionAction,
  originalToolCallId: string,
): ReturnType<typeof createRedactedAskQuestionToolCall> {
  const syntheticArgs = completion.originalArgs
    ? createRedactedAskQuestionArgs(completion._privacyMode, {
      title: completion.originalArgs.title,
      questions: completion.originalArgs.questions,
      asyncOriginalToolCallId: originalToolCallId,
    })
    : undefined
  return createRedactedAskQuestionToolCall(completion._privacyMode, {
    args: syntheticArgs,
    result: completion.result,
  })
}

/** The arguments of the synthetic call, as the prompt's own tool would spell them. */
function plainAskArgs(completion: AskQuestionCompletionAction, originalToolCallId: string): Record<string, unknown> {
  return {
    title: completion.originalArgs?.title ? displayText(completion.originalArgs.title) : "",
    questions: completion.originalArgs?.questions.map(question => ({
      id: question.id,
      prompt: displayText(question.prompt),
      allow_multiple: question.allowMultiple,
      options: question.options.map(option => ({ id: option.id, label: displayText(option.label) })),
    })) ?? [],
    async_original_tool_call_id: originalToolCallId,
  }
}

/** The messages that tell the conversation the ask happened: the assistant's call and the tool's result. */
function promptMessagesOf(
  completion: AskQuestionCompletionAction,
  originalToolCallId: string,
  promptToolCallId: string,
  resultFormat: string,
  privacyMode: PrivacyMode,
): ReturnType<typeof toRedactedCoreMessages> {
  const assistantMessage = {
    role: "assistant",
    content: [{
      type: "tool-call",
      toolCallId: promptToolCallId,
      toolName: "ask_question",
      args: plainAskArgs(completion, originalToolCallId),
    }],
  }
  const toolMessage = {
    role: "tool",
    content: [{
      type: "tool-result",
      toolCallId: promptToolCallId,
      toolName: "ask_question",
      result: formatCompletionResult(completion, resultFormat),
    }],
  }
  return toRedactedCoreMessages([assistantMessage, toolMessage], privacyMode)
}

/** Applies one asynchronous ask completion to the conversation, once. */
export async function applyAskQuestionCompletion(
  ctx: Context,
  applyArgs: ApplyAskQuestionCompletionArgs,
): Promise<AskQuestionCompletionApplication> {
  const { action: completion, stateHandler, turn, rootPromptExecutor, resultFormat } = applyArgs
  const originalToolCallId = completion.originalToolCallId
  if (!isValidAskQuestionCompletion(completion)) {
    logger.warn(ctx, "Dropping invalid ask_question completion", {
      originalToolCallId,
      resultCase: completion.result?.result.case,
    })
    return { outcome: "invalid" }
  }
  // The same answer can arrive twice; it is written into the conversation once.
  if (hasAppliedAskQuestionCompletion(stateHandler, originalToolCallId)) {
    logger.info(ctx, "Dropping duplicate ask_question completion (already applied)", { originalToolCallId })
    return { outcome: "already-applied" }
  }
  const recordedToolCallId = originalToolCallId.length > 0 ? originalToolCallId : randomUUID()
  const promptToolCallId = randomUUID()
  const toolCall = createRedactedToolCall(completion._privacyMode, {
    toolCallId: recordedToolCallId,
    tool: {
      case: "askQuestionToolCall",
      value: syntheticToolCallOf(completion, originalToolCallId),
    },
  })
  const promptMessages = promptMessagesOf(
    completion,
    originalToolCallId,
    promptToolCallId,
    resultFormat,
    stateHandler.getPrivacyMode(),
  )
  await turn.upsertToolCall(ctx, toolCall, recordedToolCallId)
  rootPromptExecutor.appendMessages(promptMessages)
  // An acknowledgement is not an answer, so the question stays open for the answer that follows.
  if (originalToolCallId.length > 0 && shouldReceiptAskQuestionResult(actionProtocolResult(completion))) {
    stateHandler.markAskQuestionCompleted(originalToolCallId)
  }
  return { outcome: "applied", recordedToolCallId, toolCall, promptMessages }
}

/** A success result as the tool's arguments spell it. */
function successResultShape(completion: AskQuestionCompletionAction & { readonly result: { readonly result: { readonly case: "success"; readonly value: { readonly answers: readonly RedactedAskQuestionSuccessAnswer[] } } } }): Record<string, unknown> {
  return {
    success: {
      answers: completion.result.result.value.answers.map(answer => ({
        question_id: answer.questionId,
        selected_option_ids: answer.selectedOptionIds,
        freeform_text: displayText(answer.freeformText),
      })),
    },
  }
}

/** A rejected result as the tool's arguments spell it. */
function rejectedResultShape(completion: AskQuestionCompletionAction & { readonly result: { readonly result: { readonly case: "rejected"; readonly value: { readonly reason: RedactedString } } } }): Record<string, unknown> {
  return { rejected: { reason: displayText(completion.result.result.value.reason) } }
}

/** An error result as the tool's arguments spell it. */
function errorResultShape(completion: AskQuestionCompletionAction & { readonly result: { readonly result: { readonly case: "error"; readonly value: { readonly errorMessage: RedactedString } } } }): Record<string, unknown> {
  return { error: { error_message: displayText(completion.result.result.value.errorMessage) } }
}

/** The answer as the session's tool expects it: a sentence, or the structured object. */
function formatCompletionResult(completion: AskQuestionCompletionAction, resultFormat: string): string {
  if (resultFormat === "formatted-string") {
    return completion.result ? formatAskQuestionResultAsString(protocolResult(completion.result)) : "Unknown error"
  }
  // The structured shape is written the way the tool's own arguments are spelled.
  switch (completion.result?.result.case) {
    case "success":
      return JSON.stringify(successResultShape(completion as never))
    case "rejected":
      return JSON.stringify(rejectedResultShape(completion as never))
    case "error":
      return JSON.stringify(errorResultShape(completion as never))
    default:
      return JSON.stringify({})
  }
}
