import assert from "node:assert/strict"
import { test } from "node:test"

import { formatAskQuestionOutcomeAsString } from "../../source/packages/agent/tools/core/ask-question/outcome-format.ts"
import type { SlateAskQuestionOutcome } from "../../source/packages/agent/tools/core/ask-question/outcome-format.ts"

test("answer options and freeform text are rendered as one entry per question", () => {
  const result: SlateAskQuestionOutcome = {
    kind: "answered",
    answers: [
      { questionId: "q1", selectedOptionIds: ["a", "b"], freeformText: "add details" },
      { questionId: "q2", selectedOptionIds: [], freeformText: "typed answer" },
      { questionId: "q3", selectedOptionIds: ["c"] },
      { questionId: "q4", selectedOptionIds: [] },
    ],
  }
  const text = formatAskQuestionOutcomeAsString(result)

  assert.match(text, /Question q1: Selected option\(s\) a, b, freeform: add details/)
  assert.match(text, /Question q2: typed answer/)
  assert.match(text, /Question q3: Selected option\(s\) c/)
  assert.match(text, /Question q4: No answer provided/)
})

test("async, rejected, unavailable and too-early outcomes keep their separate meaning", () => {
  assert.match(formatAskQuestionOutcomeAsString({ kind: "async" }), /sent to the user asynchronously/)
  assert.equal(formatAskQuestionOutcomeAsString({ kind: "rejected", reason: "  skipped  " }), "skipped")
  assert.match(formatAskQuestionOutcomeAsString({ kind: "rejected" }), /Questions skipped by the user/)
  assert.equal(formatAskQuestionOutcomeAsString({ kind: "unknown" }), "Unknown error")
  assert.match(
    formatAskQuestionOutcomeAsString({ kind: "error", message: "", askWasTooEarly: true }),
    /research.*before asking the user/i,
  )
  assert.match(
    formatAskQuestionOutcomeAsString({ kind: "error", message: "offline", askWasTooEarly: false }),
    /^Error: offline$/,
  )
})
