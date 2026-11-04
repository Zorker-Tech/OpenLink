import { test } from "node:test"
import assert from "node:assert/strict"

import { summarizeAbortReason } from "../../source/packages/context/abort.ts"

test("an Error reason keeps its name and message", () => {
  const reason = new TypeError("not a function")
  assert.deepEqual(summarizeAbortReason(reason), {
    abortReasonType: "error",
    abortReasonName: "TypeError",
    abortReasonMessage: "not a function",
  })
})

test("a DOMException from an AbortController is reported like any other error", () => {
  const controller = new AbortController()
  controller.abort()
  const description = summarizeAbortReason(controller.signal.reason)
  assert.equal(description.abortReasonType, "error")
  assert.equal((description as { abortReasonName?: string }).abortReasonName, "AbortError")
})

test("string, undefined and other reasons are described without inventing a message", () => {
  assert.deepEqual(summarizeAbortReason("superseded"), {
    abortReasonType: "string",
    abortReasonMessage: "superseded",
  })
  assert.deepEqual(summarizeAbortReason(undefined), { abortReasonType: "undefined" })
  assert.deepEqual(summarizeAbortReason(42), { abortReasonType: "number" })
  assert.deepEqual(summarizeAbortReason(null), { abortReasonType: "object" })
  assert.deepEqual(summarizeAbortReason({ why: "nested" }), { abortReasonType: "object" })
})
