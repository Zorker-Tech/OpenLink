import assert from "node:assert/strict"
import { test } from "node:test"

import { AgentType } from "../../source/packages/agent/utils/agent-config.ts"
import { GitStatusSection } from "../../source/packages/agent/prompts/git-status-section.ts"
import type { UserInfoGitRepository } from "../../source/packages/agent/prompts/user-info-data-contracts.ts"
import { renderContent } from "../../source/packages/prompt-jsx/render-prompt.ts"

const fence = String.fromCharCode(96).repeat(3)

const prompt = (args: {
  readonly repos?: readonly UserInfoGitRepository[]
  readonly statusRepos?: readonly UserInfoGitRepository[]
  readonly agentType?: AgentType
  readonly initialWorkingDirectory?: string
  readonly canManagePullRequests?: boolean
}) => renderContent(GitStatusSection({
  gitRepos: args.repos ?? [],
  gitReposWithStatus: args.statusRepos ?? [],
  agentType: args.agentType,
  initialWorkingDirectory: args.initialWorkingDirectory,
  toolInfo: args.canManagePullRequests ? { allTools: { PR_MANAGEMENT: {} } } : undefined,
}))

test("a single repository carries its path and the initial status snapshot", () => {
  const repository = { path: "/workspace/repo", status: "  M src/app.ts  " }
  const rendered = prompt({ repos: [repository], statusRepos: [repository] })
  assert.match(rendered, /^<git_status>/)
  assert.match(rendered, /This is the git status at the start of the conversation/)
  assert.match(rendered, /Git repo: \/workspace\/repo/)
  assert.ok(rendered.includes(fence + "\nM src/app.ts\n" + fence))
})

test("cloud workspaces list independent repositories and reveal sanitized remotes only with the PR tool", () => {
  const first = {
    path: "/workspace/one",
    status: " M one.ts",
    remoteUrl: "https://user:secret@github.com/team/one.git",
  }
  const second = {
    path: "/workspace/two",
    status: " M two.ts",
    remoteUrl: "https://github.com/team/two.git",
  }
  const remoteOnly = {
    path: "/workspace/three",
    status: "",
    remoteUrl: "https://github.com/team/three.git",
  }
  const repositories = [first, second, remoteOnly]
  const rendered = prompt({
    repos: repositories,
    statusRepos: [first, second],
    agentType: AgentType.BACKGROUND,
    initialWorkingDirectory: " /workspace/one ",
    canManagePullRequests: true,
  })

  assert.match(rendered, /multiple independent git repositories/)
  assert.match(rendered, /initial working directory is \/workspace\/one/)
  assert.match(rendered, /remote: https:\/\/github\.com\/team\/one\.git/)
  assert.match(rendered, /remote: https:\/\/github\.com\/team\/two\.git/)
  assert.match(rendered, /Git repo: \/workspace\/three/)
  assert.doesNotMatch(rendered, /secret/)
  assert.equal((rendered.match(/Git repo:/g) ?? []).length, 3)

  const local = prompt({
    repos: repositories,
    statusRepos: [first],
    agentType: AgentType.IDE,
    canManagePullRequests: true,
  })
  assert.doesNotMatch(local, /multiple independent git repositories/)
  assert.doesNotMatch(local, /remote:/)
  assert.doesNotMatch(local, /\/workspace\/three/)
})

test("long status is clipped at a line boundary and labeled", () => {
  const repository = {
    path: "/workspace/repo",
    status: "x".repeat(9_900) + "\npartial-entry" + "z".repeat(500),
  }
  const rendered = prompt({ repos: [repository], statusRepos: [repository] })
  assert.match(rendered, /\.\.\. \(git status truncated\)/)
  assert.doesNotMatch(rendered, /partial-entry/)
})
