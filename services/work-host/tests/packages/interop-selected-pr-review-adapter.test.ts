import assert from "node:assert/strict"
import test from "node:test"

import { toPrReviewInputs } from "../../source/packages/agent/context/pr-review-context.ts"

test("hydrated pull-request selections become ordered prompt inputs without blob references", () => {
  assert.deepEqual(toPrReviewInputs([
    {
      filePath: "src/a.ts",
      startLine: 3,
      endLine: 8,
      url: "https://review.test/7",
      diff: "+new",
      blobId: new Uint8Array([1, 2]),
    },
    {
      filePath: "src/b.ts",
      startLine: 9,
      endLine: 9,
      url: "https://review.test/7",
    },
  ]), [
    { filePath: "src/a.ts", startLine: 3, endLine: 8, prUrl: "https://review.test/7", diffContent: "+new" },
    { filePath: "src/b.ts", startLine: 9, endLine: 9, prUrl: "https://review.test/7" },
  ])
})
