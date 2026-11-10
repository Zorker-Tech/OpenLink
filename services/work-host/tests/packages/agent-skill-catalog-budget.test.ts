import { test } from "node:test"
import assert from "node:assert/strict"

import { applySkillCatalogBudget } from "../../source/packages/agent/prompts/skill-catalog-budget.ts"
import { renderContent } from "../../source/packages/prompt-jsx/index.ts"

const LONG = "x".repeat(200) + " description"
const renderSection = ((skills: readonly { fullPath: string; description?: string }[], notice?: unknown): string =>
  skills.map((skill) => skill.fullPath + "|" + (skill.description ?? "")).join("|") + (notice === undefined ? "" : "|N:" + String(notice))) as never
const renderOmittedNotice = ((directories: readonly string[], count: number): string => "left out " + count + " in " + directories.join(",")) as never
const apply = (input: { skills: Array<{ fullPath: string; description?: string }>; agentTokenLimit?: number; protectLoopSkill?: boolean; withNotice?: boolean }) =>
  applySkillCatalogBudget({
    skills: input.skills,
    agentTokenLimit: input.agentTokenLimit,
    protectLoopSkill: input.protectLoopSkill,
    renderSection,
    renderOmittedNotice: input.withNotice === false ? undefined : renderOmittedNotice,
  })
const sectionText = (result: ReturnType<typeof apply>): string => renderContent(result.section as never)

const threeSkills = [
  { fullPath: "/w/.cursor/skills/a/SKILL.md", description: LONG },
  { fullPath: "/w/.cursor/skills/b/SKILL.md", description: LONG },
  { fullPath: "/w/.cursor/skills/c/SKILL.md", description: LONG },
]

test("a catalogue that fits is used as it is", () => {
  const result = apply({ skills: threeSkills, agentTokenLimit: 20_000 })
  assert.equal(result.strategy, "under_budget")
  assert.equal(result.retainedCount, 3)
  assert.equal(result.omittedCount, 0)
  assert.equal(result.renderedEstimatedTokens, result.uncappedEstimatedTokens)
  assert.deepEqual(result.skillItems.map((skill) => skill.description?.length), [212, 212, 212])
  assert.equal(apply({ skills: [], agentTokenLimit: 1_000 }).strategy, "under_budget")
})

test("when it does not fit, the descriptions are shortened before anything is dropped", () => {
  const result = apply({ skills: threeSkills, agentTokenLimit: 5_000 })
  assert.equal(result.strategy, "shortened_descriptions")
  assert.equal(result.retainedCount, 3)
  assert.equal(result.omittedCount, 0)
  for (const skill of result.skillItems) {
    assert.equal(skill.description?.endsWith("..."), true)
    assert.equal(skill.description!.length <= 104, true, "the longest truncation that fits is used")
  }
  assert.equal(result.renderedEstimatedTokens <= 100, true, "the shortened section fits the budget")
})

test("when even shortened descriptions do not fit, path-only skills come next", () => {
  const barely = apply({ skills: threeSkills, agentTokenLimit: 1_500 })
  assert.equal(barely.strategy, "dropped_descriptions")
  assert.equal(barely.skillItems.every((skill) => skill.description === undefined), true)
})

test("the skills are left out only after that, with the directories they were left in", () => {
  const result = apply({ skills: threeSkills, agentTokenLimit: 1_000 })
  assert.equal(result.strategy, "omitted_skills")
  assert.equal(result.retainedCount, 1)
  assert.equal(result.omittedCount, 2)
  assert.deepEqual(result.omittedDirectories, ["/w/.cursor/skills"])
  assert.match(sectionText(result), /left out 2 in \/w\/\.cursor\/skills/)
})

test("the skills the platform relies on are never left out, and the loop skill can be protected", () => {
  const protectedSkills = [
    { fullPath: "/w/.cursor/skills/canvas/SKILL.md", description: LONG },
    { fullPath: "/w/.agents/skills/env-setup/SKILL.md", description: LONG },
    { fullPath: "/w/.claude/skills/other/SKILL.md", description: LONG },
  ]
  const kept = apply({ skills: protectedSkills, agentTokenLimit: 300 })
  assert.equal(kept.strategy, "omitted_skills")
  assert.deepEqual(kept.skillItems.map((skill) => skill.fullPath), ["/w/.cursor/skills/canvas/SKILL.md", "/w/.agents/skills/env-setup/SKILL.md"])
  assert.deepEqual(kept.omittedDirectories, ["/w/.claude/skills"])

  const loopSkills = [
    { fullPath: "/w/.cursor/skills/loop/SKILL.md", description: LONG },
    { fullPath: "/w/.claude/skills/z/SKILL.md", description: LONG },
  ]
  assert.deepEqual(apply({ skills: loopSkills, agentTokenLimit: 200, protectLoopSkill: true }).skillItems.map((skill) => skill.fullPath), ["/w/.cursor/skills/loop/SKILL.md"])
  assert.equal(apply({ skills: loopSkills, agentTokenLimit: 200, protectLoopSkill: false }).retainedCount, 0)
})

test("the directories a skill can be found in are the known trees, the plugin cache, or its parent", () => {
  const result = apply({
    skills: [
      { fullPath: "/w/.cursor/plugins/cache/p/skills/loop/SKILL.md", description: LONG },
      { fullPath: "/tmp/random/SKILL.md", description: LONG },
      { fullPath: "/tmp/file.md", description: "d" },
    ],
    agentTokenLimit: 100,
  })
  assert.deepEqual(result.omittedDirectories, ["/w/.cursor/plugins/cache/p/skills", "/tmp/random", "/tmp"])
})

test("a description that is only just over the shortening threshold is shortened rather than dropped", () => {
  const shortish = apply({ skills: [{ fullPath: "/w/.cursor/skills/x/SKILL.md", description: "y".repeat(81) }], agentTokenLimit: 1_000 })
  assert.equal(shortish.strategy, "shortened_descriptions")
  const description = shortish.skillItems[0]?.description ?? ""
  assert.equal(description.length < 81, true, "the description was cut rather than left as it was")
  assert.equal(description.endsWith("..."), true)
})

test("a limit that is absent or not positive is the fallback limit, and the notice can be left out", () => {
  const many = Array.from({ length: 40 }, (_, index) => ({ fullPath: "/w/.cursor/skills/s" + index + "/SKILL.md", description: LONG }))
  assert.equal(apply({ skills: many }).strategy, "under_budget", "the fallback limit is the catalogue's share of two hundred thousand tokens")
  assert.equal(apply({ skills: many, agentTokenLimit: 0 }).strategy, "under_budget")
  assert.equal(apply({ skills: many, agentTokenLimit: -5 }).strategy, "under_budget")
  const withoutNotice = apply({ skills: many, agentTokenLimit: 3_000, withNotice: false })
  assert.equal(withoutNotice.strategy, "omitted_skills")
  assert.doesNotMatch(sectionText(withoutNotice), /left out/)
})

test("the omitted directories are capped, and a single protected skill is still offered", () => {
  const spread = Array.from({ length: 8 }, (_, index) => ({ fullPath: "/w" + index + "/.cursor/skills/x/SKILL.md", description: LONG }))
  const capped = apply({ skills: spread, agentTokenLimit: 100 })
  assert.equal(capped.strategy, "omitted_skills")
  assert.equal(capped.omittedDirectories.length, 5)
  const canvasOnly = apply({ skills: [{ fullPath: "/w/.cursor/skills/canvas/SKILL.md", description: LONG }], agentTokenLimit: 50 })
  assert.equal(canvasOnly.strategy, "omitted_skills")
  assert.equal(canvasOnly.retainedCount, 1)
  assert.equal(canvasOnly.omittedCount, 0)
  assert.equal(canvasOnly.skillItems[0]?.description, LONG, "a protected skill keeps its description even when nothing fits")
})
