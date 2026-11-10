import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { renderSimulatedMessagePrompts } from "../../source/packages/agent/simulated-message-prompts.ts"
import type { GitActionPromptInput } from "../../source/packages/agent/git-action-prompt-contracts.ts"

const branchPrompt: GitActionPromptInput = {
  reason: "diff-tab-create-branch",
  action: { kind: "create-branch", branchContext: { currentBranch: "main", baseBranch: "main" } },
}

describe("simulated message prompt assembly", () => {
  it("returns no placeholder when neither owned prompt source yields content", () => {
    assert.deepEqual(renderSimulatedMessagePrompts({}), [])
    assert.deepEqual(renderSimulatedMessagePrompts({ gitAction: { reason: "diff-tab-create-branch" } }), [])
  })

  it("appends available git-action and multitask instructions in stable order as text parts", () => {
    const prompts = renderSimulatedMessagePrompts({
      gitAction: branchPrompt,
      multitaskAction: "start-self-fork",
      modelInfo: { promptVersion: "latest", isLegacyAgentModel1: true },
    })

    assert.equal(prompts.length, 2)
    assert.deepEqual(prompts.map(({ type }) => type), ["text", "text"])
    assert.match(prompts[0]!.text, /^Create and check out a new branch/)
    assert.match(prompts[1]!.text, /Launch one background child/)
    assert.match(prompts[1]!.text, /mcp_task/)
  })

  it("uses the session's default subagent wording when no model profile is supplied", () => {
    const [prompt] = renderSimulatedMessagePrompts({ multitaskAction: "start-self-fork" })
    assert.match(prompt!.text, /using your subagent tool/)
  })
})
