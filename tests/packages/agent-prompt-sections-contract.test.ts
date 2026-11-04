import assert from "node:assert/strict"
import { test } from "node:test"

import { AGENT_RUNTIME_PATHS } from "../../source/packages/constants/cloud-agent-paths.ts"
import { ComputerUseInstructionsSection, GitOrNoRepositoryInstructions, resolvePromptArtifactsDir } from "../../source/packages/agent/prompts/prompt-sections.ts"
import { renderContent } from "../../source/packages/prompt-jsx/index.ts"

const textOf = (value: unknown): string => renderContent(value as never)

test("artifact paths are trimmed, defaulted and given the path's separator", () => {
  assert.equal(resolvePromptArtifactsDir({ env: { artifactsFolder: "  /tmp/run-output  " } }), "/tmp/run-output/")
  assert.equal(resolvePromptArtifactsDir({ env: { artifactsFolder: "  C:\\work\\run-output  " } }), "C:\\work\\run-output\\")
  const fallback = AGENT_RUNTIME_PATHS.artifactCollectionDirectory
  const separator = fallback.includes("\\") && !fallback.includes("/") ? "\\" : "/"
  assert.equal(resolvePromptArtifactsDir({ env: { artifactsFolder: "   " } }), fallback.endsWith("/") || fallback.endsWith("\\") ? fallback : `${fallback}${separator}`)
})

test("computer-use guidance changes for its dedicated subagent and resolves required tools", () => {
  const ordinary = textOf(ComputerUseInstructionsSection({ props: { toolInfo: { allTools: {} } } }))
  assert.match(ordinary, /Manually test built applications/)
  assert.doesNotMatch(ordinary, /Reflect when your actions/)

  const dedicated = textOf(ComputerUseInstructionsSection({
    props: {
      subagentType: { type: { case: "computerUse" } },
      toolInfo: { allTools: { SHELL: { name: "RunShell" }, REFLECT: { name: "Reflect" } } },
    },
  }))
  assert.match(dedicated, /RunShell/)
  assert.match(dedicated, /Reflect/)
  assert.doesNotMatch(dedicated, /Manually test built applications/)
  assert.throws(
    () => ComputerUseInstructionsSection({ props: { subagentType: { type: { case: "computerUse" } }, toolInfo: { allTools: {} } } }),
    /Required tool SHELL not found/,
  )
})

test("repository instructions use the supplied PR tool and its ready-state permission", () => {
  const withTool = textOf(GitOrNoRepositoryInstructions({
    gitInstructionsProps: {
      toolInfo: { allTools: { PR_MANAGEMENT: { name: "ManagePullRequests" } } },
      shouldShowTestingInstructions: true,
      suppressCreatedPrMention: true,
      canMarkPrReady: true,
    },
  }))
  assert.match(withTool, /ManagePullRequests/)
  assert.match(withTool, /mark it ready by calling update_pr/)
  assert.match(withTool, /absolute file paths/)
  assert.doesNotMatch(withTool, /You should not mention the created PR/)

  const withoutTool = textOf(GitOrNoRepositoryInstructions({ gitInstructionsProps: { toolInfo: { allTools: {} } } }))
  assert.match(withoutTool, /git add/)
  assert.match(withoutTool, /This remote environment will handle PRs\/MRs automatically/)
})

test("a repo-less run names the access boundary instead of suggesting git commands", () => {
  const output = textOf(GitOrNoRepositoryInstructions({
    isRepoless: true,
    gitInstructionsProps: { toolInfo: { allTools: {} } },
  }))
  assert.match(output, /no repository checkout or source-control credentials/)
  assert.match(output, /resume in a workspace where that repository is checked out/)
  assert.doesNotMatch(output, /git add/)
})
