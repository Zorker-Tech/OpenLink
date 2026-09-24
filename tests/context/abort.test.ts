import { test } from "node:test"
import assert from "node:assert/strict"

import { getAbortReasonInfo } from "../../source/packages/context/abort.ts"

test("an Error reason keeps its name and message", () => {
  const reason = new TypeError("not a function")
  assert.deepEqual(getAbortReasonInfo(reason), {
    abortReasonType: "error",
    abortReasonName: "TypeError",
    abortReasonMessage: "not a function",
  })
})

test("a DOMException from an AbortController is reported like any other error", () => {
  const controller = new AbortController()
  controller.abort()
  const description = getAbortReasonInfo(controller.signal.reason)
  assert.equal(description.abortReasonType, "error")
  assert.equal((description as { abortReasonName?: string }).abortReasonName, "AbortError")
})

test("string, undefined and other reasons are described without inventing a message", () => {
  assert.deepEqual(getAbortReasonInfo("superseded"), {
    abortReasonType: "string",
    abortReasonMessage: "superseded",
  })
  assert.deepEqual(getAbortReasonInfo(undefined), { abortReasonType: "undefined" })
  assert.deepEqual(getAbortReasonInfo(42), { abortReasonType: "number" })
  assert.deepEqual(getAbortReasonInfo({ why: "nested" }), { abortReasonType: "object" })
})
