import assert from "node:assert/strict"
import { test } from "node:test"

import { createPullRequestPromptInputs } from "../../source/packages/agent/context/pull-request-prompt.ts"

test("the prompt projection translates the stored summary into Slate's review context", () => {
  const selected = {
    number: 7,
    url: "https://review.example/7",
    title: "Fix",
    localReviewDirectory: "/workspace/review-7",
    summaryDocument: JSON.stringify({
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
  }

  assert.deepEqual(createPullRequestPromptInputs([selected]), [{
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
  const absent = { number: 1, localReviewDirectory: "/workspace/one", description: "not the summary", url: "" }
  const malformed = { number: 2, localReviewDirectory: "/workspace/two", summaryDocument: "{not json", url: "" }
  const invalidEntry = {
    number: 3,
    localReviewDirectory: "/workspace/three",
    summaryDocument: JSON.stringify({ files: [null] }),
    url: "",
  }

  assert.deepEqual(
    createPullRequestPromptInputs([absent, malformed, invalidEntry]).map(({ summary }) => summary.kind),
    ["absent", "invalid", "invalid"],
  )
})
