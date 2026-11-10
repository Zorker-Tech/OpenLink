import { test } from "node:test"
import assert from "node:assert/strict"

import { isInteropSummaryPromptMessage } from "../../source/adapters/interop/agent/summarize-action-adapter.ts"

test("summary detection stays with the provider-only prompt marker", () => {
  assert.equal(isInteropSummaryPromptMessage({ role: "user", providerOptions: { slate: { isSummary: true } } }), true)
  assert.equal(isInteropSummaryPromptMessage({ role: "assistant", providerOptions: { slate: { isSummary: true } } }), false)
  assert.equal(isInteropSummaryPromptMessage({ role: "user", providerOptions: { slate: { isSummary: false } } }), false)
  assert.equal(isInteropSummaryPromptMessage({ role: "user" }), false)
  assert.equal(isInteropSummaryPromptMessage(null), false)
})
