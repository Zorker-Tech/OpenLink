import { test } from "node:test"
import assert from "node:assert/strict"

import { AgentMode, SimulatedMsgReason } from "../../source/adapters/interop/proto/generated/agent/v1/agent_pb.ts"
import { SlateMode } from "../../source/packages/agent/mode-processing.ts"
import { PrivacyMode } from "../../source/packages/redaction/privacy-mode.ts"
import { AgentType } from "../../source/packages/agent/utils/agent-config.ts"
import { BackgroundSubagentActionHandler } from "../../source/packages/agent/actions/background-subagent-action-handler.ts"
import { renderRecentAgentsContext } from "../../source/packages/agent/context/recent-agents-context.ts"
import { renderAgentNotesContext } from "../../source/packages/agent/context/agent-notes-context.ts"
import { renderSelectedUIElementsContext } from "../../source/packages/agent/context/ui-elements-context.ts"
import {
  DEFAULT_SUBAGENT_SLUG,
  buildAvailableModelsDescription,
  createSubagentModels,
} from "../../source/packages/agent/tools/core/subagent/models.ts"
import {
  PROMPT_REFERENCE_ID_LENGTH,
  createPromptReferenceId,
  createPromptReferenceIdFromMessageId,
  createToolCallReferenceId,
  isValidPromptReferenceId,
  parseLeadingUserMessageIdTag,
  renderToolCallIdTag,
  renderUserMessageIdTag,
} from "../../source/packages/agent/tools/prompt-reference-contract.ts"
import {
  DEV_SMART_MODE_CLASSIFIER_BLOCK_REASON,
  createDevSmartModeClassifierBlockState,
  delayDevSmartModeClassifierIfRequested,
} from "../../source/packages/agent/tools/dev-smart-mode-classifier-block.ts"
import { getSmartModeClassifierRuntimeState } from "../../source/packages/agent/tools/smart-mode-classifier-runtime-state.ts"
import { isProjectWorkspaceConversation } from "../../source/packages/agent/configs/project-workspace-mcp-tools.ts"
import { synthesizeMultitaskActionPrompt } from "../../source/packages/agent/multitask-action-prompt.ts"
import {
  VIDEO_REVIEW_SUBAGENT_MAX_BYTES,
  getInlineVideoMaxBytes,
  getSignedUrlVideoMaxBytes,
  isSignedUrlStorageAllowed,
} from "../../source/packages/agent/attached-media.ts"
import { buildGitCommitsUserContent } from "../../source/packages/agent/git-commit-processing.ts"
import { collectLiveAskQuestionOriginalIds } from "../../source/packages/agent/tools/core/ask-question/replay-horizon.ts"
import { buildReminderContext } from "../../source/packages/agent/reminders/context-builder.ts"
import { applyRemindersToToolResults } from "../../source/packages/agent/reminders/apply-reminders.ts"
import { createContext } from "../../source/packages/context/context.ts"

// ---------------------------------------------------------------------------------------------
// the side-channel handler
// ---------------------------------------------------------------------------------------------

test("a subagent reporting in recomputes state and runs no tool", async () => {
  const handler = new BackgroundSubagentActionHandler()
  const stateHandler = { computeNewStructure: () => ({ fresh: true }) }
  assert.deepEqual(await handler.handle(createContext(), {}, {}, stateHandler, {}, {}), { fresh: true })
})

// ---------------------------------------------------------------------------------------------
// context blocks
// ---------------------------------------------------------------------------------------------

test("recent agents are listed with their transcript paths", () => {
  const rendered = renderRecentAgentsContext({
    recentAgents: [{ name: "Fix the build", path: "/t/a.jsonl", overview: "  what it did  " }],
    isLegacyAgentMatterhorn: false,
    isRawTrainingSlug: false,
  })
  assert.match(rendered!.text, /- Fix the build/)
  assert.match(rendered!.text, /overview: what it did/)
  assert.match(rendered!.text, /transcript_path: \/t\/a\.jsonl/)
  assert.match(rendered!.text, /Search first, then read a few relevant sections/)
})

test("a model that never saw transcript paths is given none", () => {
  const rendered = renderRecentAgentsContext({
    recentAgents: [{ name: "x", path: "/t/a.jsonl" }],
    isLegacyAgentMatterhorn: true,
    isRawTrainingSlug: true,
  })
  assert.equal(rendered, undefined)
})

test("agent notes are given only where they are not the project's or the meta agent's own", () => {
  const base = {
    enableAgentNotes: true,
    metaAgentNotes: false,
    conversationNotesListing: "a.md",
    sharedNotesListing: "b.md",
  }
  assert.equal(renderAgentNotesContext({ ...base, isProjectConversation: true }), undefined)
  assert.equal(renderAgentNotesContext({ ...base, metaAgentNotes: true, isProjectConversation: false }), undefined)
  assert.equal(renderAgentNotesContext({ ...base, enableAgentNotes: false, isProjectConversation: false }), undefined)
  assert.equal(renderAgentNotesContext({ ...base, conversationNotesListing: undefined, sharedNotesListing: undefined, isProjectConversation: false }), undefined)

  const rendered = renderAgentNotesContext({ ...base, isProjectConversation: false })
  assert.match(rendered!.text, /^<agent_notes>/)
  assert.match(rendered!.text, /Conversation notes:\na\.md/)
  assert.match(rendered!.text, /Shared notes:\nb\.md/)
  assert.match(rendered!.text, /<\/agent_notes>$/)
})

test("a picked React element carries its props, parsed and pretty-printed", () => {
  const rendered = renderSelectedUIElementsContext([
    { element: "", textContent: "", component: "Button", componentPropsJson: '{"label":"Go"}', xpath: "/html/body/button" },
  ])
  assert.match(rendered!.text, /React Component: Button/)
  assert.match(rendered!.text, /"label": "Go"/)
  assert.match(rendered!.text, /xpath: \/html\/body\/button/)
})

test("props that do not parse are reported as invalid rather than dropped", () => {
  const rendered = renderSelectedUIElementsContext([
    { element: "", textContent: "", component: "Button", componentPropsJson: "{not json", xpath: "/b" },
  ])
  assert.match(rendered!.text, /Invalid JSON/)
})

test("a picked element that is not a component shows its markup and text", () => {
  const rendered = renderSelectedUIElementsContext([
    { element: "<div>hi</div>", xpath: "/d", textContent: "hi" },
  ])
  assert.match(rendered!.text, /<div>hi<\/div>/)
  assert.match(rendered!.text, /textContent: hi/)
  assert.doesNotMatch(rendered!.text, /React Component/)
})

test("an empty selection adds no section, and falsey parsed props are shown as absent", () => {
  assert.equal(renderSelectedUIElementsContext([]), undefined)
  const rendered = renderSelectedUIElementsContext([
    { element: "", textContent: "", component: "Toggle", componentPropsJson: "false", xpath: "/toggle" },
  ])
  assert.match(rendered!.text, /Props: None/)
})

// ---------------------------------------------------------------------------------------------
// the subagent model list
// ---------------------------------------------------------------------------------------------

test("a blocked model is left out of the list rather than listed and refused", () => {
  const models = createSubagentModels(
    { a: { slug: "fast" }, b: { slug: "slow" } },
    slug => slug === "slow",
  )
  assert.deepEqual([...models.modelsBySlug.keys()], ["fast"])
  assert.equal(DEFAULT_SUBAGENT_SLUG, "composer-2.5")
})

test("the model description refuses substitution and asks for the user's own naming", () => {
  const models = createSubagentModels({ a: { slug: "zeta" }, b: { slug: "alpha" } })
  const description = buildAvailableModelsDescription(models)
  assert.match(description, /- alpha\n- zeta/)
  assert.match(description, /choose only model identifiers from this list/)
  assert.match(description, /do not substitute another model/)
  assert.match(description, /same naming style the user used/)
  assert.match(description, /newest listed version/)
})

test("the inherit option is offered only when asked for, and an empty list says so", () => {
  const models = createSubagentModels({ a: { slug: "one" } })
  assert.doesNotMatch(buildAvailableModelsDescription(models), /inherit/)
  assert.match(buildAvailableModelsDescription(models, true), /- inherit — default/)
  assert.equal(
    buildAvailableModelsDescription(createSubagentModels({})),
    "No alternative child model is available. Children use the parent model.",
  )
})

test("the displayed catalogue uses unique, unblocked model slugs in sorted order", () => {
  const blocked: string[] = []
  const models = createSubagentModels({
    late: { slug: "zeta" },
    hidden: { slug: "private-choice" },
    early: { slug: "alpha" },
    repeated: { slug: "alpha" },
  }, slug => {
    blocked.push(slug)
    return slug === "private-choice"
  })

  assert.deepEqual(blocked, ["zeta", "private-choice", "alpha", "alpha"])
  assert.deepEqual([...models.modelsBySlug.keys()], ["zeta", "alpha"])
  assert.match(buildAvailableModelsDescription(models), /- alpha\n- zeta/)
})

// ---------------------------------------------------------------------------------------------
// prompt references
// ---------------------------------------------------------------------------------------------

test("a message's reference is derived, so it is the same every time", () => {
  const first = createPromptReferenceIdFromMessageId("message-1")
  assert.equal(first, createPromptReferenceIdFromMessageId("message-1"))
  assert.notEqual(first, createPromptReferenceIdFromMessageId("message-2"))
  assert.equal(first.length, PROMPT_REFERENCE_ID_LENGTH)
  assert.equal(isValidPromptReferenceId(first), true)
})

test("a reference with no message behind it is random, and valid", () => {
  const id = createPromptReferenceId()
  assert.equal(isValidPromptReferenceId(id), true)
  assert.equal(isValidPromptReferenceId(createPromptReferenceId("")), true)
  assert.notEqual(createPromptReferenceId(), createPromptReferenceId())
  assert.equal(isValidPromptReferenceId("short"), false)
})

test("a tool call's reference is its own suffix when it has one", () => {
  assert.equal(createToolCallReferenceId("call_abcdefg"), "abcdefg")
  assert.equal(createToolCallReferenceId("call_abcdefghij"), "abcdefg")
  assert.equal(createToolCallReferenceId("nodashhere"), "nodashhere")
  assert.equal(createToolCallReferenceId("   "), "")
  assert.equal(createToolCallReferenceId("call_ab"), "call_ab")
})

test("the tags render and parse back, in both spellings", () => {
  const id = createPromptReferenceIdFromMessageId("m")
  assert.equal(renderUserMessageIdTag(id), `<user_message_id>${id}</user_message_id>`)
  assert.equal(renderToolCallIdTag(id), `<tool_call_id>${id}</tool_call_id>`)

  const parsed = parseLeadingUserMessageIdTag(`${renderUserMessageIdTag(id)}\nhello`)
  assert.equal(parsed?.id, id)
  assert.equal(parsed?.strippedText, "hello")

  const legacy = parseLeadingUserMessageIdTag(`<user_message_id>message_id=${id}</user_message_id>\nhello`)
  assert.equal(legacy?.id, id)
  assert.equal(legacy?.strippedText, "hello")

  assert.equal(parseLeadingUserMessageIdTag("no tag here"), undefined)
  assert.equal(parseLeadingUserMessageIdTag(`hello ${renderUserMessageIdTag(id)}`), undefined)
})

// ---------------------------------------------------------------------------------------------
// the smart-mode classifier's runtime state
// ---------------------------------------------------------------------------------------------

test("the development switches are inert outside development", () => {
  assert.equal(createDevSmartModeClassifierBlockState("t", false), undefined)
  assert.equal(DEV_SMART_MODE_CLASSIFIER_BLOCK_REASON.length > 0, true)
})

test("a development token arms one block and is consumed once", () => {
  const state = createDevSmartModeClassifierBlockState(" next ", true)
  assert.equal(state?.consume(), true)
  assert.equal(state?.consume(), false)
  assert.equal(createDevSmartModeClassifierBlockState("  ", true), undefined)
})

test("a one-shot state consumes once and then does nothing", async () => {
  await delayDevSmartModeClassifierIfRequested(undefined)
  await delayDevSmartModeClassifierIfRequested({ consume: () => false })
})

test("a background run never judges, and a session opts in only when both agree", () => {
  const optedIn = getSmartModeClassifierRuntimeState({
    agentType: AgentType.IDE,
    controls: { automaticModeEnabled: true },
    smartModeClassifierMode: true,
    smartModeClassifierShadowMode: false,
  })
  assert.equal(optedIn.autoModeSelected, true)
  assert.equal(optedIn.enabled, true)
  assert.equal(optedIn.shadowEnabled, false)

  const background = getSmartModeClassifierRuntimeState({
    agentType: AgentType.BACKGROUND,
    controls: { automaticModeEnabled: true },
    smartModeClassifierMode: true,
    smartModeClassifierShadowMode: true,
  })
  assert.equal(background.autoModeSelected, true)
  assert.equal(background.enabled, false)
  assert.equal(background.shadowEnabled, false)

  const shadow = getSmartModeClassifierRuntimeState({
    agentType: AgentType.IDE,
    controls: { automaticModeEnabled: false },
    smartModeClassifierMode: true,
    smartModeClassifierShadowMode: true,
  })
  assert.equal(shadow.autoModeSelected, false)
  assert.equal(shadow.enabled, false)
  assert.equal(shadow.shadowEnabled, true)
})

// ---------------------------------------------------------------------------------------------
// project conversations
// ---------------------------------------------------------------------------------------------

test("a project conversation is recognized by its mode without asking anything", async () => {
  assert.equal(await isProjectWorkspaceConversation(createContext(), { mode: SlateMode.PROJECT }), true)
  assert.equal(await isProjectWorkspaceConversation(createContext(), { mode: SlateMode.AGENT }), false)
})

// ---------------------------------------------------------------------------------------------
// multitask prompts
// ---------------------------------------------------------------------------------------------

test("starting multitasking asks for exactly one fork, and says how it recognizes itself", () => {
  const prompt = synthesizeMultitaskActionPrompt("start-self-fork", { taskToolName: "Task" })
  assert.match(prompt!, /^<system_reminder>/)
  assert.match(prompt!, /Launch one background child of this agent using the Task tool/)
  assert.match(prompt!, /runInBackground to true/)
  assert.match(prompt!, /resume to "self"/)
  assert.match(prompt!, /You are the continuation worker\. Continue the assigned task\./)
  assert.match(prompt!, /do not launch another child/i)
  assert.match(prompt!, /stop now/i)
  assert.match(synthesizeMultitaskActionPrompt("start-self-fork")!, /using your subagent tool/)
})

test("building in parallel asks for phases, not for many siblings", () => {
  const prompt = synthesizeMultitaskActionPrompt("execute-plan-in-parallel")
  assert.match(prompt!, /leave the plan file unchanged/i)
  assert.match(prompt!, /its todos already exist/i)
  assert.match(prompt!, /mark the first item in progress/i)
  assert.match(prompt!, /do not paste the full plan into its prompt/i)
  assert.match(prompt!, /independent phases concurrently/i)
  assert.match(prompt!, /phase for testing/i)
  assert.match(prompt!, /one agent owns implementation, that agent also runs its tests/i)
  assert.match(prompt!, /keep these parallel-execution rules active until the user exits multitask mode/i)
})

test("any other reason produces no prompt", () => {
  assert.equal(synthesizeMultitaskActionPrompt(undefined), undefined)
})

// ---------------------------------------------------------------------------------------------
// attached media
// ---------------------------------------------------------------------------------------------

test("the video limits are the defaults unless the session overrides them", () => {
  assert.equal(getInlineVideoMaxBytes({}), 15 * 1024 * 1024)
  assert.equal(getInlineVideoMaxBytes({ featureFlags: { videoAttachmentInlineMaxBytes: 1 } }), 1)
  assert.equal(getSignedUrlVideoMaxBytes({}), 15 * 1024 * 1024)
  assert.equal(getSignedUrlVideoMaxBytes({ featureFlags: { videoAttachmentSignedUrlMaxBytes: 2 } }), 2)
  assert.equal(VIDEO_REVIEW_SUBAGENT_MAX_BYTES, 1024 * 1024 * 1024)
})

test("handing a file to storage outside the platform needs a privacy mode that allows it", () => {
  assert.equal(isSignedUrlStorageAllowed(PrivacyMode.NO_TRAINING), true)
  assert.equal(isSignedUrlStorageAllowed(PrivacyMode.USAGE_DATA_TRAINING_ALLOWED), true)
  assert.equal(isSignedUrlStorageAllowed(PrivacyMode.USAGE_CODEBASE_TRAINING_ALLOWED), true)
  assert.equal(isSignedUrlStorageAllowed(PrivacyMode.NO_STORAGE), false)
  assert.equal(isSignedUrlStorageAllowed(PrivacyMode.UNSPECIFIED), false)
})

// ---------------------------------------------------------------------------------------------
// attached commits
// ---------------------------------------------------------------------------------------------

test("nothing is rendered when no commit was attached", () => {
  assert.deepEqual(buildGitCommitsUserContent([]), { type: "text", text: "" })
})

test("a commit is rendered with its message and its diff", () => {
  const rendered = buildGitCommitsUserContent([
    { objectId: "abc123", subject: "Fix it", explanation: "why", patch: "+x" },
  ])
  assert.match(rendered.text, /^<git_commits>/)
  assert.match(rendered.text, /has been manually attached/)
  assert.match(rendered.text, /Commit: abc123/)
  assert.match(rendered.text, /Description:\nwhy/)
  assert.match(rendered.text, /Diff:\n\+x/)
})

test("a diff too large for its budget is cut with a notice", () => {
  const rendered = buildGitCommitsUserContent([
    { objectId: "abc", subject: "m", patch: "x".repeat(40_000) },
  ])
  assert.match(rendered.text, /\[commit diff truncated due to size/)
  assert.ok(rendered.text.length < 33_000)
})

test("several commits are separated and the plural is used", () => {
  const rendered = buildGitCommitsUserContent([
    { objectId: "a", subject: "one", patch: "" },
    { objectId: "b", subject: "two", patch: "" },
  ])
  assert.match(rendered.text, /commits have been manually attached/)
  assert.match(rendered.text, /Commit: a[\s\S]*Commit: b/)
})

// ---------------------------------------------------------------------------------------------
// the ask-question replay horizon
// ---------------------------------------------------------------------------------------------

function toolCall(toolName: string, toolCallId: string, args: Record<string, unknown>) {
  return {
    role: "assistant",
    content: [{ type: "tool-call", toolName, toolCallId, args: { unwrap: () => JSON.stringify(args) } }],
  } as never
}

test("a foreground question names itself, and an asynchronous one names its original", () => {
  const ids = collectLiveAskQuestionOriginalIds([
    toolCall("AskQuestion", "call_a", {}),
    toolCall("ask_question", "call_b", { async_original_tool_call_id: "call_original" }),
    toolCall("MultipleChoice", "call_c", {}),
    toolCall("shell", "call_d", {}),
  ])
  assert.deepEqual([...ids].sort(), ["call_a", "call_c", "call_original"])
})

test("arguments that do not parse fall back to the call's own id", () => {
  const ids = collectLiveAskQuestionOriginalIds([{
    role: "assistant",
    content: [{ type: "tool-call", toolName: "AskQuestion", toolCallId: "call_x", args: { unwrap: () => "{not json" } }],
  }])
  assert.deepEqual([...ids], ["call_x"])
})

test("only matching tool names contribute ids, with fallback and de-duplication", () => {
  const ids = collectLiveAskQuestionOriginalIds([
    toolCall("MULTIPLE_CHOICE", "call-a", { async_original_tool_call_id: "original" }),
    toolCall("multiple_choice", "original", {}),
    {
      role: "assistant",
      content: [{ type: "tool-call", toolName: "Ask-Question", toolCallId: "ignored", args: { unwrap: () => "{}" } }],
    },
    {
      role: "assistant",
      content: [{ type: "tool-call", toolName: "AskQuestion", toolCallId: "fallback", args: { unwrap: () => { throw new Error("redacted") } } }],
    },
    toolCall("AskQuestion", "call-space", { async_original_tool_call_id: "  " }),
  ] as never)

  assert.deepEqual([...ids], ["original", "fallback", "  "])
})

test("a message that is not an assistant tool call is ignored", () => {
  assert.equal(collectLiveAskQuestionOriginalIds([
    { role: "user", content: [{ type: "tool-call", toolName: "AskQuestion", toolCallId: "c" }] },
    { role: "assistant", content: "a string" },
  ]).size, 0)
})

// ---------------------------------------------------------------------------------------------
// reminders
// ---------------------------------------------------------------------------------------------

test("the reminder context counts calls per tool and keeps failure streaks per tool", () => {
  const context = buildReminderContext([
    { role: "tool", content: [{ toolName: "shell", isError: true, result: "boom" }] },
    { role: "tool", content: [{ toolName: "shell", isError: true, result: "boom again" }] },
    { role: "tool", content: [{ toolName: "read", isError: false }] },
  ], ["todo"])
  assert.equal(context.toolCallCount, 3)
  assert.equal(context.toolTypeCounters.get("shell"), 2)
  assert.equal(context.consecutiveFailures.get("shell"), 2)
  assert.equal(context.consecutiveFailures.get("read"), 0)
  assert.equal(context.currentToolName, "read")
  assert.equal(context.currentToolSuccess, true)
  assert.equal(context.currentToolError, undefined)
  assert.deepEqual(context.todos, ["todo"])
})

test("success resets only its own failure run, and the newest result drives the current status", () => {
  const context = buildReminderContext([
    { role: "tool", content: [{ toolName: "shell", isError: true, result: "first" }] },
    { role: "tool", content: [
      { toolName: "shell", isError: true, result: "second" },
      { toolName: "read", isError: true, result: "read failed" },
    ] },
    { role: "tool", content: [{ toolName: "shell", isError: false }] },
    { role: "tool", content: [{ toolName: "shell", isError: true, result: "last shell failure" }] },
    { role: "tool", content: [{ isError: true, result: "unnamed failure" }] },
  ], [])

  assert.equal(context.toolCallCount, 6)
  assert.equal(context.toolTypeCounters.get("shell"), 4)
  assert.equal(context.consecutiveFailures.get("shell"), 1)
  assert.equal(context.consecutiveFailures.get("read"), 1)
  assert.equal(context.toolTypeCounters.get("unknown"), 1)
  assert.equal(context.currentToolName, "unknown")
  assert.equal(context.currentToolSuccess, false)
  assert.equal(context.currentToolError?.message, "unnamed failure")
})

test("a failure's message becomes the current error", () => {
  const context = buildReminderContext([
    { role: "tool", content: [{ toolName: "shell", isError: true, result: "it broke" }] },
  ], [])
  assert.equal(context.currentToolError?.message, "it broke")
})

test("a reminder that triggers is appended to the last tool result", async () => {
  const responseMessages = [
    { role: "assistant", content: "thinking" },
    { role: "tool", content: [{ type: "tool-result", toolName: "shell", experimental_content: [] }] },
  ]
  await applyRemindersToToolResults(
    responseMessages as never,
    [
      { shouldTrigger: () => true, generate: () => "remember the todos" },
      { shouldTrigger: () => true, generate: () => "and the plan" },
      { shouldTrigger: () => false, generate: () => "never" },
    ],
    [],
    responseMessages as never,
  )
  const content = (responseMessages[1]!.content as Array<{ experimental_content: Array<{ text: string }> }>)[0]!
  assert.deepEqual(content.experimental_content, [{ type: "text", text: "remember the todos\n\nand the plan" }])
})

test("the last tool result is the only attachment target, even when it cannot accept the text", async () => {
  const earlier = { type: "tool-result", experimental_content: [{ type: "text", text: "first" }] }
  const latest: { type: string; experimental_content?: Array<{ type: string; text: string }> } = { type: "tool-result" }
  const responseMessages = [
    { role: "tool", content: [earlier] },
    { role: "assistant", content: "between" },
    { role: "tool", content: [latest] },
  ]
  await applyRemindersToToolResults(
    responseMessages as never,
    [{ shouldTrigger: () => true, generate: () => "attach here" }],
    [],
    [],
  )
  assert.deepEqual(earlier.experimental_content, [{ type: "text", text: "first" }])
  assert.equal(latest.experimental_content, undefined)
})

test("nothing is appended when no reminder triggers, or none exists", async () => {
  const responseMessages = [{ role: "tool", content: [{ type: "tool-result", experimental_content: [] }] }]
  await applyRemindersToToolResults(responseMessages as never, [], [], responseMessages as never)
  await applyRemindersToToolResults(
    responseMessages as never,
    [{ shouldTrigger: () => false, generate: () => "no" }],
    [],
    responseMessages as never,
  )
  const content = (responseMessages[0]!.content as Array<{ experimental_content: unknown[] }>)[0]!
  assert.equal(content.experimental_content.length, 0)
})

test("a reminder with no text, and a message list with no tool result, are both no-ops", async () => {
  const responseMessages = [{ role: "tool", content: [{ type: "tool-result", experimental_content: [] }] }]
  await applyRemindersToToolResults(
    responseMessages as never,
    [{ shouldTrigger: () => true, generate: () => undefined }],
    [],
    responseMessages as never,
  )
  const content = (responseMessages[0]!.content as Array<{ experimental_content: unknown[] }>)[0]!
  assert.equal(content.experimental_content.length, 0)

  await applyRemindersToToolResults(
    [{ role: "assistant", content: "no tool result here" }] as never,
    [{ shouldTrigger: () => true, generate: () => "text" }],
    [],
    [],
  )
})
