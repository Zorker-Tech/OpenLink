import assert from "node:assert/strict"
import test from "node:test"
import type { PromptExecutor, PromptMessage } from "../../source/packages/chat-inference/base.ts"
import {
  removeTrailingEmptyAssistantMessages,
  TrailingEmptyAssistantRemovalMiddleware,
} from "../../source/packages/chat-inference/middleware/trailing-empty-assistant-removal-middleware.ts"

function executor(initial: PromptMessage[]) {
  const messages = [...initial]
  const calls: unknown[][] = []
  const result = { stream: true }
  const inner: PromptExecutor<PromptMessage> = {
    appendMessages(input) {
      calls.push(["append", input])
      messages.push(...(Array.isArray(input) ? input : [input as PromptMessage]))
      return inner
    },
    getState: () => messages,
    getMessages: () => [...messages],
    clearMessages() {
      calls.push(["clear"])
      messages.length = 0
    },
    stream(...args) {
      calls.push(["stream", ...args])
      return result
    },
  }
  return { middleware: new TrailingEmptyAssistantRemovalMiddleware(inner), calls, messages, result }
}

test("only empty assistant messages at the end are removed, without mutating the input list", () => {
  const messages: PromptMessage[] = [
    { role: "assistant", content: "finished" },
    { role: "assistant", content: "" },
    { role: "assistant", content: [] },
  ]
  const result = removeTrailingEmptyAssistantMessages(messages)

  assert.deepEqual(result, { cleanedMessages: [{ role: "assistant", content: "finished" }], removedMessageCount: 2 })
  assert.equal(messages.length, 3)
  assert.deepEqual(removeTrailingEmptyAssistantMessages([{ role: "user", content: "" }]), {
    cleanedMessages: [{ role: "user", content: "" }],
    removedMessageCount: 0,
  })
})

test("the middleware clears and restores messages only when it removed a trailing turn", () => {
  const run = executor([
    { role: "user", content: "question" },
    { role: "assistant", content: "" },
  ])
  const context = { turn: 3 }
  const options = { retry: true }

  assert.equal(run.middleware.stream(context, options), run.result)
  assert.deepEqual(run.calls, [
    ["clear"],
    ["append", [{ role: "user", content: "question" }]],
    ["stream", context, options],
  ])
  assert.deepEqual(run.messages, [{ role: "user", content: "question" }])
})

test("an empty remainder clears the buffer without appending a replacement", () => {
  const run = executor([{ role: "assistant", content: "" }, { role: "assistant", content: [] }])

  run.middleware.stream()

  assert.deepEqual(run.calls, [["clear"], ["stream"]])
  assert.deepEqual(run.messages, [])
})

test("a complete assistant response leaves the prompt buffer untouched", () => {
  const run = executor([{ role: "assistant", content: "answer" }])

  run.middleware.stream()

  assert.deepEqual(run.calls, [["stream"]])
  assert.deepEqual(run.messages, [{ role: "assistant", content: "answer" }])
})
