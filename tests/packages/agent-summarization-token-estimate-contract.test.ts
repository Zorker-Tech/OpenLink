import assert from "node:assert/strict"
import { test } from "node:test"

import { estimateTokenCount, type TokenEstimateMessage } from "../../source/packages/agent-summarization/token-estimate.ts"

test("non-text payload categories contribute only when requested and carry their framing allowance", () => {
  const message: TokenEstimateMessage = {
    role: "assistant",
    content: [
      { type: "text", text: "ab" },
      { type: "tool-call", args: new Uint8Array([1, 2, 3]) },
      { type: "tool-result", result: { length: 2 } },
      { type: "unknown", data: new Uint8Array([4, 5, 6, 7]) },
      { type: "image", data: "ignored" },
    ],
  }

  assert.equal(estimateTokenCount([message]), Math.ceil((2 + 25) / 2.5))
  assert.equal(estimateTokenCount([message], { includeNonTextContent: true }), Math.ceil((2 + 3 + 50 + 2 + 50 + 4 + 25) / 2.5))
})

test("custom text measurement is used only on the text-only path", () => {
  const message: TokenEstimateMessage = { role: "user", content: [{ type: "text", text: "words" }] }
  const visited: TokenEstimateMessage[] = []
  const textOnly = estimateTokenCount([message], { textContentLengthFn: (value) => (visited.push(value), 20) })

  assert.equal(textOnly, Math.ceil((20 + 25) / 2.5))
  assert.deepEqual(visited, [message])

  visited.length = 0
  const withParts = estimateTokenCount([message], { includeNonTextContent: true, textContentLengthFn: (value) => (visited.push(value), 999) })
  assert.equal(withParts, Math.ceil((5 + 25) / 2.5))
  assert.deepEqual(visited, [])
})

test("length probes with a nonnumeric or throwing length do not add payload characters", () => {
  const nonnumeric = { length: "12" }
  const throwing = Object.defineProperty({}, "length", { get() { throw new Error("unreadable") } })
  const content: TokenEstimateMessage = {
    role: "user",
    content: [
      { type: "tool-call", args: nonnumeric },
      { type: "tool-result", result: throwing },
    ],
  }

  assert.equal(estimateTokenCount([content], { includeNonTextContent: true }), Math.ceil((50 + 50 + 25) / 2.5))
})

test("every message pays framing overhead even when its content cannot be measured", () => {
  assert.equal(estimateTokenCount([
    { role: "user", content: null },
    { role: "assistant", content: 42 },
  ]), Math.ceil((25 + 25) / 2.5))
})
