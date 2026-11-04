import assert from "node:assert/strict"
import { test } from "node:test"

import { SelectedPullRequest } from "../../source/adapters/interop/proto/generated/agent/v1/selected_context_pb.ts"
import { projectSelectedPullRequestsForPrompt } from "../../source/adapters/interop/agent/pull-request-prompt-adapter.ts"

test("the prompt projection translates the stored summary into Slate's review context", () => {
  const selected = new SelectedPullRequest({
    number: 7,
    url: "https://review.example/7",
    title: "Fix",
    folderPath: "/workspace/review-7",
    summaryJson: JSON.stringify({
      headRef: "feature",
      baseRef: "main",
      description: "A change",
      totalFiles: 2,
      totalDiffLines: 30,
      totalDiffSizeBytes: 900,
      files: [
        { path: "src/a.ts", status: "modified", diffLines: 20, diffSizeChars: 600, originalSizeChars: 100 },
        { path: "src/b.ts", diffFileName: "custom.diff", status: "added", diffLines: 10, diffSizeBytes: 300 },
      ],
    }),
  })

  assert.deepEqual(projectSelectedPullRequestsForPrompt([selected]), [{
    number: 7,
    url: "https://review.example/7",
    title: "Fix",
    folderPath: "/workspace/review-7",
    summary: {
      kind: "available",
      value: {
        headBranch: "feature",
        baseBranch: "main",
        description: "A change",
        totalFiles: 2,
        totalDiffLines: 30,
        diffCharacters: 900,
        files: [
          {
            path: "src/a.ts",
            changeKind: "modified",
            changedLines: 20,
            diffCharacters: 600,
            originalCharacters: 100,
          },
          {
            path: "src/b.ts",
            diffFileName: "custom.diff",
            changeKind: "added",
            changedLines: 10,
            diffCharacters: 300,
          },
        ],
      },
    },
  }])
})

test("absent and malformed summaries stay distinct for prompt fallback", () => {
  const absent = new SelectedPullRequest({ number: 1, folderPath: "/workspace/one", description: "not the summary" })
  const malformed = new SelectedPullRequest({ number: 2, folderPath: "/workspace/two", summaryJson: "{not json" })
  const invalidEntry = new SelectedPullRequest({
    number: 3,
    folderPath: "/workspace/three",
    summaryJson: JSON.stringify({ files: [null] }),
  })

  assert.deepEqual(
    projectSelectedPullRequestsForPrompt([absent, malformed, invalidEntry]).map(({ summary }) => summary.kind),
    ["absent", "invalid", "invalid"],
  )
})
