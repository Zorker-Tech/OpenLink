import { test } from "node:test"
import assert from "node:assert/strict"

import {
  appendDurableBlocks,
  prependDurableBlocks,
  renderDurableBlocks,
  type DurableBlockEnrichments,
  type DurableBlockSummarizer,
  type DurablePlan,
} from "../../source/packages/agent-summarization/durable-blocks.ts"
import { PrivacyCapability } from "../../source/packages/redaction/classification.ts"

// ---------------------------------------------------------------------------------------------
// the harness
// ---------------------------------------------------------------------------------------------

const plan = (content: string, options: { name?: string; composerId?: string } = {}): DurablePlan => ({
  content: { unwrap: () => content },
  ...(options.name === undefined ? {} : { name: options.name }),
  ...(options.composerId === undefined ? {} : { composerId: options.composerId }),
})

const enrichments = (overrides: Partial<DurableBlockEnrichments> = {}): DurableBlockEnrichments => ({
  skillBlocks: [],
  ...overrides,
})

const blockIdsOf = (summarizer: DurableBlockSummarizer, enrich: DurableBlockEnrichments) =>
  [...renderDurableBlocks(summarizer, enrich).keys()]

// ---------------------------------------------------------------------------------------------
// what a summary would lose
// ---------------------------------------------------------------------------------------------

test("a session with nothing to carry carries nothing", () => {
  for (const summarizer of ["external", "self-summary", "openai-compaction", "anthropic-compaction", "xai-compaction"] as const) {
    assert.deepEqual(renderDurableBlocks(summarizer, enrichments()), new Map(), summarizer)
    assert.equal(prependDurableBlocks(summarizer, new Map()), "")
    assert.equal(appendDurableBlocks(summarizer, new Map()), "")
  }
})

test("the mode and the project root go in front of the summary", () => {
  const enrich = enrichments({ modePrompt: "the mode", projectRootPrompt: "the root" })
  for (const summarizer of ["self-summary", "openai-compaction", "anthropic-compaction"] as const) {
    assert.deepEqual([...renderDurableBlocks(summarizer, enrich).keys()], ["mode-prompt", "project-root"], summarizer)
    assert.equal(prependDurableBlocks(summarizer, renderDurableBlocks(summarizer, enrich)), "the mode\n\nthe root\n\n")
  }
})

test("a summarizer that keeps no leading blocks puts everything after the summary", () => {
  const enrich = enrichments({ modePrompt: "the mode", projectRootPrompt: "the root" })
  for (const summarizer of ["external", "xai-compaction"] as const) {
    assert.equal(prependDurableBlocks(summarizer, renderDurableBlocks(summarizer, enrich)), "")
    assert.match(appendDurableBlocks(summarizer, renderDurableBlocks(summarizer, enrich)), /the mode/)
  }
})

test("a todo list is carried with the note that explains it", () => {
  const enrich = enrichments({ todoContent: "- pending: one" })
  const appended = appendDurableBlocks("self-summary", renderDurableBlocks("self-summary", enrich))
  assert.match(appended, /NOTE: There was an active todo list in the conversation/)
  assert.match(appended, /<todo_update>\n- pending: one\n<\/todo_update>/)
})

test("skills are carried one after another", () => {
  const enrich = enrichments({ skillBlocks: ["skill one", "skill two"] })
  const appended = appendDurableBlocks("self-summary", renderDurableBlocks("self-summary", enrich))
  assert.match(appended, /skill one\n\nskill two/)
})

test("the transcript is carried unless the caller says otherwise", () => {
  const enrich = enrichments({ agentTranscriptsFolder: "/repo/transcripts", conversationId: "conversation-1" })
  assert.deepEqual(blockIdsOf("self-summary", enrich), ["transcript"])
  assert.deepEqual(renderDurableBlocks("self-summary", enrich, { includeTranscript: false }), new Map())
})

test("the transcript is written in the shape the summarizer reads", () => {
  const enrich = enrichments({ agentTranscriptsFolder: "/repo/transcripts", conversationId: "conversation-1" })
  const tagged = appendDurableBlocks("self-summary", renderDurableBlocks("self-summary", enrich))
  assert.match(tagged, /<transcript_location>/)
  const markdown = appendDurableBlocks("external", renderDurableBlocks("external", enrich))
  assert.match(markdown, /### Transcript location:/)
  assert.equal(markdown.includes("<transcript_location>"), false)
})

test("the transcript block does not carry a second blank line of its own", () => {
  const enrich = enrichments({ agentTranscriptsFolder: "/repo/transcripts", conversationId: "conversation-1" })
  const appended = appendDurableBlocks("self-summary", renderDurableBlocks("self-summary", enrich))
  assert.equal(appended.startsWith("\n\n<transcript_location>"), true)
  assert.equal(appended.startsWith("\n\n\n"), false)
})

// ---------------------------------------------------------------------------------------------
// the plan
// ---------------------------------------------------------------------------------------------

test("the plan is carried as a file the model can read", () => {
  const enrich = enrichments({ currentPlan: plan("the plan body", { name: "my-plan", composerId: "composer-1" }) })
  const appended = appendDurableBlocks("external", renderDurableBlocks("external", enrich))
  assert.match(appended, /10\. Current plan mode progress:/)
  assert.match(appended, /<file_contents path="cursor-plan:\/\/composer-1\/my-plan\.plan\.md" isFullFile="true">\nthe plan body\n<\/file_contents>/)
})

test("a plan with no name is the plan, and one already named as a plan file is not named twice", () => {
  const unnamed = appendDurableBlocks("external", renderDurableBlocks("external", enrichments({ currentPlan: plan("body") })))
  assert.match(unnamed, /cursor-plan:\/\/\/plan\.plan\.md/)
  const named = appendDurableBlocks("external", renderDurableBlocks("external", enrichments({ currentPlan: plan("body", { name: "already.plan.md" }) })))
  assert.match(named, /cursor-plan:\/\/\/already\.plan\.md/)
})

test("a plan with nothing in it is not carried", () => {
  assert.deepEqual(renderDurableBlocks("external", enrichments({ currentPlan: plan("   ") })), new Map())
  assert.deepEqual(renderDurableBlocks("external", enrichments({ currentPlan: null })), new Map())
})

test("a summarizer that does not carry the plan is not given it", () => {
  // The platform's own summarizer keeps the plan out of its trailing blocks, so it is not rendered at all.
  assert.deepEqual(renderDurableBlocks("self-summary", enrichments({ currentPlan: plan("the plan body") })), new Map())
})

test("a plan is unwrapped as content the platform may keep", () => {
  const asked: PrivacyCapability[] = []
  const recording: DurablePlan = { content: { unwrap: (purpose) => { asked.push(purpose); return "body" } } }
  renderDurableBlocks("external", enrichments({ currentPlan: recording }))
  assert.deepEqual(asked, [PrivacyCapability.UNSAFE_ALWAYS_ALLOWED])
})

test("one compactor wants the plan as a plan of its own", () => {
  const enrich = enrichments({ currentPlan: plan("the plan body", { composerId: "composer-1" }) })
  const appended = appendDurableBlocks("xai-compaction", renderDurableBlocks("xai-compaction", enrich))
  assert.match(appended, /<current_plan>\nthe plan body\n<\/current_plan>/)
  assert.equal(appended.includes("file_contents"), false)
})

// ---------------------------------------------------------------------------------------------
// the automation trigger
// ---------------------------------------------------------------------------------------------

test("an automation run is carried with the trigger that started it", () => {
  const enrich = enrichments({ automationTriggerContext: "the cron that fired" })
  assert.match(appendDurableBlocks("self-summary", renderDurableBlocks("self-summary", enrich)), /NOTE: This is an automation run\. The original trigger info that started this session:\nthe cron that fired/)
  assert.match(appendDurableBlocks("external", renderDurableBlocks("external", enrich)), /12\. Automation trigger info \(this is the original trigger that started this agent\):\n\nthe cron that fired/)
  // One compactor takes it as it stands.
  assert.match(appendDurableBlocks("xai-compaction", renderDurableBlocks("xai-compaction", enrich)), /^the cron that fired$|the cron that fired/)
})

// ---------------------------------------------------------------------------------------------
// placing the blocks
// ---------------------------------------------------------------------------------------------

test("a block is placed once even when a summarizer lists it twice", () => {
  const enrich = enrichments({ modePrompt: "the mode", projectRootPrompt: "the root" })
  const blocks = renderDurableBlocks("self-summary", enrich)
  const appended = appendDurableBlocks("self-summary", blocks)
  // The mode and the root are leading blocks, so they are not repeated after the summary.
  assert.equal(appended.includes("the mode"), false)
})

test("the blocks after the summary follow that summarizer's order", () => {
  const enrich = enrichments({ agentTranscriptsFolder: "/repo/t", conversationId: "c1", todoContent: "todos", skillBlocks: ["skill"] })
  const selfSummary = appendDurableBlocks("self-summary", renderDurableBlocks("self-summary", enrich))
  const openai = appendDurableBlocks("openai-compaction", renderDurableBlocks("openai-compaction", enrich))
  // The transcript comes first for one and last for the other.
  assert.equal(selfSummary.indexOf("transcript_location") < selfSummary.indexOf("todo_update"), true)
  assert.equal(openai.indexOf("transcript_location") > openai.indexOf("todo_update"), true)
})

test("the blocks that are placed are exactly the ones that were rendered", () => {
  const enrich = enrichments({ modePrompt: "the mode", todoContent: "todos" })
  const blocks = renderDurableBlocks("self-summary", enrich)
  assert.deepEqual([...blocks.keys()], ["mode-prompt", "todos"])
  const whole = `${prependDurableBlocks("self-summary", blocks)}SUMMARY${appendDurableBlocks("self-summary", blocks)}`
  assert.match(whole, /^the mode\n\nSUMMARY/)
  assert.match(whole, /SUMMARY\n\nNOTE: There was an active todo list/)
})
