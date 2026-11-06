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
import type { PrivacyMode } from "../../redaction/privacy-mode.ts"
import { PrivacyCapability } from "../../redaction/classification.ts"
import { toRedactedCoreMessages } from "../../redaction/message-redaction.ts"
import { isRedactedString, type RedactedString } from "../../redaction/redacted-values.ts"
import { isAskQuestionAutoAnswerReason } from "../../constants/ask-question.ts"
import {
  createAskQuestionCompletionToolCall,
  type InteropRedactedToolCall,
} from "../../../adapters/interop/agent/ask-question-result-adapter.ts"
import { formatAskQuestionOutcomeAsString } from "../../agent/tools/core/ask-question/outcome-format.ts"

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
  readonly privacyMode: PrivacyMode
  readonly originalToolCallId: string
  readonly originalArgs?: SlateAskQuestionArguments | undefined
  readonly result?: SlateAskQuestionCompletionResult | undefined
  readonly compatibility?: {
    readonly legacyResult?: unknown
    readonly legacyPayload?: Readonly<Record<string, unknown>>
  }
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
  readonly toolCall: InteropRedactedToolCall
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

function textValue(value: SlateAskQuestionText): string {
  return isRedactedString(value) ? displayText(value) : value
}

/** A completion is only a completion when it names the question and says what came of it. */
export function isValidAskQuestionCompletion(completion: AskQuestionCompletionAction): boolean {
  const resultKind = completion.result?.kind
  return completion.originalToolCallId.length > 0 &&
    (resultKind === "answered" || resultKind === "rejected" || resultKind === "error")
}

/** Whether this completion has already been written into the conversation. */
export function hasAppliedAskQuestionCompletion(
  stateHandler: AskQuestionCompletionStateHandler,
  originalToolCallId: string,
): boolean {
  return originalToolCallId.length > 0 && stateHandler.hasCompletedAskQuestion(originalToolCallId)
}

/** The arguments of the synthetic call, as the prompt's own tool would spell them. */
function plainAskArgs(completion: AskQuestionCompletionAction, originalToolCallId: string): Record<string, unknown> {
  return {
    title: completion.originalArgs?.title ? textValue(completion.originalArgs.title) : "",
    questions: completion.originalArgs?.questions.map(question => ({
      id: question.id,
      prompt: textValue(question.prompt),
      allow_multiple: question.allowMultiple,
      options: question.options.map(option => ({ id: option.id, label: textValue(option.label) })),
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
      resultKind: completion.result?.kind,
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
  const toolCall = createAskQuestionCompletionToolCall({ action: completion, originalToolCallId: recordedToolCallId })
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
  if (originalToolCallId.length > 0 && shouldReceiptAskQuestionCompletionResult(completion.result)) {
    stateHandler.markAskQuestionCompleted(originalToolCallId)
  }
  return { outcome: "applied", recordedToolCallId, toolCall, promptMessages }
}

/** A success result as the tool's arguments spell it. */
function successResultShape(result: Extract<SlateAskQuestionCompletionResult, { readonly kind: "answered" }>): Record<string, unknown> {
  return {
    success: {
      answers: result.answers.map(answer => ({
        question_id: answer.questionId,
        selected_option_ids: answer.selectedOptionIds,
        freeform_text: textValue(answer.freeformText),
      })),
    },
  }
}

/** A rejected result as the tool's arguments spell it. */
function rejectedResultShape(result: Extract<SlateAskQuestionCompletionResult, { readonly kind: "rejected" }>): Record<string, unknown> {
  return { rejected: { reason: textValue(result.reason) } }
}

/** An error result as the tool's arguments spell it. */
function errorResultShape(result: Extract<SlateAskQuestionCompletionResult, { readonly kind: "error" }>): Record<string, unknown> {
  return { error: { error_message: textValue(result.message) } }
}

/** The answer as the session's tool expects it: a sentence, or the structured object. */
function formatCompletionResult(completion: AskQuestionCompletionAction, resultFormat: string): string {
  const result = completion.result ?? { kind: "unknown" as const }
  if (resultFormat === "formatted-string") return formatAskQuestionOutcomeAsString(result)
  // The structured shape is written the way the tool's own arguments are spelled.
  switch (result.kind) {
    case "answered":
      return JSON.stringify(successResultShape(result))
    case "rejected":
      return JSON.stringify(rejectedResultShape(result))
    case "error":
      return JSON.stringify(errorResultShape(result))
    default:
      return JSON.stringify({})
  }
}

function shouldReceiptAskQuestionCompletionResult(result: SlateAskQuestionCompletionResult | undefined): boolean {
  if (result === undefined) return false
  switch (result.kind) {
    case "answered":
    case "error": return true
    case "rejected": return !isAskQuestionAutoAnswerReason(textValue(result.reason))
    default: return false
  }
}
