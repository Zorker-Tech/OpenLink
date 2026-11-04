import assert from "node:assert/strict"
import test from "node:test"

import { RunnerTurnAttempt } from "../../source/host/runner/runner-turn-attempt.ts"

test("only a plain re-send of an existing user message is recoverable before dispatch", () => {
  const recoverable = new RunnerTurnAttempt({
    generation: 7,
    prompt: "same text",
    runOptions: { messageId: "message-1", recentUserMessages: [{ id: "message-1", text: "same text" }] },
  })
  const hasAttachment = new RunnerTurnAttempt({
    generation: 7,
    prompt: "same text",
    runOptions: { messageId: "message-1", recentUserMessages: [{ id: "message-1", text: "same text" }], attachedFilePaths: ["/tmp/a"] },
  })

  assert.equal(recoverable.recoverableReplay, true)
  assert.equal(recoverable.dispatchStarted, false)
  recoverable.markStepDispatch()
  assert.equal(recoverable.dispatchStarted, true)
  assert.equal(hasAttachment.recoverableReplay, false)
})

test("the attempt records visible output, user selection pauses, and confirmed reactions", () => {
  const attempt = new RunnerTurnAttempt({ generation: 2, prompt: "work", runOptions: {} })
  const first = attempt.observe({ type: "text-delta", text: "partial" })
  const second = attempt.observe({ type: "thinking-delta", text: "reasoning" })
  const selection = attempt.observe({
    type: "send-message",
    message: { type: "widget" },
    timestampMs: 1,
  })
  attempt.noteReactionApplied(true)

  assert.equal(first.firstVisibleOutput, true)
  assert.equal(second.firstVisibleOutput, false)
  assert.equal(selection.needsUserInput, true)
  assert.deepEqual(attempt.outcome({ aborted: false }), {
    text: "partial",
    sentMessageCount: 1,
    reacted: true,
    aborted: false,
    awaitingUserSelection: true,
    streamOutputProduced: true,
  })
})

test("an empty attempt omits optional outcome flags", () => {
  const attempt = new RunnerTurnAttempt({ generation: 1, prompt: "hello", runOptions: {} })

  assert.deepEqual(attempt.outcome({ aborted: true }), {
    text: "",
    sentMessageCount: 0,
    reacted: false,
    aborted: true,
  })
})
