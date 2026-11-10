import assert from "node:assert/strict"
import { test } from "node:test"

import {
  buildWorktreeChangeAttachment,
  buildBranchChangeAttachment,
} from "../../source/packages/agent/git-diff-processing.ts"
import { GIT_DIFF_TRUNCATION_NOTICE } from "../../source/packages/constants/git-diff.ts"

test("working-tree and branch attachments retain separate envelopes", () => {
  const worktree = buildWorktreeChangeAttachment({ content: "diff --git a/a.ts b/a.ts\n+x", fullContentLengthCharCount: 30 })
  const branch = buildBranchChangeAttachment({ content: "diff --git a/a.ts b/a.ts\n+x", fullContentLengthCharCount: 30 })

  assert.equal(worktree.type, "text")
  assert.match(worktree.text, /^<git_diff>/)
  assert.match(branch.text, /^<git_diff_from_branch_to_main>/)
})

test("an oversized multi-file attachment keeps compact changes and names omitted files", () => {
  const content = [
    "diff --git a/short.ts b/short.ts\n+x",
    `diff --git a/large-a.ts b/large-a.ts\n${"a".repeat(30_000)}`,
    `diff --git a/large-b.ts b/large-b.ts\n${"b".repeat(30_000)}`,
  ].join("\n")

  const result = buildBranchChangeAttachment({ content, fullContentLengthCharCount: content.length })
  assert.match(result.text, /diff --git a\/short\.ts b\/short\.ts/)
  assert.match(result.text, /large-[ab]\.ts/)
  assert.equal(result.text.match(/diff truncated/g)?.length, 1)
})

test("an upstream-shortened attachment does not duplicate its truncation notice", () => {
  const result = buildBranchChangeAttachment({
    content: `diff --git a/a.ts b/a.ts\n+x${GIT_DIFF_TRUNCATION_NOTICE}`,
    fullContentLengthCharCount: 1_000,
  })

  assert.equal(result.text.match(/diff truncated/g)?.length, 1)
})
