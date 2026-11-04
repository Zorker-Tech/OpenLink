import assert from "node:assert/strict"
import test from "node:test"

import { SelectedGitPRDiffSelection } from "../../source/adapters/interop/proto/generated/agent/v1/selected_context_pb.ts"
import { toPrReviewInputs } from "../../source/adapters/interop/agent/selected-pr-review-adapter.ts"

test("hydrated pull-request selections become ordered prompt inputs without blob references", () => {
  assert.deepEqual(toPrReviewInputs([
    new SelectedGitPRDiffSelection({
      filePath: "src/a.ts",
      startLine: 3,
      endLine: 8,
      prUrl: "https://review.test/7",
      diffContent: "+new",
      blobId: new Uint8Array([1, 2]),
    }),
    new SelectedGitPRDiffSelection({
      filePath: "src/b.ts",
      startLine: 9,
      endLine: 9,
      prUrl: "https://review.test/7",
    }),
  ]), [
    { filePath: "src/a.ts", startLine: 3, endLine: 8, prUrl: "https://review.test/7", diffContent: "+new" },
    { filePath: "src/b.ts", startLine: 9, endLine: 9, prUrl: "https://review.test/7" },
  ])
})
