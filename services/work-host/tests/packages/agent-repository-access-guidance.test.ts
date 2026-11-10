import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { repositoryAccessGuidance } from "../../source/packages/agent/prompts/repository-access-bullets.ts"

describe("repository access guidance", () => {
  it("names the unavailable operations and gives the user a workable next step", () => {
    const guidance = repositoryAccessGuidance()

    assert.match(guidance.boundary, /no repository checkout or source-control credentials/)
    assert.match(guidance.boundary, /Do not try to clone, push, or open a pull request/)
    assert.match(guidance.boundary, /intentional session boundary, not a setup failure/)
    assert.match(guidance.nextStep, /resume in a workspace where that repository is checked out/)
  })
})
