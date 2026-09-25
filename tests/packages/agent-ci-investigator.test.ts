import { test } from "node:test"
import assert from "node:assert/strict"

import { createCiInvestigatorSubagentConfig } from "../../source/packages/agent/tools/core/subagent/ci-investigator.ts"
import { CustomSubagentPermissionMode } from "../../source/packages/proto/generated/agent/v1/subagents_pb.ts"
import { renderContent } from "../../source/packages/prompt-jsx/index.ts"
import { getShellToolDescription } from "../../source/packages/agent/tools/core/shell/shell-tool-description.ts"
import { getToolFamily } from "../../source/packages/agent/tools/tool-families.ts"

/** A tool set with the tools the subagent's reminder names, so its wording can be checked. */
function toolSet(names: Record<string, string> = {}) {
  const tools = Object.entries(names).map(([toolIdentifier, name]) => ({
    toolIdentifier,
    name,
    parameters: {},
  }))
  return {
    getAllTools: () => tools,
    getStaticTools: () => tools,
    getDescriptionProps: () => ({ allTools: Object.fromEntries(tools.map(tool => [tool.toolIdentifier, tool])) }),
    hasTool: (identifier: string) => tools.some(tool => tool.toolIdentifier === identifier),
  } as never
}

// ---------------------------------------------------------------------------------------------
// the CI investigator's configuration
// ---------------------------------------------------------------------------------------------

test("the subagent is a built-in custom type that keeps the task tool and runs on its own", () => {
  const config = createCiInvestigatorSubagentConfig()
  assert.equal(config.subagent_type.type.case, "custom")
  assert.equal((config.subagent_type.type.value as { name: string }).name, "ci-investigator")
  assert.equal(config.preserveTaskTool, true)
  assert.equal(config.subagentSource, "builtin")
  assert.equal(config.permissionMode, CustomSubagentPermissionMode.AGENT_ONLY)
  assert.match(config.description, /^Investigate a single failing PR CI check/)
})

test("the reminder says what the subagent is for and what it must not do", () => {
  const reminder = createCiInvestigatorSubagentConfig().systemReminder(toolSet())
  assert.match(reminder, /^You are a CI failure investigator\./)
  assert.match(reminder, /Do NOT modify, create, move, or delete any files\./)
  assert.match(reminder, /Do NOT run compilation, typechecking, linting, builds, tests/)
  assert.match(reminder, /this is triage-only diagnosis from existing evidence/)
  assert.match(reminder, /Avoid emojis\./)
})

test("the report format is fixed, and the classification is the structured part of it", () => {
  const reminder = createCiInvestigatorSubagentConfig().systemReminder(toolSet())
  assert.match(reminder, /\*\*Root cause:\*\*/)
  assert.match(reminder, /\*\*Failing signal:\*\*/)
  assert.match(reminder, /\*\*Suggested next step:\*\*/)
  assert.match(reminder, /diffRelation=<related\|unrelated\|unknown>/)
  assert.match(reminder, /recommendedAction=<fix\|rerun\|wait\|ignore\|ask\|investigate>/)
})

test("the log sources are named only for the tools the session actually has", () => {
  const withShell = createCiInvestigatorSubagentConfig().systemReminder(toolSet({ SHELL: "Shell", WEB_FETCH: "WebFetch" }))
  assert.match(withShell, /Provider CLI via `Shell` \(preferred\)/)
  assert.match(withShell, /`WebFetch` as a last resort/)
  assert.doesNotMatch(withShell, /Provider MCP/)

  const withMcp = createCiInvestigatorSubagentConfig().systemReminder(toolSet({
    GET_MCP_TOOLS: "GetMcpTools",
    MCP: "CallMcpTool",
    MCP_AUTH: "McpAuth",
    LIST_MCP_RESOURCES: "ListMcpResources",
    FETCH_MCP_RESOURCE: "FetchMcpResource",
  }))
  assert.match(withMcp, /Provider MCP\./)
  assert.match(withMcp, /call `McpAuth` before using it/)
  assert.match(withMcp, /only use ones `GetMcpTools` returns/)
  assert.doesNotMatch(withMcp, /Provider CLI/)

  const withNothing = createCiInvestigatorSubagentConfig().systemReminder(toolSet())
  assert.match(withNothing, /If no CI log source is available, do NOT guess at causes/)
  assert.doesNotMatch(withNothing, /try these sources IN ORDER/)
})

test("the tools for inspecting code and recording findings are named when they exist", () => {
  const reminder = createCiInvestigatorSubagentConfig().systemReminder(toolSet({
    READ: "read_file",
    GREP: "grep",
    RECORD_CI_INVESTIGATION_FINDINGS: "RecordFindings",
  }))
  assert.match(reminder, /with `read_file` or search narrowly with `grep`/)
  assert.match(reminder, /call `RecordFindings` exactly once/)
  assert.match(reminder, /the parent agent cannot call it on your behalf/)

  const without = createCiInvestigatorSubagentConfig().systemReminder(toolSet())
  assert.doesNotMatch(without, /RecordFindings/)
})

test("the reminder insists the parent's fields are not re-derived and the excerpt is not refetched", () => {
  const reminder = createCiInvestigatorSubagentConfig().systemReminder(toolSet())
  assert.match(reminder, /TREAT AS AUTHORITATIVE, DO NOT REFETCH/)
  assert.match(reminder, /IT IS the log content you would otherwise fetch/)
  assert.match(reminder, /untrusted CI output/)
  assert.match(reminder, /Batch your remaining tool calls in parallel/)
})

// ---------------------------------------------------------------------------------------------
// a detail from the shell description that the investigator relies on
// ---------------------------------------------------------------------------------------------

test("the shell description the investigator is built against still names its arguments", () => {
  // The reminder tells the model to background work with block_until_ms; if the shell tool stopped
  // taking that argument the two would disagree.
  const description = getShellToolDescription(false, "dsv3-1205", { enableBlockUntilMs: true })
  assert.match(description, /block_until_ms/)
})

// ---------------------------------------------------------------------------------------------
// the configuration contract
// ---------------------------------------------------------------------------------------------

test("the configuration a tool generation consumes is a shape, and a config satisfies it", async () => {
  const { readFile } = await import("node:fs/promises")
  const source = await readFile(new URL("../../source/packages/agent/agent-config-tooling.ts", import.meta.url), "utf8")
  // The contract names the generator and the flags that change what a tool does.
  for (const field of [
    "toolsGenerator",
    "agentSessionId",
    "autoRejectFirstAskQuestion",
    "smartModeClassifierMode",
    "smartModeClassifierShadowMode",
    "enableToolArgPreservation",
    "featureFlags",
    "recordAgentStoreWriteBarrier",
    "nonFileRules",
  ]) {
    assert.equal(source.includes(field), true, field)
  }
})

test("a tool family lookup is available for the tools the investigator names", () => {
  assert.equal(getToolFamily("RECORD_CI_INVESTIGATION_FINDINGS"), "background")
  assert.equal(getToolFamily("WEB_FETCH"), "quality")
})

test("the investigator's reminder survives a tool set that has no tools at all", () => {
  const reminder = createCiInvestigatorSubagentConfig().systemReminder(undefined)
  assert.match(reminder, /^You are a CI failure investigator\./)
  assert.match(reminder, /If no CI log source is available/)
  assert.equal(renderContent(reminder).length > 0, true)
})
