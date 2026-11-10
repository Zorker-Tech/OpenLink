import assert from "node:assert/strict"
import test from "node:test"
import type { PromptExecutor, PromptMessage } from "../../source/packages/chat-inference/base.ts"
import {
  CONTINUATION_MESSAGE,
  ContinuationInjectorMiddleware,
  isEmptyAssistantMessage,
  needsContinuationMessage,
} from "../../source/packages/chat-inference/middleware/continuation-injector-middleware.ts"

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
    clearMessages: () => { messages.length = 0 },
    stream(...args) {
      calls.push(["stream", ...args])
      return result
    },
  }
  return { middleware: new ContinuationInjectorMiddleware(inner), calls, messages, result }
}

test("only a non-empty final assistant message needs a continuation", () => {
  assert.equal(isEmptyAssistantMessage({ role: "assistant", content: "" }), true)
  assert.equal(isEmptyAssistantMessage({ role: "assistant", content: [] }), true)
  assert.equal(isEmptyAssistantMessage({ role: "user", content: "" }), false)
  assert.equal(needsContinuationMessage([]), false)
  assert.equal(needsContinuationMessage([{ role: "assistant", content: "answer" }]), true)
  assert.equal(needsContinuationMessage([{ role: "assistant", content: "answer" }, { role: "assistant", content: "" }]), false)
  assert.equal(needsContinuationMessage([{ role: "assistant", content: "answer" }, { role: "user", content: "next" }]), false)
})

test("a continuation is appended before streaming and the executor result is forwarded", () => {
  const run = executor([{ role: "assistant", content: "partial answer" }])
  const originalInfo = console.info
  const logs: unknown[][] = []
  console.info = (...args: unknown[]) => { logs.push(args) }
  const context = { request: 1 }
  const options = { retry: true }

  try {
    assert.equal(run.middleware.stream(context, options), run.result)
  } finally {
    console.info = originalInfo
  }

  assert.deepEqual(run.calls, [
    ["append", { role: "user", content: CONTINUATION_MESSAGE }],
    ["stream", context, options],
  ])
  assert.deepEqual(run.messages.at(-1), { role: "user", content: CONTINUATION_MESSAGE })
  assert.match(CONTINUATION_MESSAGE, /without repeating completed work/)
  assert.equal(logs.length, 1)
  assert.match(String(logs[0]?.[0]), /continuing the turn/)
  assert.deepEqual(logs[0]?.[1], { messageCount: 1 })
})

test("a user or empty assistant ending is forwarded without changing the prompt", () => {
  for (const last of [{ role: "user", content: "continue" }, { role: "assistant", content: "" }]) {
    const run = executor([last])
    const result = run.middleware.stream()

    assert.equal(result, run.result)
    assert.deepEqual(run.calls, [["stream"]])
    assert.deepEqual(run.messages, [last])
  }
})
