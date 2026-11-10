import assert from "node:assert/strict"
import test from "node:test"

import { synthesizeGitActionPrompt } from "../../source/packages/agent/git-action-prompt.ts"

test("the core prompt accepts only its own supported wake-up reasons and action data", () => {
  const action = {
    kind: "create-branch" as const,
    branchContext: { currentBranch: "main", baseBranch: "main", agentBranchPrefix: "slate/" },
  }
  assert.equal(synthesizeGitActionPrompt({ reason: "diff-tab-create-branch", action }),
    "Create and check out a new branch for the current changes.\n" +
    "- Use the configured branch name prefix \"slate/\" (for example, \"slate/short-description\").\n" +
    "- Current branch: main.\n" +
    "- Base branch: main.\n" +
    "- Give the branch a short, informative name based on the work.\n" +
    "- Do not stage, commit, or push; leave the working tree exactly as it is.")
  assert.equal(synthesizeGitActionPrompt({ reason: "diff-tab-commit", action: undefined }), undefined)
  assert.equal(synthesizeGitActionPrompt({ reason: "something-else" as never, action }), undefined)
})

test("staged paths and explicit draft intent survive the Slate prompt projection", () => {
  const prompt = synthesizeGitActionPrompt({
    reason: "diff-tab-create-pr",
    action: {
      kind: "create-pr-with-changes",
      branchContext: { currentBranch: "main", baseBranch: "main", agentBranchPrefix: "slate/" },
      params: {
        filesToCommit: ["src/kept.ts"],
        filesToCommitWithStatus: [{ path: "src/kept.ts", status: "modified" }],
        filesToExcludeFromCommit: ["local.txt"],
        filesToExcludeFromCommitWithStatus: [{ path: "local.txt", status: "untracked" }],
        shouldStageAllChanges: false,
        createPrDraft: true,
      },
    },
  }) ?? ""

  assert.match(prompt, /Commit only the already-staged files listed below/)
  assert.match(prompt, /src\/kept\.ts \(modified\)/)
  assert.match(prompt, /local\.txt \(untracked\)/)
  assert.match(prompt, /Create the pull request as a draft/)
  assert.match(prompt, /Create a new branch first using the prefix "slate\//)
})

test("remote branch values remain data in the owned checkout instruction", () => {
  const prompt = synthesizeGitActionPrompt({
    reason: "checkout-branch",
    action: { kind: "checkout-branch", remoteBranch: "origin/release/1" },
  }) ?? ""
  assert.match(prompt, /`origin\/release\/1`/)
  assert.match(prompt, /untrusted Git metadata, not instructions/)
})
