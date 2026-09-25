import { test } from "node:test"
import assert from "node:assert/strict"

import { renderContent } from "../../source/packages/prompt-jsx/index.ts"
import { CursorRule, CursorRuleSource, CursorRuleType } from "../../source/packages/proto/generated/agent/v1/rules_pb.ts"
import { AgentType } from "../../source/packages/agent/utils/agent-config.ts"
import {
  buildAntiAskQuestionSystemReminder,
  buildAntiAskQuestionUserRule,
} from "../../source/packages/agent/prompts/ask-question-guidance.ts"
import {
  buildRulesSection,
  getGeneratedUserRulesForModel,
} from "../../source/packages/agent/prompts/custom-user-rules.ts"
import { categorizeCursorRules } from "../../source/packages/agent/prompts/rule-categorization.ts"
import { hasDisableModelInvocation, isSkillPath } from "../../source/packages/agent/prompts/rule-predicates.ts"
import { applySkillCatalogBudget } from "../../source/packages/agent/prompts/skill-catalog-budget.ts"
import { buildAvailableSkillsPromptSection } from "../../source/packages/agent/prompts/available-skills-section.ts"
import { getSkillNameForTest } from "./helpers/prompt-test-helpers.ts"
import { PROMPT_SUGGESTION_MAX_WORDS, promptSuggestionUserMessage } from "../../source/packages/agent/prompts/prompt-suggestion.ts"
import { shouldInjectComposerGitUserRules } from "../../source/packages/agent/prompts/composer-git-rule-gate.ts"
import { getComposerGitUserRules } from "../../source/packages/agent/prompts/git-workflow-rules.ts"
import {
  getMcpFileSystemInstructions,
  getMcpFileSystemToolNames,
} from "../../source/packages/agent/utils/mcp-file-system.ts"
import { getTmuxBootstrapCommand, TmuxBackedShellInstructions } from "../../source/packages/agent/prompts/shell-session-instructions.ts"
import { extractToolInfo } from "../../source/packages/agent/prompts/tool-info.ts"
import { isThreadBoundSession } from "../../source/packages/agent/prompts/thread-bound-session.ts"
import { usesPersistenceInstructions } from "../../source/packages/agent/prompts/persistence-instructions.ts"

function rule(overrides: Record<string, unknown> = {}): CursorRule {
  return new CursorRule({
    fullPath: "/project/.cursor/rules/rule.mdc",
    content: "Rule body",
    source: CursorRuleSource.UNSPECIFIED,
    ...overrides,
  } as never)
}

function globalRule(fullPath = "/project/.cursor/rules/rule.mdc"): CursorRule {
  return rule({ fullPath, type: { type: { case: "global", value: {} } } } as never)
}

// ---------------------------------------------------------------------------------------------
// rule predicates
// ---------------------------------------------------------------------------------------------

test("a rule at a skill path is recognized wherever skills are written", () => {
  for (const path of [
    "/project/.cursor/skills/thing/SKILL.md",
    "/project/.cursor/skills-cursor/thing/SKILL.md",
    "/project/.claude/skills/thing/SKILL.md",
    "/project/.codex/skills/thing/SKILL.md",
    "/project/.agents/skills/thing/SKILL.md",
    "/project/.claude/plugins/cache/plugin/skills/thing/SKILL.md",
    "/project/SKILL.md",
  ]) {
    assert.equal(isSkillPath(path), true, path)
  }
  assert.equal(isSkillPath("/project/.cursor/rules/rule.mdc"), false)
  assert.equal(isSkillPath("/project/src/index.ts"), false)
})

test("a skill path is recognized with windows separators too", () => {
  assert.equal(isSkillPath("C:\\project\\.cursor\\skills\\thing\\SKILL.md"), true)
})

test("a rule that refuses model invocation says so in its frontmatter", () => {
  assert.equal(hasDisableModelInvocation({ content: "---\ndisable-model-invocation: true\n---\nbody" }), true)
  assert.equal(hasDisableModelInvocation({ content: "---\ndisable-model-invocation: false\n---\nbody" }), false)
  assert.equal(hasDisableModelInvocation({ content: "no frontmatter" }), false)
  assert.equal(hasDisableModelInvocation({ content: "---\nbroken: [\n---" }), false)
  assert.equal(hasDisableModelInvocation({}), false)
})

// ---------------------------------------------------------------------------------------------
// rule categorization
// ---------------------------------------------------------------------------------------------

test("a rule's origin decides which group it lands in", () => {
  const categorized = categorizeCursorRules([
    rule({ source: CursorRuleSource.USER }),
    rule({ source: CursorRuleSource.TEAM, fullPath: "/project/.cursor/rules/team.mdc" }),
    globalRule(),
  ])
  assert.equal(categorized.userRules.length, 1)
  assert.equal(categorized.globalRules.length, 2)
  assert.equal(categorized.agentRequestableRules.length, 0)
})

test("a skill is grouped as a skill unless it is always in force or refuses invocation", () => {
  const categorized = categorizeCursorRules([
    rule({ fullPath: "/project/.cursor/skills/a/SKILL.md", type: { type: { case: "agentFetched", value: {} } } } as never),
    rule({ fullPath: "/project/.cursor/skills/b/SKILL.md", type: { type: { case: "global", value: {} } } } as never),
    rule({ fullPath: "/project/.cursor/skills/c/SKILL.md", content: "---\ndisable-model-invocation: true\n---\nbody" }),
  ])
  assert.equal(categorized.skills.length, 1)
  assert.equal(categorized.skills[0]?.fullPath, "/project/.cursor/skills/a/SKILL.md")
  assert.equal(categorized.globalRules.length, 1)
})

test("a rule attached by hand is not offered for the model to request", () => {
  const categorized = categorizeCursorRules([
    rule({ type: { type: { case: "manuallyAttached", value: {} } } } as never),
  ])
  assert.equal(categorized.agentRequestableRules.length, 0)
  assert.equal(categorized.globalRules.length, 0)
})

test("a rule scoped to files the workspace has is requestable; one scoped elsewhere is global", () => {
  const fileScoped = rule({
    fullPath: "/project/.cursor/rules/scoped.mdc",
    type: { type: { case: "fileGlobbed", value: { globs: ["src/**"] } } } as never,
  })
  const categorized = categorizeCursorRules([fileScoped], ["/project"])
  assert.equal(categorized.agentRequestableRules.length, 1)

  // A globbed rule is requestable wherever it lives; only a plain global rule can be nested.
  const otherProject = rule({
    fullPath: "/elsewhere/.cursor/rules/scoped.mdc",
    type: { type: { case: "fileGlobbed", value: { globs: ["src/**"] } } } as never,
  })
  const categorizedElsewhere = categorizeCursorRules([otherProject], ["/project"])
  assert.equal(categorizedElsewhere.agentRequestableRules.length, 1)

  // A global rule inside a project directory below the workspace root is requestable rather than global.
  const nestedGlobal = rule({
    fullPath: "/project/sub/.cursor/rules/nested.mdc",
    type: { type: { case: "global", value: {} } } as never,
  })
  assert.equal(categorizeCursorRules([nestedGlobal], ["/project"]).agentRequestableRules.length, 1)
  // A rule directly under the workspace root is not nested, so it stays global.
  const rootGlobal = rule({
    fullPath: "/project/.cursor/rules/root.mdc",
    type: { type: { case: "global", value: {} } } as never,
  })
  assert.equal(categorizeCursorRules([rootGlobal], ["/project"]).globalRules.length, 1)
})

test("a rule scoped to another environment is dropped before anything else", () => {
  const categorized = categorizeCursorRules(
    [rule({ disabledEnvironments: ["cloud"] }), globalRule("/project/.cursor/rules/two.mdc")],
    [],
    AgentType.BACKGROUND,
  )
  assert.equal(categorized.globalRules.length, 1)
})

// ---------------------------------------------------------------------------------------------
// the generated rules
// ---------------------------------------------------------------------------------------------

test("a model trained on the raw slug is given none of the generated rules", () => {
  assert.deepEqual(getGeneratedUserRulesForModel({ isComposerMatterhorn: true, isRawTrainingSlug: true }, {
    enableComposer2CustomUserRules: true,
  }), [])
})

test("the general rule set is returned for other models when the flag asks for it", () => {
  const rules = getGeneratedUserRulesForModel({}, { enableComposer2CustomUserRules: true })
  assert.equal(rules.length, 5)
  assert.match(rules[0] as string, /^Follow ALL user, tool, system, and skill instructions/)
  assert.equal(getGeneratedUserRulesForModel({}, {}).length, 0)
})

test("the optional rules are added when their flags are set", () => {
  const rules = getGeneratedUserRulesForModel({}, {
    enableTahomaUserRuleIntervention: true,
    enableVegaFrontendUserRuleIntervention: true,
  })
  assert.equal(rules.length, 2)
  assert.match(rules[0] as string, /frontend design tasks/)
  assert.match(rules[1] as string, /final response for the user/)
})

test("a training-aligned model gets the worded rules and the tool-specific ones", () => {
  const rules = getGeneratedUserRulesForModel(
    { isComposerMatterhorn: true },
    { enableComposer2CustomUserRules: true, enableMatterhornPromptTweaks: true, enableGrepBroadGlobGuard: true },
    { awaitToolName: "Await", shellToolName: "Shell", grepToolName: "Grep" },
  )
  assert.equal(rules.some(text => text.includes("Remember to use skills and MCP tools")), true)
  assert.equal(rules.some(text => text.startsWith("When using Shell:")), true)
  assert.equal(rules.some(text => text.startsWith("When using Grep:")), true)
  assert.equal(rules.some(text => text.startsWith("When using Await on a background shell:")), true)
  // The general communication rule is replaced by the training-aligned wording.
  assert.equal(rules.some(text => text.includes("Use high quality prose with complete sentences")), true)
})

test("a training-aligned model without the tweak flag gets the general wording instead", () => {
  const rules = getGeneratedUserRulesForModel(
    { isComposerMatterhorn: true },
    { enableComposer2CustomUserRules: true },
    { shellToolName: "Shell" },
  )
  assert.equal(rules.some(text => text.startsWith("When using Shell:")), false)
  assert.equal(rules.some(text => text.includes("Use code citation blocks")), true)
})

test("the git rules are given only to the models that lack the tool, and never to a background run", () => {
  assert.equal(shouldInjectComposerGitUserRules({ promptVersion: "cursor-0226" }), true)
  assert.equal(shouldInjectComposerGitUserRules({ isComposer2: true }), true)
  assert.equal(shouldInjectComposerGitUserRules({ isComposer15: true }), true)
  assert.equal(shouldInjectComposerGitUserRules({ isComposerMatterhorn: true }), true)
  assert.equal(shouldInjectComposerGitUserRules({}), false)
  assert.equal(shouldInjectComposerGitUserRules(undefined), false)
  assert.equal(shouldInjectComposerGitUserRules({ isComposerMatterhorn: true, isRawTrainingSlug: true }), false)
  assert.equal(shouldInjectComposerGitUserRules({ isComposer2: true }, AgentType.BACKGROUND), false)
})

test("the git rules name the shell tool the session actually has", () => {
  const rules = getComposerGitUserRules({ allTools: { SHELL: { name: "RunCommand" } } })
  assert.equal(rules.length, 2)
  assert.match(rules[0] as string, /RunCommand/)
  assert.match(rules[0] as string, /NEVER update the git config/)
  assert.equal(getComposerGitUserRules({})[0]?.includes("Shell"), true)
})

test("the ask-question rule names the tool and comes in both lengths", () => {
  const ruleText = buildAntiAskQuestionUserRule("AskQuestion")
  assert.match(ruleText, /^AskQuestion tool guidance/)
  assert.match(ruleText, /Do NOT use the AskQuestion tool to ask for help/)
  assert.equal(
    buildAntiAskQuestionSystemReminder("AskQuestion"),
    "<system_reminder>Remember the user rule about AskQuestion tool guidance.</system_reminder>",
  )
})

// ---------------------------------------------------------------------------------------------
// the rules section
// ---------------------------------------------------------------------------------------------

test("nothing is rendered when the session displays no rules", () => {
  const result = buildRulesSection({ cursorRules: [globalRule()], displayOptions: { displayCursorRules: false } })
  assert.equal(result.ruleCount, 0)
  assert.equal(result.section, undefined)
})

test("nothing is rendered when there is nothing to render", () => {
  assert.equal(buildRulesSection({ cursorRules: [] }).ruleCount, 0)
})

test("a workspace rule becomes a section with the rule count reported", () => {
  const result = buildRulesSection({ cursorRules: [globalRule()], toolInfo: { allTools: { READ: { name: "read_file" } } } })
  assert.equal(result.ruleCount, 1)
  const rendered = renderContent(result.section!)
  assert.match(rendered, /<rules>/)
  assert.match(rendered, /always_applied_workspace_rule/)
  assert.match(rendered, /Rule body/)
})

test("a cloud run is given no git rules, and a local one is", () => {
  const props = {
    cursorRules: [] as CursorRule[],
    modelInfo: { isComposer2: true },
    toolInfo: { allTools: { SHELL: { name: "Shell" }, ASK_QUESTION: { name: "AskQuestion" } } },
  }
  const local = buildRulesSection({ ...props, featureFlags: { enableComposer2CustomUserRules: true } })
  const cloud = buildRulesSection({ ...props, backgroundAgentSource: 1 as never, featureFlags: { enableComposer2CustomUserRules: true } })
  assert.equal(cloud.ruleCount < local.ruleCount, true)
  assert.match(renderContent(cloud.section!), /rules/)
  assert.doesNotMatch(renderContent(cloud.section!), /Committing changes with git/)
})

test("the ask-question rule is added to the user rules when the flag is set", () => {
  const result = buildRulesSection({
    cursorRules: [],
    toolInfo: { allTools: { ASK_QUESTION: { name: "AskQuestion" } } },
    featureFlags: { enableAntiAskQuestionUserRule: true },
  })
  assert.equal(result.ruleCount, 1)
  assert.match(renderContent(result.section!), /AskQuestion tool guidance/)
})

test("a requestable rule is described with where to read it, and the tool to read it with", () => {
  const fetched = rule({
    fullPath: "/project/.cursor/rules/notes.mdc",
    content: "A note about the project\nmore text",
    type: { type: { case: "agentFetched", value: { description: "How to write release notes" } } } as never,
  })
  const result = buildRulesSection(
    { cursorRules: [fetched], toolInfo: { allTools: { READ: { name: "read_file" } } } },
    { categorizedRules: { globalRules: [], agentRequestableRules: [fetched], userRules: [] }, readToolName: "read_file" },
  )
  const rendered = renderContent(result.section!)
  assert.match(rendered, /agent_requestable_workspace_rule/)
  assert.match(rendered, /How to write release notes/)
  assert.match(rendered, /Use the read_file tool/)
  // A globbed rule is in force by itself, so it is not offered for the model to request.
  const globbed = rule({
    fullPath: "/project/.cursor/rules/scoped.mdc",
    type: { type: { case: "fileGlobbed", value: { globs: ["src/**"] } } } as never,
  })
  const filtered = buildRulesSection({ cursorRules: [globbed] }, {
    categorizedRules: { globalRules: [], agentRequestableRules: [globbed], userRules: [] },
  })
  assert.equal(filtered.ruleCount, 0)
})

// ---------------------------------------------------------------------------------------------
// the skill catalogue budget
// ---------------------------------------------------------------------------------------------

function skill(fullPath: string, description?: string) {
  return { fullPath, description }
}

const renderItems = (skills: readonly { fullPath: string; description?: string | undefined }[]) =>
  renderContent(skills.map(s => `<agent_skill fullPath="${s.fullPath}">${s.description ?? ""}</agent_skill>`).join("\n"))

test("a catalogue inside its budget is rendered as it is", () => {
  const result = applySkillCatalogBudget({
    skills: [skill("/p/.cursor/skills/a/SKILL.md", "short")],
    renderSection: renderItems,
    agentTokenLimit: 200_000,
  })
  assert.equal(result.strategy, "under_budget")
  assert.equal(result.retainedCount, 1)
  assert.equal(result.omittedCount, 0)
})

test("a catalogue over budget first has its descriptions shortened", () => {
  const long = "x".repeat(2_000)
  const result = applySkillCatalogBudget({
    skills: [skill("/p/.cursor/skills/a/SKILL.md", long), skill("/p/.cursor/skills/b/SKILL.md", long)],
    renderSection: renderItems,
    agentTokenLimit: 6_000,
  })
  assert.equal(result.strategy, "shortened_descriptions")
  assert.equal(result.retainedCount, 2)
  const rendered = renderContent(result.section)
  assert.match(rendered, /\.\.\./)
  assert.equal(rendered.includes(long), false)
})

test("short descriptions are dropped rather than shortened", () => {
  // Too short to be worth truncating, so the budget goes straight to dropping them.
  const description = "a short description that is not worth shortening at all"
  const result = applySkillCatalogBudget({
    skills: [skill("/p/.cursor/skills/a/SKILL.md", description)],
    renderSection: renderItems,
    agentTokenLimit: 1_000,
  })
  assert.equal(result.strategy, "dropped_descriptions")
  assert.equal(result.retainedCount, 1)
  assert.equal(renderContent(result.section).includes(description), false)
  assert.match(renderContent(result.section), /\/p\/\.cursor\/skills\/a\/SKILL\.md/)
})

test("skills are left out only after that, and the notice names their directories", () => {
  const many = Array.from({ length: 60 }, (_, index) => skill(`/p/.cursor/skills/skill-${index}/SKILL.md`, "d".repeat(200)))
  const result = applySkillCatalogBudget({
    skills: many,
    renderSection: (skills, notice) => `${renderItems(skills)}${notice ? renderContent(notice) : ""}`,
    renderOmittedNotice: (directories, count) => `${count} omitted in ${directories.join(", ")}`,
    agentTokenLimit: 6_000,
  })
  assert.equal(result.strategy, "omitted_skills")
  assert.ok(result.omittedCount > 0)
  assert.ok(result.retainedCount < many.length)
  assert.match(renderContent(result.section), /omitted in \/p\/\.cursor\/skills/)
})

test("the protected skills survive even when nothing else does", () => {
  const skills = [
    skill("/p/.cursor/skills/canvas/SKILL.md", "c".repeat(4_000)),
    skill("/p/.cursor/skills/env-setup/SKILL.md", "e".repeat(4_000)),
    skill("/p/.cursor/skills/other/SKILL.md", "o".repeat(4_000)),
  ]
  const result = applySkillCatalogBudget({
    skills,
    renderSection: renderItems,
    renderOmittedNotice: (_directories, count) => `${count} omitted`,
    agentTokenLimit: 1,
  })
  assert.equal(result.strategy, "omitted_skills")
  assert.deepEqual(result.skillItems.map(item => getSkillNameForTest(item.fullPath)), ["canvas", "env-setup"])
})

test("a session can protect one more skill", () => {
  const skills = [
    skill("/p/.cursor/skills/loop/SKILL.md", "l".repeat(4_000)),
    skill("/p/.cursor/skills/other/SKILL.md", "o".repeat(4_000)),
  ]
  const unprotected = applySkillCatalogBudget({
    skills,
    renderSection: renderItems,
    renderOmittedNotice: (_directories, count) => `${count} omitted`,
    agentTokenLimit: 1,
  })
  assert.deepEqual(unprotected.skillItems.map(item => getSkillNameForTest(item.fullPath)), [])

  const protectedResult = applySkillCatalogBudget({
    skills,
    renderSection: renderItems,
    renderOmittedNotice: (_directories, count) => `${count} omitted`,
    agentTokenLimit: 1,
    protectLoopSkill: true,
  })
  assert.deepEqual(protectedResult.skillItems.map(item => getSkillNameForTest(item.fullPath)), ["loop"])
})

// ---------------------------------------------------------------------------------------------
// which skills a session is shown
// ---------------------------------------------------------------------------------------------

test("a skill that refuses invocation is not offered, and a file-scoped one is not either", () => {
  const section = buildAvailableSkillsPromptSection({
    cursorRules: [],
    displayOptions: { displaySkills: true },
    agentSkills: [
      { fullPath: "/p/.cursor/skills/a/SKILL.md", description: "a" },
      { fullPath: "/p/.cursor/skills/b/SKILL.md", description: "b", disableModelInvocation: true },
      { fullPath: "/p/.cursor/skills/c/SKILL.md", description: "c", globs: ["src/**"] },
    ] as never,
    env: { workspacePaths: ["/p"] } as never,
    modelInfo: {},
  })
  assert.equal(section.skillCount, 1)
  assert.match(renderContent(section.section!), /\/p\/\.cursor\/skills\/a\/SKILL\.md/)
})

test("nothing is shown unless the session displays skills, except for a desktop subagent", () => {
  const props = {
    cursorRules: [],
    agentSkills: [{ fullPath: "/p/.cursor/skills/a/SKILL.md", description: "a" }] as never,
    env: { workspacePaths: ["/p"] } as never,
    modelInfo: {},
  }
  assert.equal(buildAvailableSkillsPromptSection({ ...props, displayOptions: {} }).skillCount, 0)
  const desktop = buildAvailableSkillsPromptSection({
    ...props,
    displayOptions: { computerUseSubagentSurface: true },
    agentSkills: [
      { fullPath: "/p/.cursor/skills/a/SKILL.md", description: "a" },
      { fullPath: "/p/.cursor/skills/computer-use/SKILL.md", description: "drive the desktop" },
    ] as never,
  })
  assert.equal(desktop.skillCount, 1)
  assert.match(renderContent(desktop.section!), /computer-use/)
})

test("a rule that is really a skill is offered through the legacy route too", () => {
  const section = buildAvailableSkillsPromptSection({
    cursorRules: [rule({ fullPath: "/p/.cursor/skills/a/SKILL.md", type: { type: { case: "agentFetched", value: { description: "a skill" } } } } as never)],
    displayOptions: { displaySkills: true },
    env: { workspacePaths: ["/p"] } as never,
    modelInfo: {},
  })
  assert.equal(section.skillCount, 1)
  assert.match(renderContent(section.section!), /a skill/)
})

// ---------------------------------------------------------------------------------------------
// smaller pieces
// ---------------------------------------------------------------------------------------------

test("the MCP file-system instructions are only written when that route is open", () => {
  const base = {
    mcpFileSystemOptions: { enabled: true, workspaceProjectDir: "/p", mcpDescriptors: [{ serverIdentifier: "s", folderPath: "/p/mcps/s" }] } as never,
    featureFlags: { enableMCPFileSystem: true },
  }
  assert.match(getMcpFileSystemInstructions(base), /mcp_file_system/)
  assert.equal(getMcpFileSystemInstructions({
    ...base,
    mcpFileSystemOptions: { enabled: false, workspaceProjectDir: "/p", mcpDescriptors: [] } as never,
  }), "")
  assert.equal(getMcpFileSystemInstructions({ ...base, featureFlags: {} }), "")
  assert.equal(getMcpFileSystemInstructions({ ...base, mcpMetaToolOptions: { enabled: true, mcpDescriptors: [] } as never }), "")
  assert.equal(getMcpFileSystemInstructions({ ...base, mode: 2 as never, enableFilterEditToolsInAskMode: true }), "")
})

test("the MCP tool names follow the model's training, not the platform's preference", () => {
  assert.deepEqual(getMcpFileSystemToolNames(undefined), {
    callMcpTool: "call_mcp_tool",
    listMcpResources: "list_mcp_resources",
    fetchMcpResource: "fetch_mcp_resource",
  })
  assert.deepEqual(getMcpFileSystemToolNames({ isComposerMatterhorn: true }), {
    callMcpTool: "CallMcpTool",
    listMcpResources: "ListMcpResources",
    fetchMcpResource: "FetchMcpResource",
  })
  assert.equal(getMcpFileSystemToolNames({ isComposerMatterhorn: true, isRawTrainingSlug: true }).callMcpTool, "call_mcp_tool")
})

test("the tmux bootstrap command is safe to run repeatedly", () => {
  const command = getTmuxBootstrapCommand({ sharedSessionName: "dev" })
  assert.match(command, /has-session/)
  assert.match(command, /\|\|/)
  assert.match(command, /SESSION_NAME="dev"/)
  assert.match(getTmuxBootstrapCommand(), /descriptive-task-name/)
})

test("the tmux section names the shared session when there is one", () => {
  assert.match(renderContent(TmuxBackedShellInstructions({ sharedSessionName: "dev" })), /route it through `dev`/)
  assert.match(renderContent(TmuxBackedShellInstructions({})), /descriptive tmux session name/)
})

test("the prompt knows what the tool set offers, including the subagent descriptions", () => {
  const info = extractToolInfo({
    getAllTools: () => [
      { toolIdentifier: "WRITE", name: "Write" },
      { toolIdentifier: "PLATFORM_ACTION", name: "SendSlackMessage" },
      { toolIdentifier: "TASK", name: "Task", descriptionTokenPartsGenerator: () => ({ availableSubagentTypesDescriptionText: "types" }) },
    ],
    getStaticTools: () => [{ toolIdentifier: "TASK", name: "Task" }],
    getDescriptionProps: () => ({ allTools: { Task: { name: "Task" } } }),
    hasTool: identifier => identifier === "WRITE",
  })
  assert.equal(info.hasAnyEditTools, true)
  assert.deepEqual(info.automationsCommunicationToolNames, ["SendSlackMessage"])
  assert.equal(info.availableSubagentTypesDescription, "types")
})

test("a session is thread-bound only when it came from a thread surface", () => {
  assert.equal(isThreadBoundSession({ isThreadSurface: true }), true)
  assert.equal(isThreadBoundSession({ isThreadSurface: true, namedAgentSessionKind: "slack_thread" }), true)
  assert.equal(isThreadBoundSession({ isThreadSurface: true, namedAgentSessionKind: "other" }), false)
  assert.equal(isThreadBoundSession({}), false)
})

test("the persistence instructions go to the family that reads them", () => {
  assert.equal(usesPersistenceInstructions({ isGpt5: true }), true)
  assert.equal(usesPersistenceInstructions({ isGpt5Family: true }), true)
  assert.equal(usesPersistenceInstructions({ isGpt56: true }), true)
  assert.equal(usesPersistenceInstructions({}), false)
  assert.equal(usesPersistenceInstructions(null), false)
})

test("the suggestion message asks for what the user would type, not what would be useful", () => {
  const message = promptSuggestionUserMessage()
  assert.match(message, /SUGGESTION MODE/)
  assert.match(message, new RegExp(`Format: 2-${PROMPT_SUGGESTION_MAX_WORDS} words`))
  assert.match(message, /predict what THEY would type/)
  assert.doesNotMatch(message, /thinking tokens/)
  assert.match(promptSuggestionUserMessage(true), /no more than 20 words of thinking tokens/)
})
