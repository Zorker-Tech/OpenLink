import { test } from "node:test"
import assert from "node:assert/strict"

import { AgentMode } from "../../source/adapters/interop/proto/generated/agent/v1/agent_pb.ts"
import { renderInteropUserInfo } from "../../source/adapters/interop/agent/user-info-input-adapter.ts"
import { UserInfo } from "../../source/packages/agent/prompts/user-info.ts"

const environment = {
  osVersion: "Slate OS",
  shell: "zsh",
  workspacePaths: ["/workspace/project"],
  timeZone: "UTC",
  mountedAgentStores: [],
}

const promptOptions = {
  cursorRules: [],
  env: environment,
  gitRepos: [],
  gitRepoInfoComplete: true,
  displayOptions: { displayGitStatus: false, displayTodaysDate: false },
  featureFlags: { enableAntiAskQuestionUserRule: true },
  toolInfo: { allTools: { ASK_QUESTION: { name: "AskQuestion" } } },
  userIntentSummary: "Keep summaries concise.",
  hooksAdditionalContext: "The repository uses strict typing.",
  automationInstructions: undefined,
  mcpMetaToolOptions: {
    enabled: true,
    mcpDescriptors: [{ serverIdentifier: "research", serverName: "Research", tools: [{ toolName: "lookup" }] }],
    snapshotToolNames: { discoveryToolName: "FindTools", invocationToolName: "CallTool" },
  },
}

test("the full context composition keeps its sections in the order the agent reads them", () => {
  const rendered = renderInteropUserInfo({ ...promptOptions, mode: AgentMode.AGENT } as never)
  const orderedTags = ["<user_info>", "<user_profile", "<rules>", "<mcp_server_catalog>", "<hooks_context"]
  const positions = orderedTags.map(tag => rendered.indexOf(tag))

  for (const [index, tag] of orderedTags.entries()) assert.notEqual(positions[index], -1, `missing ${tag}`)
  assert.deepEqual(positions, [...positions].sort((left, right) => left - right))
  assert.match(rendered, /Keep summaries concise\./)
  assert.match(rendered, /The repository uses strict typing\./)
  assert.match(rendered, /research/)
})

test("the compact context option retains machine facts and git state, and omits auxiliary context", () => {
  const rendered = renderInteropUserInfo({
    ...promptOptions,
    mode: AgentMode.AGENT,
    displayOptions: { ...promptOptions.displayOptions, includeOnlyUserInfoAndGitStatus: true },
  } as never)

  assert.match(rendered, /Slate OS/)
  assert.doesNotMatch(rendered, /Keep summaries concise\./)
  assert.doesNotMatch(rendered, /strict typing/)
  assert.doesNotMatch(rendered, /<rules>/)
  assert.doesNotMatch(rendered, /<mcp_server_catalog>/)
})

test("ask mode with edit filtering does not advertise the dynamic MCP catalogue", () => {
  const rendered = renderInteropUserInfo({
    ...promptOptions,
    mode: AgentMode.ASK,
    enableFilterEditToolsInAskMode: true,
  } as never)

  assert.doesNotMatch(rendered, /<mcp_server_catalog>/)
})

test("the Slate prompt contract accepts workspace rules without a provider-shaped field", () => {
  const rendered = UserInfo({
    workspaceRules: [{
      fullPath: "/workspace/.slate/rules/style.md",
      content: "Use the workspace formatter.",
      source: "user",
    }],
  })

  assert.match(rendered, /Use the workspace formatter\./)
})
