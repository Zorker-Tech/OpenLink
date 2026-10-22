import { test } from "node:test"
import assert from "node:assert/strict"

import {
  applyAskQuestionCompletion,
  hasAppliedAskQuestionCompletion,
  isValidAskQuestionCompletion,
  type AskQuestionCompletionAction,
} from "../../source/packages/agent/actions/ask-question-completion.ts"
import { createContext, type Context } from "../../source/packages/context/context.ts"
import { createRedactedString } from "../../source/packages/redaction/create.ts"
import { DataClassification, PrivacyCapability } from "../../source/packages/redaction/classification.ts"
import { PrivacyMode } from "../../source/packages/redaction/privacy-mode.ts"
import { fromRedactedCoreMessages } from "../../source/packages/redaction/message-redaction.ts"
import { ASK_QUESTION_AUTO_ANSWER_REASON_BODY } from "../../source/packages/constants/ask-question.ts"

// ---------------------------------------------------------------------------------------------
// a completion, and the three places it is written to
// ---------------------------------------------------------------------------------------------

const redacted = (value: string, field: string) => createRedactedString(value, DataClassification.CODE, field, PrivacyMode.NO_STORAGE)

const questionArgs = (): NonNullable<AskQuestionCompletionAction["originalArgs"]> => ({
  title: redacted("Which database?", "title"),
  questions: [{
    id: "q1",
    prompt: redacted("Which database should this use?", "prompt"),
    allowMultiple: false,
    options: [
      { id: "opt-postgres", label: redacted("Postgres", "label") },
      { id: "opt-sqlite", label: redacted("SQLite", "label") },
    ],
  }],
})

const successResult = (): NonNullable<AskQuestionCompletionAction["result"]> => ({
  result: {
    case: "success",
    value: {
      answers: [{
        questionId: "q1",
        selectedOptionIds: ["opt-postgres"],
        freeformText: redacted("or maybe a managed service", "freeform"),
      }],
    },
  },
})

function action(overrides: Partial<AskQuestionCompletionAction> = {}): AskQuestionCompletionAction {
  return {
    _privacyMode: PrivacyMode.NO_STORAGE,
    originalToolCallId: "tool-call-1",
    originalArgs: questionArgs(),
    result: successResult(),
    ...overrides,
  }
}

interface Harness {
  readonly completed: string[]
  readonly upserted: Array<{ toolCallId: string; tool: unknown }>
  readonly appended: unknown[][]
  readonly stateHandler: {
    hasCompletedAskQuestion(toolCallId: string): boolean
    markAskQuestionCompleted(toolCallId: string): void
    getPrivacyMode(): PrivacyMode
  }
  readonly turn: { upsertToolCall(ctx: Context, toolCall: unknown, toolCallId: string): Promise<unknown> }
  readonly rootPromptExecutor: { appendMessages(messages: readonly unknown[]): unknown }
}

function harness(): Harness {
  const completed: string[] = []
  const upserted: Harness["upserted"] = []
  const appended: unknown[][] = []
  return {
    completed,
    upserted,
    appended,
    stateHandler: {
      hasCompletedAskQuestion: toolCallId => completed.includes(toolCallId),
      markAskQuestionCompleted: toolCallId => { completed.push(toolCallId) },
      getPrivacyMode: () => PrivacyMode.NO_STORAGE,
    },
    turn: {
      async upsertToolCall(_ctx, toolCall, toolCallId) {
        upserted.push({ toolCallId, tool: toolCall })
        return {}
      },
    },
    rootPromptExecutor: {
      appendMessages(messages) { appended.push([...messages]); return {} },
    },
  }
}

const apply = (harnessed: Harness, completion: AskQuestionCompletionAction, resultFormat = "formatted-string") =>
  applyAskQuestionCompletion(createContext(), {
    action: completion,
    stateHandler: harnessed.stateHandler,
    turn: harnessed.turn,
    rootPromptExecutor: harnessed.rootPromptExecutor,
    resultFormat,
  })

/** The messages written into the conversation are stored redacted, so they are unwrapped to be read. */
const plainMessages = (messages: unknown[]): Array<{ role: string; content: Array<Record<string, unknown>> }> =>
  fromRedactedCoreMessages(messages as never, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED) as never

// ---------------------------------------------------------------------------------------------
// what counts as a completion
// ---------------------------------------------------------------------------------------------

test("a completion names the question and says what came of it", () => {
  assert.equal(isValidAskQuestionCompletion(action()), true)
  assert.equal(isValidAskQuestionCompletion(action({ result: { result: { case: "rejected", value: { reason: redacted("no", "reason") } } } })), true)
  assert.equal(isValidAskQuestionCompletion(action({ result: { result: { case: "error", value: { errorMessage: redacted("broken", "error") } } } })), true)
})

test("a completion with no question to attach to, or with nothing that happened, is not one", () => {
  assert.equal(isValidAskQuestionCompletion(action({ originalToolCallId: "" })), false)
  assert.equal(isValidAskQuestionCompletion(action({ result: undefined })), false)
  assert.equal(isValidAskQuestionCompletion(action({ result: { result: { case: "async", value: {} } } })), false)
})

test("a question that was already answered is not answered again", () => {
  const harnessed = harness()
  harnessed.completed.push("tool-call-1")
  assert.equal(hasAppliedAskQuestionCompletion(harnessed.stateHandler, "tool-call-1"), true)
  assert.equal(hasAppliedAskQuestionCompletion(harnessed.stateHandler, "tool-call-2"), false)
  assert.equal(hasAppliedAskQuestionCompletion(harnessed.stateHandler, ""), false)
})

// ---------------------------------------------------------------------------------------------
// writing the answer into the conversation
// ---------------------------------------------------------------------------------------------

test("an answer is written as the call and the result the turn would have produced", async () => {
  const harnessed = harness()
  const applied = await apply(harnessed, action())

  assert.equal(applied.outcome, "applied")
  if (applied.outcome !== "applied") return
  assert.equal(applied.recordedToolCallId, "tool-call-1")
  assert.deepEqual(harnessed.completed, ["tool-call-1"])
  assert.equal(harnessed.upserted.length, 1)
  assert.equal(harnessed.upserted[0]?.toolCallId, "tool-call-1")

  const messages = plainMessages(harnessed.appended.flat())
  assert.deepEqual(messages.map(message => message.role), ["assistant", "tool"])
  const call = messages[0]?.content[0]
  assert.equal(call?.toolName, "ask_question")
  // The question is the one that was asked, rebuilt from the action.
  const args = call?.args as { title: string; questions: Array<{ id: string; prompt: string; options: Array<{ id: string; label: string }> }>; async_original_tool_call_id: string }
  assert.equal(args.title, "Which database?")
  assert.equal(args.questions[0]?.prompt, "Which database should this use?")
  assert.deepEqual(args.questions[0]?.options.map(option => option.label), ["Postgres", "SQLite"])
  assert.equal(args.async_original_tool_call_id, "tool-call-1")

  // The call and the result share one id, which is what ties them together in the transcript.
  assert.equal(messages[1]?.content[0]?.toolCallId, call?.toolCallId)
  // The formatted sentence names the options by their ids, which is what the tool's own result carries.
  assert.match(String(messages[1]?.content[0]?.result), /Selected option\(s\) opt-postgres/)
  assert.match(String(messages[1]?.content[0]?.result), /or maybe a managed service/)
})

test("the answer is written the way the session's tool reads results", async () => {
  const formatted = harness()
  await apply(formatted, action())
  const formattedResult = plainMessages(formatted.appended.flat())[1]?.content[0]?.result
  assert.equal(typeof formattedResult, "string")

  const structured = harness()
  await apply(structured, action(), "structured")
  // The structured form is written as JSON and read back as the object it describes.
  assert.deepEqual(plainMessages(structured.appended.flat())[1]?.content[0]?.result, {
    success: {
      answers: [{
        question_id: "q1",
        selected_option_ids: ["opt-postgres"],
        freeform_text: "or maybe a managed service",
      }],
    },
  })
})

test("a refusal and a failure are written in the shape the caller asked for", async () => {
  const rejected = harness()
  await apply(rejected, action({ result: { result: { case: "rejected", value: { reason: redacted("the user closed it", "reason") } } } }), "structured")
  assert.deepEqual(
    plainMessages(rejected.appended.flat())[1]?.content[0]?.result,
    { rejected: { reason: "the user closed it" } },
  )

  const errored = harness()
  await apply(errored, action({ result: { result: { case: "error", value: { errorMessage: redacted("the client went away", "error") } } } }), "structured")
  assert.deepEqual(
    plainMessages(errored.appended.flat())[1]?.content[0]?.result,
    { error: { error_message: "the client went away" } },
  )
})

test("a completion with no question details still writes the answer", async () => {
  const harnessed = harness()
  const applied = await apply(harnessed, action({ originalArgs: undefined }))
  assert.equal(applied.outcome, "applied")
  const args = plainMessages(harnessed.appended.flat())[0]?.content[0]?.args as { title: string; questions: unknown[] }
  assert.equal(args.title, "")
  assert.deepEqual(args.questions, [])
})

// ---------------------------------------------------------------------------------------------
// what is refused
// ---------------------------------------------------------------------------------------------

test("a completion that is not one is dropped without being written", async () => {
  const harnessed = harness()
  const applied = await apply(harnessed, action({ originalToolCallId: "" }))
  assert.deepEqual(applied, { outcome: "invalid" })
  assert.deepEqual(harnessed.appended, [])
  assert.deepEqual(harnessed.upserted, [])
  assert.deepEqual(harnessed.completed, [])
})

test("an answer that already arrived is not written twice", async () => {
  const harnessed = harness()
  harnessed.completed.push("tool-call-1")
  const applied = await apply(harnessed, action())
  assert.deepEqual(applied, { outcome: "already-applied" })
  assert.deepEqual(harnessed.appended, [])
  assert.deepEqual(harnessed.upserted, [])
})

test("an answer nobody gave leaves the question open", async () => {
  // A question that timed out and was answered by the platform itself is written into the conversation —
  // the model has to know the turn moved on — but it is not receipted, so a real answer can still arrive.
  const harnessed = harness()
  const applied = await apply(harnessed, action({
    result: { result: { case: "rejected", value: { reason: redacted(ASK_QUESTION_AUTO_ANSWER_REASON_BODY, "reason") } } },
  }))
  assert.equal(applied.outcome, "applied")
  assert.deepEqual(harnessed.completed, [])
  assert.equal(harnessed.appended.length, 1)
})

test("a completion with no id of its own is recorded under a fresh one", async () => {
  const harnessed = harness()
  const applied = await apply(harnessed, action({ originalToolCallId: "tool-call-9" }))
  assert.equal(applied.outcome, "applied")
  if (applied.outcome !== "applied") return
  assert.equal(applied.recordedToolCallId, "tool-call-9")
  assert.equal(harnessed.upserted[0]?.toolCallId, "tool-call-9")
})

test("an empty question id was never applied, whatever the session remembers", () => {
  const stateHandler = { hasCompletedAskQuestion: () => true, markAskQuestionCompleted: () => {}, getPrivacyMode: () => PrivacyMode.NO_STORAGE }
  assert.equal(hasAppliedAskQuestionCompletion(stateHandler, ""), false)
})

test("the conversation is told the ask in the tool's own spelling, call first", async () => {
  const events: string[] = []
  const applied: unknown[][] = []
  const upserted: unknown[] = []
  void upserted
  const result = await applyAskQuestionCompletion(createContext(), {
    action: action(),
    stateHandler: { hasCompletedAskQuestion: () => false, markAskQuestionCompleted: () => {}, getPrivacyMode: () => PrivacyMode.NO_STORAGE },
    turn: { async upsertToolCall(_ctx, toolCall, toolCallId) { events.push("upsert"); upserted.push([toolCallId, toolCall]); return {} } },
    rootPromptExecutor: { appendMessages(messages) { events.push("append"); applied.push([...messages]); return {} } },
    resultFormat: "structured",
  })
  assert.deepEqual(events, ["upsert", "append"], "the call is recorded before the messages are appended")
  assert.equal(result.outcome, "applied")
  const messages = plainMessages(applied[0]!)
  assert.equal(messages.length, 2)
  assert.equal(messages[0]?.role, "assistant")
  assert.equal(messages[0]?.content[0]?.type, "tool-call")
  assert.equal(messages[1]?.role, "tool")
  assert.equal(messages[1]?.content[0]?.type, "tool-result")
  assert.equal(messages[0]?.content[0]?.toolCallId, messages[1]?.content[0]?.toolCallId, "the call and its result share one id")
  const args = messages[0]?.content[0]?.args as Record<string, unknown>
  assert.equal(args.title, "Which database?")
  assert.equal(args.async_original_tool_call_id, "tool-call-1")
  const questions = args.questions as Array<Record<string, unknown>>
  assert.equal(questions[0]?.allow_multiple, false)
  const options = questions[0]?.options as Array<Record<string, unknown>>
  assert.deepEqual(options.map(option => option.label), ["Postgres", "SQLite"])
})
