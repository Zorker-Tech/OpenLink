import assert from "node:assert/strict"
import { test } from "node:test"

import type { PromptRuleDescriptor } from "../../source/packages/agent/prompts/rule-sections-contracts.ts"
import { getAgentRequestableRuleDescription, getRuleDir, RulesSection } from "../../source/packages/agent/prompts/rule-sections.ts"
import { renderContent } from "../../source/packages/prompt-jsx/index.ts"

function promptRule(overrides: Partial<PromptRuleDescriptor> = {}): PromptRuleDescriptor {
  return { fullPath: "/work/project/.cursor/rules/rule.mdc", content: "Rule body", ...overrides }
}

test("a rule inherits the project above its rule directory, and otherwise uses its own directory", () => {
  assert.equal(getRuleDir("/work/project/.cursor/rules/rule.mdc"), "/work/project")
  assert.equal(getRuleDir("/work/project/packages/api/.cursor/rules/rule.mdc"), "/work/project/packages/api")
  assert.equal(getRuleDir("/work/project/rules/rule.mdc"), "/work/project/rules")
  assert.equal(getRuleDir("C:\\work\\project\\.cursor\\rules\\rule.mdc"), "C:/work/project")
})

test("requestable rules describe their title, file scope or fetch guidance by rule kind", () => {
  const globbed = promptRule({
    content: "\n  Format source files\nMore details",
    type: { type: { case: "fileGlobbed", value: { globs: ["src/**/*.ts", "*.md"] } } },
  })
  assert.equal(
    getAgentRequestableRuleDescription(globbed, "/work/project"),
    "  Format source files, glob pattern(s) for applicable files: src/**/*.ts, *.md",
  )

  const fetched = promptRule({ type: { type: { case: "agentFetched", value: { description: "How to write release notes" } } } })
  assert.equal(getAgentRequestableRuleDescription(fetched, "/work/project"), "How to write release notes")

  const global = promptRule({ type: { type: { case: "global", value: {} } } })
  assert.equal(getAgentRequestableRuleDescription(global, "/work/project"), "Rule body, applicable for all files within /work/project")

  const unknown = promptRule({ type: { type: { case: "future-rule-kind", value: {} } } })
  assert.equal(getAgentRequestableRuleDescription(unknown, "/work/project"), undefined)
})

test("the rendered rules block keeps always-applied, requestable and user rules in separate sections", () => {
  const rendered = renderContent(RulesSection({
    globalRules: [promptRule({ type: { type: { case: "fileGlobbed", value: { globs: ["src/**"] } } } })],
    agentRequestableRules: [promptRule({
      fullPath: "/work/project/.cursor/rules/release.mdc",
      type: { type: { case: "agentFetched", value: { description: "Release process" } } },
    })],
    userRules: [promptRule({ content: "Prefer brief examples" })],
    additionalUserRules: ["Use the supplied project context"],
    readToolName: "read_file",
  }))

  assert.match(rendered, /<rules>/)
  assert.match(rendered, /always_applied_workspace_rules/)
  assert.match(rendered, /always_applied_workspace_rule/)
  assert.match(rendered, /glob pattern\(s\) for applicable files: src\/\*\*/)
  assert.match(rendered, /agent_requestable_workspace_rules/)
  assert.match(rendered, /use read_file to read its full text/)
  assert.match(rendered, /Release process/)
  assert.match(rendered, /user_rules/)
  assert.match(rendered, /Prefer brief examples/)
  assert.match(rendered, /Use the supplied project context/)
})

test("sections without corresponding rules are omitted, while the outer block remains stable", () => {
  const rendered = renderContent(RulesSection({ globalRules: [], agentRequestableRules: [], userRules: [] }))
  assert.match(rendered, /<rules>/)
  assert.doesNotMatch(rendered, /always_applied_workspace_rules/)
  assert.doesNotMatch(rendered, /agent_requestable_workspace_rules/)
  assert.doesNotMatch(rendered, /user_rules/)
})
