import { test } from "node:test"
import assert from "node:assert/strict"

import { createContext, type Context } from "../../source/packages/context/context.ts"
import { agentEventTrackerKey, type AgentEventTracker } from "../../source/packages/agent/utils/event-tracking.ts"
import { CursorRule, CursorRuleSource } from "../../source/adapters/interop/proto/generated/agent/v1/rules_pb.ts"
import { emptySlateSelectedContextState } from "../../source/packages/agent/context/selected-context-state.ts"
import { renderManuallyAttachedSkillsSection } from "../../source/packages/agent/manually-attached-skills.ts"
import { resolveSkillAttachments } from "../../source/packages/agent/skill-attachment-policy.ts"
import { estimateStringTokenCount } from "../../source/packages/agent/utils/token-estimate.ts"
import {
  countConversationHistoryTokens,
  trackPromptTokenUsage,
} from "../../source/packages/agent/utils/prompt-token-tracking.ts"

type AnyRecord = Record<string, any>

const tracked: AnyRecord[] = []

function testContext(): Context {
  const tracker = {
    trackPromptTokens: (_ctx: Context, event: AnyRecord) => {
      tracked.push(event)
    },
  } as unknown as AgentEventTracker
  return createContext().with(agentEventTrackerKey, tracker)
}

function redactedString(value: string): { length: number; unwrap: () => string } {
  return { length: value.length, unwrap: () => value }
}

// ---------------------------------------------------------------------------------------------
// manually attached skills
// ---------------------------------------------------------------------------------------------

test("nothing is rendered when the user attached no skills", () => {
  assert.equal(renderManuallyAttachedSkillsSection([]), undefined)
})

test("an attached skill is inlined with its name, its path and its content", () => {
  const rendered = renderManuallyAttachedSkillsSection([
    { fullPath: "/p/.cursor/skills/release-notes/SKILL.md", content: "---\nname: x\n---\nWrite the notes" },
  ])
  assert.match(rendered!, /^<manually_attached_skills>/)
  assert.match(rendered!, /### release-notes/)
  assert.match(rendered!, /File: \/p\/\.cursor\/skills\/release-notes\/SKILL\.md/)
  assert.match(rendered!, /Write the notes/)
  // The frontmatter is metadata about the skill, not part of its instructions.
  assert.doesNotMatch(rendered!, /name: x/)
  assert.match(rendered!, /<\/manually_attached_skills>/)
})

test("a skill whose path is not a SKILL.md is still named, and several are separated", () => {
  const rendered = renderManuallyAttachedSkillsSection([
    { fullPath: "/p/other/thing.md", content: "one" },
    { fullPath: "/p/.cursor/skills/second/SKILL.md", content: "two" },
  ])
  assert.match(rendered!, /### Skill/)
  assert.equal(rendered!.includes("\n\n---\n\n"), true)
  assert.equal(rendered!.includes("two"), true)
})

test("a skill with no frontmatter keeps all of its content", () => {
  const rendered = renderManuallyAttachedSkillsSection([{ fullPath: "/p/a/SKILL.md", content: "  plain text  " }])
  assert.equal(rendered!.includes("File: /p/a/SKILL.md\n\nplain text\n</manually_attached_skills>"), true)
})

// ---------------------------------------------------------------------------------------------
// selected context: skills against ordinary rules
// ---------------------------------------------------------------------------------------------

test("skills named directly win over skills inferred from paths", () => {
  const resolved = resolveSkillAttachments({
    explicitSkills: [{ path: "/p/a/SKILL.md", text: "skill content" }],
    ruleCandidates: [{ path: "/p/b/SKILL.md", text: "inferred skill" }],
  })
  assert.equal(resolved.skills.length, 1)
  assert.equal(resolved.skills[0]?.text, "skill content")
  // With the field present, a rule that happens to be a skill file is an ordinary rule.
  assert.equal(resolved.rules.length, 1)
})

test("without the field, a skill file among the rules is taken as a skill", () => {
  const resolved = resolveSkillAttachments({
    ruleCandidates: [
      { path: "/p/.cursor/skills/a/SKILL.md", text: "skill content" },
      { path: "/p/.cursor/rules/b.mdc", text: "rule content" },
    ],
  })
  assert.equal(resolved.skills.length, 1)
  assert.equal(resolved.skills[0]?.path, "/p/.cursor/skills/a/SKILL.md")
  assert.equal(resolved.rules.length, 1)
  assert.equal(resolved.rules[0]?.path, "/p/.cursor/rules/b.mdc")
})

test("an empty or missing attachment is not an attachment", () => {
  const resolved = resolveSkillAttachments({
    ruleCandidates: [
      undefined,
      { path: "/p/a.mdc", text: "   " },
      { path: "/p/b.mdc", text: "kept" },
    ],
    explicitSkills: [{ path: "/p/c/SKILL.md", text: " " }, { path: "/p/d/SKILL.md", text: "kept skill" }],
  })
  assert.equal(resolved.rules.length, 1)
  assert.equal(resolved.skills.length, 1)
  assert.equal(resolved.skills[0]?.text, "kept skill")
})

test("a skill at the root, named SKILL.md alone, counts as a skill file", () => {
  const resolved = resolveSkillAttachments({
    ruleCandidates: [{ path: "SKILL.md", text: "content" }],
  })
  assert.equal(resolved.skills.length, 1)
})

test("what a skill carries along is preserved", () => {
  const resolved = resolveSkillAttachments({
    explicitSkills: [{ path: "/p/a/SKILL.md", text: "c", pluginName: "p", marketplaceName: "m", pluginId: "pi", marketplaceId: "mi" }],
  })
  assert.equal(resolved.skills[0]?.pluginName, "p")
  assert.equal(resolved.skills[0]?.marketplaceId, "mi")
})

// ---------------------------------------------------------------------------------------------
// counting the conversation
// ---------------------------------------------------------------------------------------------

test("the system prompt is not conversation history", () => {
  const counted = countConversationHistoryTokens([
    { role: "system", content: "a very long system prompt indeed" },
    { role: "user", content: "hello" },
  ])
  assert.equal(counted.conversationHistoryMessageCount, 1)
  assert.ok(counted.conversationHistoryTokens > 0)
})

test("every part of a message is counted: text, tool names, arguments and results", () => {
  const textOnly = countConversationHistoryTokens([{ role: "user", content: "hello" }])
  const withParts = countConversationHistoryTokens([{
    role: "assistant",
    content: [
      { type: "text", text: "hello" },
      { type: "tool-call", toolName: "shell", args: { command: "ls" } },
      { type: "tool-result", toolName: "shell", result: "a\nb" },
    ],
  }])
  assert.ok(withParts.conversationHistoryTokens > textOnly.conversationHistoryTokens)
})

test("a message with nothing countable contributes nothing", () => {
  assert.deepEqual(countConversationHistoryTokens([{ role: "user", content: undefined }]), {
    conversationHistoryTokens: 0,
    conversationHistoryMessageCount: 1,
  })
  assert.deepEqual(countConversationHistoryTokens([{ role: "assistant", content: [] }]), {
    conversationHistoryTokens: 0,
    conversationHistoryMessageCount: 1,
  })
})

// ---------------------------------------------------------------------------------------------
// the whole measurement
// ---------------------------------------------------------------------------------------------

function trackingParams(overrides: AnyRecord = {}): AnyRecord {
  return {
    ctx: testContext(),
    mcpTools: [{ name: "search", description: "finds things", inputSchema: { type: "object" } }],
    requestContext: {
      rules: [new CursorRule({ fullPath: "/p/.cursor/rules/a.mdc", content: "Rule body", source: CursorRuleSource.UNSPECIFIED })],
      env: { workspacePaths: ["/p"] },
    },
    messages: [{ role: "user", content: "hello" }],
    selectedContext: undefined,
    userInfoDisplayOptions: undefined,
    readToolName: "read_file",
    invocationId: "inv-1",
    agentTokenLimit: 200_000,
    modelInfo: {},
    featureFlags: undefined,
    stateHandler: {},
    ...overrides,
  }
}

test("one measurement is reported, with the invocation it belongs to", () => {
  tracked.length = 0
  trackPromptTokenUsage(trackingParams() as never)
  assert.equal(tracked.length, 1)
  const event = tracked[0] as AnyRecord
  assert.equal(event.invocationId, "inv-1")
  assert.equal(event.mcpToolCount, 1)
  assert.ok(event.mcpToolTokens > 0)
  assert.ok(event.conversationHistoryTokens > 0)
  assert.equal(event.conversationHistoryMessageCount, 1)
})

test("MCP is reported as disabled when neither route is enabled", () => {
  tracked.length = 0
  trackPromptTokenUsage(trackingParams() as never)
  const event = tracked[0] as AnyRecord
  assert.equal(event.mcpEnabled, false)
  assert.equal(event.mcpDiscoveryMode, "disabled")
  assert.equal(event.mcpServerCount, 0)
})

test("the meta tool route is reported with its server count", () => {
  tracked.length = 0
  trackPromptTokenUsage(trackingParams({
    requestContext: {
      rules: [],
      mcpMetaToolOptions: { enabled: true, mcpDescriptors: [{}, {}] },
    },
  }) as never)
  const event = tracked[0] as AnyRecord
  assert.equal(event.mcpDiscoveryMode, "meta")
  assert.equal(event.mcpServerCount, 2)
})

test("the file-system route is reported when the meta tool is not enabled", () => {
  tracked.length = 0
  trackPromptTokenUsage(trackingParams({
    requestContext: {
      rules: [],
      mcpFileSystemOptions: { enabled: true, mcpDescriptors: [{}] },
    },
  }) as never)
  const event = tracked[0] as AnyRecord
  assert.equal(event.mcpDiscoveryMode, "filesystem")
  assert.equal(event.mcpServerCount, 1)
})

test("what the user attached is counted, including a folder's tree", () => {
  tracked.length = 0
  const empty = emptySlateSelectedContextState()
  trackPromptTokenUsage(trackingParams({
    selectedContext: {
      ...empty,
      workspace: {
        ...empty.workspace,
        codeSelections: [{ path: redactedString("/p/a.ts"), content: redactedString("const a = 1") }],
        terminalOutputs: [{ content: redactedString("$ ls"), title: redactedString("shell") }],
        terminalRanges: [{ content: redactedString("selected output"), title: redactedString("terminal selection") }],
        files: [{ path: redactedString("/p/b.ts"), content: redactedString("const b = 2") }],
        folders: [{
        path: redactedString("/p/src"),
          tree: { path: "/p/src", processed: false, files: [], directories: [], fileCount: 3, extensionCounts: {} },
        }],
      },
    },
  }) as never)
  const event = tracked[0] as AnyRecord
  assert.equal(event.fileAttachmentCount, 5)
  const workspaceTree = {
    absPath: "/p/src",
    childrenWereProcessed: false,
    childrenFiles: [],
    childrenDirs: [],
    numFiles: 3,
    fullSubtreeExtensionCounts: {},
  }
  const expectedTexts = [
    "/p/a.ts", "const a = 1", "$ ls", "shell", "selected output", "terminal selection",
    "/p/b.ts", "const b = 2", "/p/src",
  ]
  const expectedTokens = expectedTexts.reduce((sum, value) => sum + estimateStringTokenCount(value), 0) +
    estimateStringTokenCount(JSON.stringify(workspaceTree))
  assert.equal(event.fileAttachmentTokens, expectedTokens)
})

test("an attached skill is counted through the block that inlines it", () => {
  tracked.length = 0
  const empty = emptySlateSelectedContextState()
  trackPromptTokenUsage(trackingParams({
    selectedContext: {
      ...empty,
      skills: [{
        path: "/p/.cursor/skills/a/SKILL.md",
        content: "do the thing",
        description: "",
        environments: [],
        disabledEnvironments: [],
        modelInvocationDisabled: false,
        filePatterns: [],
        scopedTo: [],
      }],
    },
  }) as never)
  const event = tracked[0] as AnyRecord
  assert.equal(event.manuallyAttachedSkillCount, 1)
  const renderedSkill = renderManuallyAttachedSkillsSection([{
    fullPath: "/p/.cursor/skills/a/SKILL.md",
    content: "do the thing",
  }])
  assert.equal(event.manuallyAttachedSkillTokens, estimateStringTokenCount(renderedSkill ?? ""))
})

test("no attachments at all is reported as none", () => {
  tracked.length = 0
  trackPromptTokenUsage(trackingParams() as never)
  const event = tracked[0] as AnyRecord
  assert.equal(event.fileAttachmentCount, 0)
  assert.equal(event.fileAttachmentTokens, 0)
  assert.equal(event.manuallyAttachedSkillCount, 0)
})

test("the skills are counted through the same builder the prompt uses, and the strategy is left behind", () => {
  tracked.length = 0
  const stateHandler: AnyRecord = {}
  trackPromptTokenUsage(trackingParams({
    stateHandler,
    requestContext: {
      rules: [],
      agentSkills: [{ fullPath: "/p/.cursor/skills/a/SKILL.md", description: "a skill" }],
      env: { workspacePaths: ["/p"] },
    },
    userInfoDisplayOptions: { displaySkills: true },
  }) as never)
  const event = tracked[0] as AnyRecord
  assert.equal(event.availableSkillCount, 1)
  assert.ok(event.availableSkillTokens > 0)
  assert.equal(stateHandler.lastSkillCatalogBudgetStrategy, "under_budget")
})

test("rules are counted by what the prompt shows, not by everything the workspace has", () => {
  tracked.length = 0
  trackPromptTokenUsage(trackingParams({
    requestContext: {
      rules: [
        new CursorRule({ fullPath: "/p/.cursor/rules/a.mdc", content: "kept", source: CursorRuleSource.TEAM }),
        new CursorRule({ fullPath: "/p/.cursor/rules/b.mdc", content: "attached by hand", type: { type: { case: "manuallyAttached", value: {} } } } as never),
      ],
      env: { workspacePaths: ["/p"] },
    },
  }) as never)
  const event = tracked[0] as AnyRecord
  assert.equal(event.ruleCount, 1)
  assert.ok(event.ruleTokens > 0)
})
