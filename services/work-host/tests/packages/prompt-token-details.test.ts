import { test } from "node:test"
import assert from "node:assert/strict"

import { createContext } from "../../source/packages/context/context.ts"
import type {
  PromptContextUsageTreeValue,
  PromptTokenBreakdownSnapshotValue,
} from "../../source/packages/agent/utils/prompt-usage-contracts.ts"
import {
  PROMPT_TOKEN_CATEGORIES,
  buildPromptTokenBreakdownSnapshot,
  buildSummarizeRefreshSnapshot,
} from "../../source/packages/agent/utils/prompt-token-breakdown.ts"
import { buildPromptContextUsageTree } from "../../source/packages/agent/utils/prompt-context-usage-tree.ts"
import {
  computeNextPromptContextDetails,
  type PromptTokenDetailsState,
} from "../../source/packages/agent/utils/next-redacted-prompt-context-details.ts"
import type { PromptMessageLike, PromptToolLike } from "../../source/packages/agent/utils/prompt-shapes.ts"

const ctx = () => createContext()

const categoriesOf = (snapshot: PromptTokenBreakdownSnapshotValue): Record<string, { tokens: number; chars: number | undefined }> =>
  Object.fromEntries(snapshot.categories.map(category => [
    category.id,
    { tokens: category.estimatedTokens, chars: category.characterCount },
  ]))

const tokensOf = (snapshot: PromptTokenBreakdownSnapshotValue): number =>
  snapshot.categories.reduce((sum, category) => sum + category.estimatedTokens, 0)

function message(role: string, content: unknown, extra: Record<string, unknown> = {}): PromptMessageLike {
  return { role, content, ...extra } as PromptMessageLike
}

/** A prompt with one of each piece the breakdown knows how to find. */
function samplePrompt(): PromptMessageLike[] {
  return [
    message("system", "You are an agent.\n<mcp_tools>\n<tool name=\"search\" />\n</mcp_tools>\nBe careful."),
    message("user", [
      { type: "text", text: "<user_info>workspace</user_info>\n<rules>\n<project_rule name=\"a\">one</project_rule>\n</rules>\n<agent_skills>\n<agent_skill name=\"s\">skill text</agent_skill>\n</agent_skills>\n<available_subagent_models>\n- model: fast\n</available_subagent_models>\nhello" },
    ]),
    message("assistant", [
      { type: "text", text: "let me look" },
      { type: "tool-call", toolCallId: "call-1", toolName: "shell", args: { command: "ls" } },
    ]),
    message("tool", [
      { type: "tool-result", toolCallId: "call-1", toolName: "shell", result: "a\nb" },
    ]),
    message("user", "the summary of everything so far", { providerOptions: { slate: { isSummary: true } } }),
  ]
}

const simpleTools: PromptToolLike[] = [{
  name: "shell",
  toolIdentifier: "SHELL",
  description: "runs a command",
  parameters: { type: "object" },
}]

// ---------------------------------------------------------------------------------------------
// prompt-token-breakdown: splitting a prompt into what it was built from
// ---------------------------------------------------------------------------------------------

test("the breakdown reports every category, in the order the platform declares them", () => {
  assert.deepEqual(PROMPT_TOKEN_CATEGORIES, [
    { id: "system_prompt", label: "System prompt" },
    { id: "tools", label: "Tool definitions" },
    { id: "rules", label: "Rules" },
    { id: "skills", label: "Skills" },
    { id: "mcp", label: "MCP & dynamic tools" },
    { id: "subagents", label: "Subagent definitions" },
    { id: "summarized_conversation", label: "Summarized conversation" },
    { id: "conversation", label: "Conversation" },
  ])
  const snapshot = buildPromptTokenBreakdownSnapshot(ctx(), {
    messages: samplePrompt(),
    tools: simpleTools,
    totalUsedTokens: 1_000,
    maxTokens: 8_000,
  })
  assert.deepEqual(snapshot.categories.map(category => category.id), PROMPT_TOKEN_CATEGORIES.map(category => category.id))
  assert.deepEqual(snapshot.categories.map(category => category.label), PROMPT_TOKEN_CATEGORIES.map(category => category.label))
})

test("when every category has zero raw weight, the total belongs to the conversation", () => {
  const snapshot = buildPromptTokenBreakdownSnapshot(ctx(), {
    messages: [],
    tools: [],
    totalUsedTokens: 42,
    maxTokens: 100,
  })
  assert.equal(categoriesOf(snapshot).conversation?.tokens, 42)
  assert.equal(tokensOf(snapshot), 42)
})

test("equal fractional remainders award the extra token in category order", () => {
  const snapshot = buildPromptTokenBreakdownSnapshot(ctx(), {
    messages: [message("system", "aaaa"), message("user", "bbbb")],
    tools: [],
    totalUsedTokens: 1,
    maxTokens: 100,
  })
  assert.equal(categoriesOf(snapshot).system_prompt?.tokens, 1)
  assert.equal(categoriesOf(snapshot).conversation?.tokens, 0)
  assert.equal(tokensOf(snapshot), 1)
})

test("the parts add up to the total the provider reported", () => {
  const snapshot = buildPromptTokenBreakdownSnapshot(ctx(), {
    messages: samplePrompt(),
    tools: simpleTools,
    totalUsedTokens: 1_000,
    maxTokens: 8_000,
  })
  assert.equal(tokensOf(snapshot), 1_000)
  assert.equal(snapshot.totalUsedTokens, 1_000)
  assert.equal(snapshot.maxTokens, 8_000)
})

test("each piece of the prompt is counted where it belongs", () => {
  const snapshot = buildPromptTokenBreakdownSnapshot(ctx(), {
    messages: samplePrompt(),
    tools: simpleTools,
    totalUsedTokens: 1_000,
    maxTokens: 8_000,
  })
  const categories = categoriesOf(snapshot)
  // The system prompt keeps its text but not the tool block inside it.
  assert.ok((categories.system_prompt?.chars ?? 0) > 0)
  assert.ok((categories.system_prompt?.chars ?? 0) < "You are an agent.\n<mcp_tools>\n<tool name=\"search\" />\n</mcp_tools>\nBe careful.".length)
  assert.ok((categories.tools?.chars ?? 0) > 0)
  assert.ok((categories.rules?.chars ?? 0) > 0)
  assert.ok((categories.skills?.chars ?? 0) > 0)
  assert.ok((categories.mcp?.chars ?? 0) > 0)
  assert.ok((categories.subagents?.chars ?? 0) > 0)
  assert.ok((categories.summarized_conversation?.chars ?? 0) > 0)
  assert.ok((categories.conversation?.chars ?? 0) > 0)
})

test("the summary is counted as its own category and not as conversation", () => {
  const snapshot = buildPromptTokenBreakdownSnapshot(ctx(), {
    messages: [
      message("user", "the summary of everything so far", { providerOptions: { slate: { isSummary: true } } }),
    ],
    tools: [],
    totalUsedTokens: 100,
    maxTokens: 1_000,
  })
  const categories = categoriesOf(snapshot)
  assert.equal(categories.summarized_conversation?.chars, "the summary of everything so far".length)
  assert.equal(categories.conversation?.chars, 0)
})

test("a prompt that is only a conversation gives the whole total to it", () => {
  const snapshot = buildPromptTokenBreakdownSnapshot(ctx(), {
    messages: [message("user", "hello there")],
    tools: [],
    totalUsedTokens: 42,
    maxTokens: 1_000,
  })
  const categories = categoriesOf(snapshot)
  assert.equal(categories.conversation?.tokens, 42)
  assert.equal(tokensOf(snapshot), 42)
})

test("the apportionment keeps the total exactly, down to the last token", () => {
  for (const total of [1, 2, 3, 7, 101]) {
    const snapshot = buildPromptTokenBreakdownSnapshot(ctx(), {
      messages: samplePrompt(),
      tools: simpleTools,
      totalUsedTokens: total,
      maxTokens: 1_000,
    })
    assert.equal(tokensOf(snapshot), total, String(total))
  }
})

test("a total of zero leaves every category at zero", () => {
  const snapshot = buildPromptTokenBreakdownSnapshot(ctx(), {
    messages: samplePrompt(),
    tools: simpleTools,
    totalUsedTokens: 0,
    maxTokens: 1_000,
  })
  assert.equal(tokensOf(snapshot), 0)
  assert.equal(snapshot.totalUsedTokens, 0)
})

test("a negative or fractional total is clamped to a whole number", () => {
  const negative = buildPromptTokenBreakdownSnapshot(ctx(), {
    messages: [message("user", "x")],
    tools: [],
    totalUsedTokens: -5,
    maxTokens: -1,
  })
  assert.equal(negative.totalUsedTokens, 0)
  assert.equal(negative.maxTokens, 0)

  const fractional = buildPromptTokenBreakdownSnapshot(ctx(), {
    messages: [message("user", "x")],
    tools: [],
    totalUsedTokens: 10.6,
    maxTokens: 100,
  })
  assert.equal(fractional.totalUsedTokens, 11)
  assert.equal(tokensOf(fractional), 11)
})

test("a previous breakdown with character counts is reused for the categories it covers", () => {
  const params = { messages: samplePrompt(), tools: simpleTools, maxTokens: 8_000 }
  const first = buildPromptTokenBreakdownSnapshot(ctx(), { ...params, totalUsedTokens: 1_000 })
  const second = buildPromptTokenBreakdownSnapshot(ctx(), { ...params, totalUsedTokens: 1_200, previousSnapshot: first })
  const before = categoriesOf(first)
  const after = categoriesOf(second)
  // The prompt did not change, so the cached categories keep their estimates exactly.
  for (const category of PROMPT_TOKEN_CATEGORIES) {
    if (category.id === "conversation") continue
    assert.equal(after[category.id]?.tokens, before[category.id]?.tokens, category.id)
    assert.equal(after[category.id]?.chars, before[category.id]?.chars, category.id)
  }
  // The conversation takes the difference, and the parts still add up.
  assert.equal(tokensOf(second), 1_200)
  assert.ok((after.conversation?.tokens ?? 0) > (before.conversation?.tokens ?? 0))
})

test("a category that grew keeps its own ratio rather than the average", () => {
  const previous: PromptTokenBreakdownSnapshotValue = {
    totalUsedTokens: 100,
    maxTokens: 1_000,
    categories: PROMPT_TOKEN_CATEGORIES.map(category => ({
      id: category.id,
      label: category.label,
      estimatedTokens: category.id === "tools" ? 20 : category.id === "conversation" ? 80 : 0,
      characterCount: category.id === "tools" ? 100 : category.id === "conversation" ? 400 : 0,
    })),
  }
  const tools = [{ name: "shell", toolIdentifier: "SHELL", description: "x".repeat(200), parameters: {} }]
  const snapshot = buildPromptTokenBreakdownSnapshot(ctx(), {
    messages: [message("user", "hello")],
    tools,
    totalUsedTokens: 500,
    maxTokens: 1_000,
    previousSnapshot: previous,
  })
  const categories = categoriesOf(snapshot)
  // Twice the characters at the same ratio: the tool text is 208 characters, so 42 tokens, and the
  // conversation gets whatever the total leaves.
  assert.equal(categories.tools?.tokens, 42)
  assert.equal(categories.conversation?.tokens, 458)
})

test("a previous breakdown without character counts is not reused", () => {
  const previous: PromptTokenBreakdownSnapshotValue = {
    totalUsedTokens: 100,
    maxTokens: 1_000,
    categories: PROMPT_TOKEN_CATEGORIES.map(category => ({
      id: category.id,
      label: category.label,
      estimatedTokens: 0,
      characterCount: undefined as unknown as number,
    })),
  }
  const snapshot = buildPromptTokenBreakdownSnapshot(ctx(), {
    messages: [message("user", "hello")],
    tools: [],
    totalUsedTokens: 50,
    maxTokens: 1_000,
    previousSnapshot: previous,
  })
  // Nothing was cached, so the raw estimate is apportioned to the total instead.
  assert.equal(tokensOf(snapshot), 50)
  assert.equal(categoriesOf(snapshot).conversation?.tokens, 50)
})

test("a cache that would exceed the total keeps the previous breakdown instead of going negative", () => {
  const previous: PromptTokenBreakdownSnapshotValue = {
    totalUsedTokens: 1_000,
    maxTokens: 8_000,
    categories: PROMPT_TOKEN_CATEGORIES.map(category => ({
      id: category.id,
      label: category.label,
      estimatedTokens: category.id === "tools" ? 900 : 0,
      characterCount: category.id === "tools" ? 100 : 0,
    })),
  }
  const tools = [{ name: "shell", toolIdentifier: "SHELL", description: "x".repeat(400), parameters: {} }]
  const snapshot = buildPromptTokenBreakdownSnapshot(ctx(), {
    messages: [message("user", "hello")],
    tools,
    totalUsedTokens: 500,
    maxTokens: 8_000,
    previousSnapshot: previous,
  })
  assert.equal(snapshot, previous)
})

test("a refresh after summarization moves only the summary", () => {
  const previous = buildPromptTokenBreakdownSnapshot(ctx(), {
    messages: samplePrompt(),
    tools: simpleTools,
    totalUsedTokens: 1_000,
    maxTokens: 8_000,
  })
  const before = categoriesOf(previous)
  const refreshed = buildSummarizeRefreshSnapshot({
    previousSnapshot: previous,
    newSummarizedConversationCharCount: (before.summarized_conversation?.chars ?? 0) * 2,
    totalUsedTokens: 1_000,
    maxTokens: 8_000,
  })
  assert.ok(refreshed)
  const after = categoriesOf(refreshed!)
  for (const category of PROMPT_TOKEN_CATEGORIES) {
    if (category.id === "summarized_conversation" || category.id === "conversation") continue
    assert.equal(after[category.id]?.chars, before[category.id]?.chars, category.id)
    assert.equal(after[category.id]?.tokens, before[category.id]?.tokens, category.id)
  }
  assert.ok((after.summarized_conversation?.tokens ?? 0) > (before.summarized_conversation?.tokens ?? 0))
  assert.equal(tokensOf(refreshed!), 1_000)
})

test("a refresh with nothing to reuse returns what it was given", () => {
  assert.equal(buildSummarizeRefreshSnapshot({
    previousSnapshot: undefined,
    newSummarizedConversationCharCount: 10,
    totalUsedTokens: 100,
    maxTokens: 1_000,
  }), undefined)
})

// ---------------------------------------------------------------------------------------------
// prompt-context-usage-tree: the same prompt, walkable
// ---------------------------------------------------------------------------------------------

function treeOf(overrides: Record<string, unknown> = {}) {
  const messages = (overrides.messages ?? samplePrompt()) as Record<string, unknown>[]
  const tools = (overrides.tools ?? simpleTools) as Record<string, unknown>[]
  const breakdown = buildPromptTokenBreakdownSnapshot(ctx(), {
    messages: messages as never,
    tools: tools as never,
    totalUsedTokens: 1_000,
    maxTokens: 8_000,
  })
  return buildPromptContextUsageTree({ ...overrides, messages: messages as never, tools: tools as never, breakdown })
}

test("the tree carries a schema version and one category node per category", () => {
  const tree = treeOf()
  assert.equal(tree.schemaVersion, 1)
  const categoryNodes = tree.nodes.filter(node => node.kind === "category")
  assert.equal(categoryNodes.length, PROMPT_TOKEN_CATEGORIES.length)
  assert.deepEqual(categoryNodes.map(node => node.id), PROMPT_TOKEN_CATEGORIES.map(category => `category:${category.id}`))
  for (const node of categoryNodes) {
    assert.equal(node.parentId, undefined)
    assert.equal(node.contentAvailable, false)
  }
})

test("a category node carries the numbers the breakdown reported", () => {
  const tree = treeOf()
  const conversation = tree.nodes.find(node => node.id === "category:conversation")
  assert.ok(conversation)
  assert.ok(conversation.estimatedTokens > 0)
  assert.ok(conversation.characterCount > 0)
})

test("every node but a category node hangs under one", () => {
  const tree = treeOf()
  const ids = new Set(tree.nodes.map(node => node.id))
  for (const node of tree.nodes) {
    if (node.kind === "category") continue
    assert.ok(node.parentId !== undefined, node.id)
    assert.ok(ids.has(node.parentId), `${node.id} -> ${node.parentId}`)
  }
})

test("a message node names the message it came from and where inside it", () => {
  const tree = treeOf({ messages: [message("user", "hello there")], tools: [] })
  const node = tree.nodes.find(candidate => candidate.id === "message:0:content")
  assert.ok(node)
  assert.equal(node.kind, "user_message")
  assert.equal(node.label, "User Message")
  assert.equal(node.categoryId, "conversation")
  assert.equal(node.inlineContent, undefined)
  assert.equal(node.source?.sourceType, "root_prompt_message")
  assert.equal(node.source?.messageIndex, 0)
  assert.equal(node.source?.contentPath, "content")
  assert.equal(node.source?.startOffset, 0)
  assert.equal(node.source?.endOffset, "hello there".length)
})

test("an assistant message is labelled for the reader, and an unknown role is not invented", () => {
  const tree = treeOf({ messages: [message("assistant", "hi"), message("developer", "hmm")], tools: [] })
  assert.equal(tree.nodes.find(node => node.id === "message:0:content")?.label, "Agent Message")
  assert.equal(tree.nodes.find(node => node.id === "message:1:content")?.label, "Developer Message")
  assert.equal(tree.nodes.find(node => node.id === "message:1:content")?.kind, "developer_message")
})

test("a tool call and its result become one node with two children", () => {
  const tree = treeOf({
    messages: [
      message("assistant", [{ type: "tool-call", toolCallId: "call-1", toolName: "shell", args: { command: "ls" } }]),
      message("tool", [{ type: "tool-result", toolCallId: "call-1", toolName: "shell", result: "a\nb" }]),
    ],
    tools: [],
  })
  const pair = tree.nodes.find(node => node.kind === "tool_call_pair")
  assert.ok(pair)
  assert.equal(pair.label, "shell Tool")
  assert.equal(pair.parentId, "category:conversation")
  const call = tree.nodes.find(node => node.id === `${pair.id}:call`)
  const result = tree.nodes.find(node => node.id === `${pair.id}:result`)
  assert.equal(call?.label, "Call")
  assert.equal(result?.label, "Result")
  assert.equal(call?.source?.contentPath, "content[0].args")
  assert.equal(result?.source?.messageIndex, 1)
  assert.equal(result?.source?.contentPath, "content[0].result")
  // The result is shown under its call, not again as a message node of its own.
  assert.equal(tree.nodes.some(node => node.id === "message:1:content[0].result"), false)
})

test("a tool call whose result never arrived still shows its own text", () => {
  const tree = treeOf({
    messages: [message("assistant", [{ type: "tool-call", toolCallId: "call-1", toolName: "shell", args: {} }])],
    tools: [],
  })
  const pair = tree.nodes.find(node => node.kind === "tool_call_pair")
  assert.ok(pair)
  assert.equal(tree.nodes.some(node => node.id === `${pair.id}:result`), false)
  assert.equal(tree.nodes.some(node => node.id === `${pair.id}:call`), true)
})

test("a tool call without an id is shown as a message part instead of being paired", () => {
  const tree = treeOf({
    messages: [message("assistant", [{ type: "tool-call", toolName: "shell", args: { command: "ls" } }])],
    tools: [],
  })
  assert.equal(tree.nodes.some(node => node.kind === "tool_call_pair"), false)
  assert.equal(tree.nodes.some(node => node.id === "message:0:content[0].args"), true)
})

test("redacted reasoning is not part of the prompt the platform sent", () => {
  const tree = treeOf({
    messages: [message("assistant", [{ type: "redacted-reasoning", text: "hidden" }])],
    tools: [],
  })
  assert.equal(tree.nodes.some(node => node.label === "Agent Message"), false)
})

test("rules and skills become their own nodes, labelled with the name they declare", () => {
  const tree = treeOf()
  const rules = tree.nodes.filter(node => node.kind === "rule")
  const skills = tree.nodes.filter(node => node.kind === "skill")
  assert.deepEqual(rules.map(node => node.label), ["a"])
  assert.deepEqual(skills.map(node => node.label), ["s"])
  assert.equal(rules[0]?.parentId, "category:rules")
  assert.equal(skills[0]?.parentId, "category:skills")
  assert.match(String(rules[0]?.source?.contentPath), /^content\[0\]\.text$/)
  assert.equal(rules[0]?.source?.messageIndex, 1)
})

test("a rule without a name falls back to its position", () => {
  const tree = treeOf({
    messages: [message("user", "<rules>\n<project_rule>no name</project_rule>\n</rules>")],
    tools: [],
  })
  assert.deepEqual(tree.nodes.filter(node => node.kind === "rule").map(node => node.label), ["Rule 1"])
})

test("a rule name is decoded from the tag's entities", () => {
  const tree = treeOf({
    messages: [message("user", '<rules>\n<project_rule name="a &amp; b&quot;c">x</project_rule>\n</rules>')],
    tools: [],
  })
  // Decoding happens before matching, so a decoded quote ends the attribute value it sits in.
  assert.deepEqual(tree.nodes.filter(node => node.kind === "rule").map(node => node.label), ["a & b"])
})

test("mcp blocks become nodes, and their wrappers do not", () => {
  const tree = treeOf()
  const blocks = tree.nodes.filter(node => node.kind === "mcp_block")
  assert.ok(blocks.length > 0)
  assert.equal(blocks.some(node => node.label === "<mcp_tools>"), true)
  assert.equal(blocks.some(node => node.label === "<mcp_file_system>"), false)
  for (const node of blocks) assert.equal(node.parentId, "category:mcp")
})

test("a tool definition becomes a node with its size, and nothing to open", () => {
  const tree = treeOf()
  const tool = tree.nodes.find(node => node.id === "tool:0")
  assert.ok(tool)
  assert.equal(tool.kind, "tool_definition")
  assert.equal(tool.label, "shell")
  assert.equal(tool.parentId, "category:tools")
  assert.equal(tool.contentAvailable, false)
  assert.ok(tool.estimatedTokens > 0)
  assert.equal(tool.characterCount, `shell runs a command ${JSON.stringify({ type: "object" })}`.length)
})

test("subagent definitions inside the task tool's description become their own nodes", () => {
  const taskTool = {
    name: "task",
    toolIdentifier: "TASK",
    description: "spawn a subagent\n- explore: find things\n- plan: make a plan",
    parameters: {},
    descriptionTokenPartsGenerator: () => ({ subagentDescriptionText: "- explore: find things\n- plan: make a plan" }),
  }
  const tree = treeOf({ messages: [message("user", "hi")], tools: [taskTool] })
  const subagentTypes = tree.nodes.filter(node => node.kind === "subagent_type")
  assert.deepEqual(subagentTypes.map(node => node.label), ["explore", "plan"])
  assert.equal(subagentTypes[0]?.parentId, "category:subagents")
  assert.equal(subagentTypes[0]?.inlineContent, "- explore: find things")
  // The tool node no longer contains the subagent text: what is left is the description with the
  // subagent lines removed, still followed by the newline they were separated by.
  const tool = tree.nodes.find(node => node.id === "tool:0")
  assert.equal(tool?.characterCount, `task spawn a subagent\n ${JSON.stringify({})}`.length)
})

test("a task description with no bullets is shown whole under the subagents category", () => {
  const taskTool = {
    name: "task",
    toolIdentifier: "TASK",
    description: "spawn a subagent\njust prose",
    parameters: {},
    descriptionTokenPartsGenerator: () => ({ subagentDescriptionText: "just prose" }),
  }
  const tree = treeOf({ messages: [message("user", "hi")], tools: [taskTool] })
  const node = tree.nodes.find(candidate => candidate.kind === "subagent_description")
  assert.ok(node)
  assert.equal(node.label, "task")
  assert.equal(node.inlineContent, "just prose")
})

test("inline content is capped, and the node still reports its full size", () => {
  const long = "x".repeat(40_000 + 10)
  const tree = treeOf({
    messages: [message("user", "hi")],
    tools: [{
      name: "task",
      toolIdentifier: "TASK",
      description: `spawn\n- big: ${long}`,
      parameters: {},
      descriptionTokenPartsGenerator: () => ({ subagentDescriptionText: `- big: ${long}` }),
    }],
  })
  const node = tree.nodes.find(candidate => candidate.kind === "subagent_type")
  assert.equal(node?.inlineContent?.length, 40_000)
  assert.equal(node?.characterCount, `- big: ${long}`.length)
  assert.ok((node?.estimatedTokens ?? 0) > 0)
})

test("the tree stops growing at its node limit", () => {
  const messages = Array.from({ length: 5_000 }, (_, index) => message("user", `message ${index}`))
  const tree = treeOf({ messages, tools: [] })
  assert.equal(tree.nodes.length, 4_000)
  assert.equal(tree.nodes.length > 3_900, true)
})

test("an empty message contributes no node", () => {
  const tree = treeOf({ messages: [message("user", ""), message("assistant", [])], tools: [] })
  assert.equal(tree.nodes.some(node => node.id === "message:0:content"), false)
})

test("a value that cannot be serialized is left out rather than breaking the tree", () => {
  const circular: Record<string, unknown> = {}
  circular.self = circular
  const tree = treeOf({ messages: [message("assistant", [circular])], tools: [] })
  assert.equal(tree.nodes.some(node => node.kind === "assistant_message"), false)
})

// ---------------------------------------------------------------------------------------------
// next-redacted-prompt-context-details: the details a reader may see
// ---------------------------------------------------------------------------------------------

function detailsState(overrides: { readonly tokenDetails?: PromptTokenDetailsState["tokenDetails"] } = {}): PromptTokenDetailsState {
  return { tokenDetails: overrides.tokenDetails ?? {} }
}

test("Slate token details are computed without retaining prompt text", () => {
  const details = computeNextPromptContextDetails(
    ctx(),
    {},
    detailsState(),
    { messages: samplePrompt() as never, tools: simpleTools as never, totalUsedTokens: 500, maxTokens: 8_000 },
  )
  assert.equal(details.breakdown.totalUsedTokens, 500)
  assert.equal(JSON.stringify(details.breakdown).includes("the summary of everything so far"), false)
})

test("the previous Slate context tree is carried over untouched when the feature is off", () => {
  const previousTree: PromptContextUsageTreeValue = { schemaVersion: 1, nodes: [] }
  const details = computeNextPromptContextDetails(
    ctx(),
    { featureFlags: { promptContextUsageTree: false } },
    detailsState({ tokenDetails: { contextTree: previousTree } }),
    { messages: samplePrompt() as never, tools: simpleTools as never, totalUsedTokens: 500, maxTokens: 8_000 },
  )
  assert.equal(details.contextTree, previousTree)
})

test("the Slate context tree is rebuilt when the feature is on, replacing the previous one", () => {
  const previousTree: PromptContextUsageTreeValue = { schemaVersion: 1, nodes: [] }
  const details = computeNextPromptContextDetails(
    ctx(),
    { featureFlags: { promptContextUsageTree: true } },
    detailsState({ tokenDetails: { contextTree: previousTree } }),
    { messages: samplePrompt() as never, tools: simpleTools as never, totalUsedTokens: 500, maxTokens: 8_000 },
  )
  assert.notEqual(details.contextTree, previousTree)
  assert.equal(details.contextTree?.schemaVersion, 1)
  assert.ok((details.contextTree?.nodes.length ?? 0) > 0)
})

test("the previous breakdown is fed back in, so the categories stay stable across turns", () => {
  const params = { messages: samplePrompt() as never, tools: simpleTools as never, maxTokens: 8_000 }
  const first = computeNextPromptContextDetails(ctx(), {}, detailsState(), { ...params, totalUsedTokens: 1_000 })
  const second = computeNextPromptContextDetails(
    ctx(),
    {},
    detailsState({ tokenDetails: { breakdown: first.breakdown } }),
    { ...params, totalUsedTokens: 1_000 },
  )
  const categoriesOfDetails = (details: { breakdown: PromptTokenBreakdownSnapshotValue }) => details.breakdown.categories
  assert.deepEqual(categoriesOfDetails(second), categoriesOfDetails(first))
})
