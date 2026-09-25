import { test } from "node:test"
import assert from "node:assert/strict"

import { appendNonMediaSelectedContextContent } from "../../source/packages/agent/context/non-media-assembly.ts"
import { SimulatedMsgReason } from "../../source/packages/proto/generated/agent/v1/agent_pb.ts"
import {
  SelectedAgenticGitAction,
  SelectedAgenticGitActionPushParams,
  SelectedContext,
  SelectedGitDiff,
  SelectedGitPRDiffSelection,
  SelectedPullRequest,
  SelectedConsoleLog,
  SelectedBrowser,
  SelectedUIElement,
  SelectedSubagent,
} from "../../source/packages/proto/generated/agent/v1/selected_context_pb.ts"

// ---------------------------------------------------------------------------------------------
// the order the turn's attachments are written in
// ---------------------------------------------------------------------------------------------

interface TextPart {
  readonly type: "text"
  readonly text: string
}

function append(selectedContext: SelectedContext, options: {
  pullRequests?: readonly SelectedPullRequest[]
  prDiffSelections?: readonly SelectedGitPRDiffSelection[]
  extraContexts?: readonly string[]
  simulatedMsgReason?: number
  modelInfo?: { promptVersion: string }
  isComposerMatterhorn?: boolean
  isRawTrainingSlug?: boolean
  environmentParamForSubagent?: boolean
  babysitV2Prompt?: boolean
  enablePrCreationForgeGuidance?: boolean
} = {}): TextPart[] {
  const userContent: TextPart[] = []
  appendNonMediaSelectedContextContent({
    userContent,
    selectedContext,
    hydratedSelectedPullRequests: options.pullRequests ?? [],
    hydratedGitPrDiffSelections: options.prDiffSelections ?? [],
    extraContextsToInclude: options.extraContexts ?? [],
    isComposerMatterhorn: options.isComposerMatterhorn ?? false,
    isRawTrainingSlug: options.isRawTrainingSlug ?? false,
    simulatedMsgReason: (options.simulatedMsgReason ?? SimulatedMsgReason.UNSPECIFIED) as never,
    ...(options.modelInfo === undefined ? {} : { modelInfo: options.modelInfo as never }),
    environmentParamForSubagent: options.environmentParamForSubagent ?? false,
    babysitV2Prompt: options.babysitV2Prompt ?? false,
    enablePrCreationForgeGuidance: options.enablePrCreationForgeGuidance ?? false,
  })
  return userContent
}

const joined = (parts: TextPart[]): string => parts.map(part => part.text).join("\n---\n")

test("an empty context contributes nothing at all", () => {
  assert.deepEqual(append(new SelectedContext({})), [])
})

test("an attached diff is written before the ambient context", () => {
  const context = new SelectedContext({
    gitDiff: new SelectedGitDiff({ content: "diff --git a/a.ts b/a.ts" }),
    consoleLogs: [new SelectedConsoleLog({ message: "a console line" })],
  })
  const parts = append(context)
  assert.equal(parts.length, 2)
  assert.match(parts[0]?.text ?? "", /diff --git a\/a\.ts/)
  assert.match(parts[1]?.text ?? "", /a console line/)
})

test("a diff against the base branch and a commit list are each written when attached", () => {
  const context = new SelectedContext({
    gitDiffFromBranchToMain: new SelectedGitDiff({ content: "the branch diff" }),
    gitCommits: [{ commitHash: "abc", message: "a commit" } as never],
  })
  const parts = append(context)
  assert.equal(parts.length, 2)
  assert.match(joined(parts), /the branch diff/)
  assert.match(joined(parts), /a commit/)
})

test("the pieces appear in the order they are read: commands, diffs, commits, pull requests", () => {
  const context = new SelectedContext({
    gitDiff: new SelectedGitDiff({ content: "the working diff" }),
    gitCommits: [{ commitHash: "abc", message: "a commit" } as never],
  })
  const parts = append(context, {
    pullRequests: [new SelectedPullRequest({ number: 7, title: "a pull request" })],
  })
  const order = parts.map(part => part.text)
  const indexOf = (needle: string) => order.findIndex(text => text.includes(needle))
  assert.equal(indexOf("the working diff") < indexOf("a commit"), true)
  assert.equal(indexOf("a commit") < indexOf("a pull request"), true)
})

test("a pull request is only written when the caller hydrated one", () => {
  const context = new SelectedContext({})
  assert.deepEqual(append(context), [])
  assert.equal(append(context, { pullRequests: [new SelectedPullRequest({ number: 7 })] }).length, 1)
})

test("the ambient context is written only for what was attached", () => {
  const context = new SelectedContext({
    consoleLogs: [new SelectedConsoleLog({ message: "a console line" })],
    uiElements: [new SelectedUIElement({ xpath: "/html/body/div" })],
    selectedBrowsers: [new SelectedBrowser({ browserId: "browser-1", url: "https://example.test" })],
    selectedSubagents: [new SelectedSubagent({ name: "explore" })],
  })
  const parts = append(context)
  assert.equal(parts.length, 4)
  assert.equal(parts.every(part => part.type === "text"), true)
})

test("a review in progress is written from the hydrated diff selections", () => {
  const context = new SelectedContext({})
  const parts = append(context, { prDiffSelections: [new SelectedGitPRDiffSelection({ prUrl: "https://example.test/pr/7", filePath: "src/a.ts" })] })
  assert.equal(parts.length, 1)
})

test("the instructions for a wake-up come after the context they refer to", () => {
  const context = new SelectedContext({
    consoleLogs: [new SelectedConsoleLog({ message: "a console line" })],
    selectedAgenticGitAction: new SelectedAgenticGitAction({
      params: { case: "createPrParams", value: new SelectedAgenticGitActionPushParams({}) },
    }),
  })
  const parts = append(context, { simulatedMsgReason: SimulatedMsgReason.DIFF_TAB_CREATE_PR })
  assert.equal(parts.length, 2)
  assert.match(parts[0]?.text ?? "", /a console line/)
  assert.match(parts[1]?.text ?? "", /^Push this branch to remote and create a pull request\./)
})

test("extra context gathered for the turn is written last", () => {
  const context = new SelectedContext({ consoleLogs: [new SelectedConsoleLog({ message: "a console line" })] })
  const parts = append(context, { extraContexts: ["something the caller collected", "and another"] })
  assert.equal(parts.length, 3)
  assert.deepEqual(parts.slice(1).map(part => part.text), ["something the caller collected", "and another"])
})

test("a wake-up with nothing to say adds no empty part", () => {
  const parts = append(new SelectedContext({}), { simulatedMsgReason: SimulatedMsgReason.MULTITASK_SPLIT_PRS })
  assert.deepEqual(parts, [])
})

test("the flags a session sets reach the instruction that uses them", () => {
  const context = new SelectedContext({
    selectedAgenticGitAction: new SelectedAgenticGitAction({
      params: { case: "createPrParams", value: new SelectedAgenticGitActionPushParams({}) },
    }),
  })
  const without = append(context, { simulatedMsgReason: SimulatedMsgReason.DIFF_TAB_CREATE_PR })
  const with_ = append(context, {
    simulatedMsgReason: SimulatedMsgReason.DIFF_TAB_CREATE_PR,
    enablePrCreationForgeGuidance: true,
  })
  assert.notEqual(without[0]?.text, with_[0]?.text)
})

test("the recent-agents section is shaped by the session's model flags", () => {
  const context = new SelectedContext({
    recentAgentsContext: { recentAgents: [{ name: "earlier work", path: "/repo/.slate/transcripts/agent-1.txt", overview: "what it did" }] },
  })
  const parts = append(context)
  assert.equal(parts.length, 1)
  assert.match(parts[0]?.text ?? "", /earlier work/)
  assert.match(parts[0]?.text ?? "", /transcript_path: \/repo\/\.slate\/transcripts\/agent-1\.txt/)

  // The two flags together are the one combination that drops the section entirely.
  assert.deepEqual(append(context, { isComposerMatterhorn: true, isRawTrainingSlug: true }), [])
})
