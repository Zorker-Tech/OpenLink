import assert from "node:assert/strict"
import { describe, it } from "node:test"

import type { UserInfoRule } from "../../source/packages/agent/prompts/user-info-data-contracts.ts"
import { categorizePromptRules } from "../../source/packages/agent/prompts/rule-categorization.ts"
import { AgentType } from "../../source/packages/agent/utils/agent-config.ts"

function rule(overrides: Partial<UserInfoRule> = {}): UserInfoRule {
  return { fullPath: "/workspace/project/rules/default.md", ...overrides }
}

describe("user-info rule categorization", () => {
  it("applies skill and source precedence before type-based requestability", () => {
    const userSkill = rule({
      fullPath: "/workspace/project/.cursor/skills/review/SKILL.md",
      source: "user",
      type: { type: { case: "agentFetched" } },
    })
    const userRule = rule({ source: "user", type: { type: { case: "global" } } })
    const teamRule = rule({ source: "team", type: { type: { case: "fileGlobbed" } } })
    const attached = rule({ type: { type: { case: "manuallyAttached" } } })
    const requestable = rule({ type: { type: { case: "agentFetched" } } })

    const categorized = categorizePromptRules([userSkill, userRule, teamRule, attached, requestable])

    assert.deepEqual(categorized.skills, [userSkill])
    assert.deepEqual(categorized.userRules, [userRule])
    assert.deepEqual(categorized.globalRules, [teamRule])
    assert.deepEqual(categorized.agentRequestableRules, [requestable])
  })

  it("distinguishes nested global rules, root globals, and file-scoped rules", () => {
    const nestedGlobal = rule({
      fullPath: "/workspace/project/sub/.cursor/rules/global.md",
      type: { type: { case: "global" } },
    })
    const rootGlobal = rule({
      fullPath: "/workspace/project/.cursor/rules/global.md",
      type: { type: { case: "global" } },
    })
    const fileScopedElsewhere = rule({
      fullPath: "/elsewhere/rules/files.md",
      type: { type: { case: "fileGlobbed" } },
    })

    const categorized = categorizePromptRules([nestedGlobal, rootGlobal, fileScopedElsewhere], ["/workspace/project"])

    assert.deepEqual(categorized.agentRequestableRules, [nestedGlobal, fileScopedElsewhere])
    assert.deepEqual(categorized.globalRules, [rootGlobal])
  })

  it("filters local and cloud rules by run kind while bug-report runs stay unscoped", () => {
    const local = rule({ fullPath: "/workspace/local.md", environments: ["local"] })
    const cloud = rule({ fullPath: "/workspace/cloud.md", environments: ["cloud"] })
    const shared = rule({ fullPath: "/workspace/shared.md" })

    assert.deepEqual(categorizePromptRules([local, cloud, shared], [], AgentType.CLI).agentRequestableRules, [local, shared])
    assert.deepEqual(categorizePromptRules([local, cloud, shared], [], AgentType.BACKGROUND).agentRequestableRules, [cloud, shared])
    assert.deepEqual(categorizePromptRules([local, cloud, shared], [], AgentType.BUGBOT).agentRequestableRules, [local, cloud, shared])
  })

  it("keeps always-on skills as global and drops skills disabled for model invocation", () => {
    const alwaysOn = rule({
      fullPath: "/workspace/.cursor/skills/always/SKILL.md",
      type: { type: { case: "global" } },
    })
    const disabled = rule({
      fullPath: "/workspace/.cursor/skills/private/SKILL.md",
      content: "---\ndisable-model-invocation: true\n---\nbody",
    })
    const categorized = categorizePromptRules([alwaysOn, disabled])

    assert.deepEqual(categorized.globalRules, [alwaysOn])
    assert.deepEqual(categorized.skills, [])
  })
})
