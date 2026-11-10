import assert from "node:assert/strict"
import { test } from "node:test"

import { getGitWorkflowUserRules } from "../../source/packages/agent/prompts/git-workflow-rules.ts"

test("the commit guide keeps commits, hooks and history changes behind explicit user intent", () => {
  const [commit] = getGitWorkflowUserRules({ allTools: { SHELL: { name: "RunCommand" } } })
  assert.match(commit ?? "", /RunCommand/)
  assert.match(commit ?? "", /create a commit only when the user clearly asks/i)
  assert.match(commit ?? "", /leave git configuration unchanged/i)
  assert.match(commit ?? "", /bypass hooks/i)
  assert.match(commit ?? "", /force[- ]push.+main|main.+force[- ]push/i)
  assert.match(commit ?? "", /never amend the failed attempt/i)
  assert.match(commit ?? "", /not been pushed/i)
  assert.match(commit ?? "", /secret/i)
  assert.match(commit ?? "", /heredoc/i)
})

test("the pull request guide honors an existing host instruction and still returns a URL", () => {
  const [, pullRequest] = getGitWorkflowUserRules({ allTools: { SHELL: { name: "RunCommand" } } }, true)
  assert.match(pullRequest ?? "", /RunCommand/)
  assert.match(pullRequest ?? "", /GitHub/)
  assert.match(pullRequest ?? "", /preferred pull-request host/i)
  assert.match(pullRequest ?? "", /origin pr create/)
  assert.match(pullRequest ?? "", /--github or --origin/)
  assert.match(pullRequest ?? "", /base\.\.\.HEAD/)
  assert.match(pullRequest ?? "", /PR URL/i)
})
