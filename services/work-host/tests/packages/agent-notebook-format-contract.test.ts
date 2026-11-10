import assert from "node:assert/strict"
import { test } from "node:test"

import { formatNotebookForLLM } from "../../source/packages/agent/tools/core/read/notebook-format.ts"

test("output text from several result blocks stays in order with a single separator", () => {
  const notebook = JSON.stringify({
    cells: [{
      cell_type: "code",
      source: "print('ok')",
      outputs: [
        { output_type: "stream", text: "first" },
        { output_type: "stream", text: "second\n" },
        { output_type: "stream", text: "third" },
      ],
    }],
  })
  const rendered = formatNotebookForLLM(notebook)
  assert.match(rendered, /first\nsecond\nthird/)
})

test("hitting the per-cell ceiling still announces text omitted from later outputs", () => {
  const notebook = JSON.stringify({
    cells: [{
      cell_type: "code",
      source: "print('large')",
      outputs: [
        { output_type: "stream", text: "x".repeat(2_000) },
        { output_type: "stream", text: "omitted tail" },
      ],
    }],
  })
  const rendered = formatNotebookForLLM(notebook)
  assert.match(rendered, /truncated at 2000 chars/)
  assert.doesNotMatch(rendered, /omitted tail/)
})
