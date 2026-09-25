import { test } from "node:test"
import assert from "node:assert/strict"

import { collectAllSkillBlocks } from "../../source/packages/agent-summarization/skill-persistence.ts"
import { prepareMessagesForCompaction } from "../../source/packages/agent-summarization/prepare-messages.ts"
import {
  BackgroundSummarizationMode,
  DISABLED_BACKGROUND_SUMMARIZATION_PROPS,
  getBackgroundSummarizationTriggerThreshold,
  shouldPersistBackgroundSummarization,
  shouldStartBackgroundSummarization,
  type BackgroundSummarizationProps,
} from "../../source/packages/agent-summarization/background-summarization.ts"
import { estimateTokenCount, type TokenEstimateMessage } from "../../source/packages/agent-summarization/token-estimate.ts"
import { runSummarizationPipeline, type SummarizationPipelineAdapter } from "../../source/packages/agent-summarization/pipeline.ts"
import { createContext, type Context } from "../../source/packages/context/context.ts"
import { PrivacyMode } from "../../source/packages/redaction/privacy-mode.ts"
import { toRedactedCoreMessage, type CoreMessageLike } from "../../source/packages/redaction/message-redaction.ts"
import { createRedactedString } from "../../source/packages/redaction/create.ts"
import { DataClassification } from "../../source/packages/redaction/classification.ts"

// ---------------------------------------------------------------------------------------------
// the messages a compaction is given
// ---------------------------------------------------------------------------------------------

const redacted = (message: CoreMessageLike) => toRedactedCoreMessage(message, PrivacyMode.NO_STORAGE)

const textMessage = (role: string, text: string) => redacted({ role, content: text })
const partsMessage = (role: string, parts: Array<Record<string, unknown>>) => redacted({ role, content: parts })
const summaryMessage = (text: string) => redacted({ role: "user", content: text, providerOptions: { cursor: { isSummary: true } } })

test("the instructions are kept out of a compaction and the conversation is not", () => {
  const system = textMessage("system", "you are an agent")
  const userInfo = partsMessage("user", [{ type: "text", text: "<user_info>\nthe environment\n</user_info>" }])
  const first = textMessage("user", "do the thing")
  const answer = textMessage("assistant", "done")
  const { systemMessage, userInfoMessage, messagesForSummarization } = prepareMessagesForCompaction([system, userInfo, first, answer])

  assert.equal(systemMessage, system)
  assert.equal(userInfoMessage, userInfo)
  assert.deepEqual(messagesForSummarization, [first, answer])
})

test("a user-info message is only taken out when it is the pair the platform writes", () => {
  // The tag alone is not enough: it has to be the message directly after the system message.
  const first = textMessage("user", "do the thing")
  const withTag = partsMessage("user", [{ type: "text", text: "<user_info>the environment</user_info>" }])
  const { userInfoMessage, messagesForSummarization } = prepareMessagesForCompaction([first, withTag])
  assert.equal(userInfoMessage, undefined)
  assert.deepEqual(messagesForSummarization, [first, withTag])

  // And a single user message cannot be the pair either.
  const alone = prepareMessagesForCompaction([withTag])
  assert.equal(alone.userInfoMessage, undefined)
  assert.deepEqual(alone.messagesForSummarization, [withTag])
})

test("an assistant message with nothing in it is not worth summarizing", () => {
  const empty = textMessage("assistant", "")
  const partsEmpty = partsMessage("assistant", [])
  const real = textMessage("assistant", "an answer")
  const { messagesForSummarization } = prepareMessagesForCompaction([empty, partsEmpty, real])
  assert.deepEqual(messagesForSummarization, [real])
})

test("a conversation with no system message is compacted as it is", () => {
  const first = textMessage("user", "do the thing")
  const { systemMessage, userInfoMessage, messagesForSummarization } = prepareMessagesForCompaction([first])
  assert.equal(systemMessage, undefined)
  assert.equal(userInfoMessage, undefined)
  assert.deepEqual(messagesForSummarization, [first])
})

// ---------------------------------------------------------------------------------------------
// the skills that have to survive a compaction
// ---------------------------------------------------------------------------------------------

test("the skills attached by hand are taken from the most recent real user message", () => {
  const withSkills = textMessage("user", "before\n<manually_attached_skills>\nthe skill\n</manually_attached_skills>\nafter")
  const later = textMessage("user", "a later message with no skills")
  const blocks = collectAllSkillBlocks([withSkills, later])
  assert.deepEqual(blocks, [])
})

test("a user message that carries skills hands them over verbatim", () => {
  const withSkills = textMessage("user", "<manually_attached_skills>\nthe skill body\n</manually_attached_skills>")
  assert.deepEqual(collectAllSkillBlocks([withSkills]), ["<manually_attached_skills>\nthe skill body\n</manually_attached_skills>"])
})

test("a summary is not where skills are looked for", () => {
  const summaryWithSkills = summaryMessage("<manually_attached_skills>\nthe skill\n</manually_attached_skills>")
  const withSkills = textMessage("user", "<manually_attached_skills>\nthe real skill\n</manually_attached_skills>")
  const blocks = collectAllSkillBlocks([withSkills, summaryWithSkills])
  assert.deepEqual(blocks, ["<manually_attached_skills>\nthe real skill\n</manually_attached_skills>"])
})

test("several skill blocks in one message are all kept", () => {
  const message = textMessage("user", [
    "<manually_attached_skills>\none\n</manually_attached_skills>",
    "<manually_attached_skills>\ntwo\n</manually_attached_skills>",
  ].join("\n"))
  assert.equal(collectAllSkillBlocks([message]).length, 2)
})

test("a message with no skills at all contributes none", () => {
  assert.deepEqual(collectAllSkillBlocks([textMessage("user", "nothing attached")]), [])
  assert.deepEqual(collectAllSkillBlocks([]), [])
})

// ---------------------------------------------------------------------------------------------
// when a compaction is started, and when its result is kept
// ---------------------------------------------------------------------------------------------

test("the trigger is the first threshold reached, of the two a session may set", () => {
  const both: BackgroundSummarizationProps = {
    unusedTokensThresholdToStartBackgroundSummarization: 10_000,
    unusedPercentTokensThresholdToStartBackgroundSummarization: 0.2,
  }
  // 100k window: the absolute threshold leaves 90k, the fraction leaves 80k, and the earlier one wins.
  assert.equal(getBackgroundSummarizationTriggerThreshold(100_000, both), 80_000)

  const absoluteOnly: BackgroundSummarizationProps = { unusedTokensThresholdToStartBackgroundSummarization: 10_000 }
  assert.equal(getBackgroundSummarizationTriggerThreshold(100_000, absoluteOnly), 90_000)

  const percentOnly: BackgroundSummarizationProps = { unusedPercentTokensThresholdToStartBackgroundSummarization: 0.25 }
  assert.equal(getBackgroundSummarizationTriggerThreshold(100_000, percentOnly), 75_000)
})

test("a session with no thresholds never starts one, and neither does an empty window", () => {
  assert.equal(getBackgroundSummarizationTriggerThreshold(100_000, DISABLED_BACKGROUND_SUMMARIZATION_PROPS), undefined)
  assert.equal(shouldStartBackgroundSummarization(99_999, 100_000, DISABLED_BACKGROUND_SUMMARIZATION_PROPS), false)
  assert.equal(getBackgroundSummarizationTriggerThreshold(0, { unusedTokensThresholdToStartBackgroundSummarization: 1 }), undefined)
})

test("a conversation past the threshold starts one and one below it does not", () => {
  const props: BackgroundSummarizationProps = { unusedTokensThresholdToStartBackgroundSummarization: 10_000 }
  assert.equal(shouldStartBackgroundSummarization(90_000, 100_000, props), true)
  assert.equal(shouldStartBackgroundSummarization(89_999, 100_000, props), false)
})

test("a finished summary is only kept when the room left is small enough", () => {
  const props: BackgroundSummarizationProps = {
    unusedTokensThresholdToStartBackgroundSummarization: 10_000,
    unusedTokensThresholdToPersistBackgroundSummarization: 2_000,
  }
  // Past the trigger, with little room left: the summary is kept.
  assert.equal(shouldPersistBackgroundSummarization(99_000, 100_000, props), true)
  // Past the trigger but with room to spare: it is discarded and written again later.
  assert.equal(shouldPersistBackgroundSummarization(95_000, 100_000, props), false)
  // Before the trigger it was never started, so there is nothing to keep.
  assert.equal(shouldPersistBackgroundSummarization(50_000, 100_000, props), false)
})

test("a fraction decides the same question the same way", () => {
  const props: BackgroundSummarizationProps = {
    unusedPercentTokensThresholdToStartBackgroundSummarization: 0.1,
    unusedPercentTokensThresholdToPersistBackgroundSummarization: 0.02,
  }
  assert.equal(shouldPersistBackgroundSummarization(99_000, 100_000, props), true)
  assert.equal(shouldPersistBackgroundSummarization(95_000, 100_000, props), false)
})

test("the modes a session can ask for are named for what they do", () => {
  assert.deepEqual(Object.values(BackgroundSummarizationMode), [
    "Background",
    "BackgroundAndPersistIfCompleted",
    "WaitForCompletion",
    "WaitForCompletionIfStarted",
  ])
})

// ---------------------------------------------------------------------------------------------
// how big a conversation is
// ---------------------------------------------------------------------------------------------

test("a conversation's size is estimated from its characters, with room for the structure", () => {
  const messages: TokenEstimateMessage[] = [{ role: "user", content: "x".repeat(100) }]
  // 100 characters plus the per-message overhead, divided by the characters-per-token estimate.
  assert.equal(estimateTokenCount(messages), Math.ceil((100 + 25) / 2.5))
})

test("the estimate is a ceiling, so a short conversation is never counted as nothing", () => {
  assert.equal(estimateTokenCount([{ role: "user", content: "x" }]), Math.ceil((1 + 25) / 2.5))
  assert.equal(estimateTokenCount([]), 0)
})

test("only the text of a message counts unless the caller asks for everything", () => {
  const messages: TokenEstimateMessage[] = [{
    role: "assistant",
    content: [
      { type: "text", text: "x".repeat(10) },
      { type: "tool-call", args: "y".repeat(100) },
      { type: "tool-result", result: "z".repeat(200) },
    ],
  }]
  const textOnly = estimateTokenCount(messages)
  const everything = estimateTokenCount(messages, { includeNonTextContent: true })
  assert.equal(textOnly, Math.ceil((10 + 25) / 2.5))
  // The tool parts count with their own overhead.
  assert.equal(everything, Math.ceil((10 + 100 + 50 + 200 + 50 + 25) / 2.5))
})

test("a caller that knows its own text length is not walked again", () => {
  const messages: TokenEstimateMessage[] = [{ role: "user", content: "x".repeat(100) }]
  const withCustomLength = estimateTokenCount(messages, { textContentLengthFn: () => 1_000 })
  assert.equal(withCustomLength, Math.ceil((1_000 + 25) / 2.5))
})

test("a redacted string is counted by its length rather than by its wrapper", () => {
  const redactedContent = createRedactedString("x".repeat(100), DataClassification.CODE, "text", PrivacyMode.NO_STORAGE)
  const messages = [{ role: "user", content: redactedContent }] as unknown as TokenEstimateMessage[]
  assert.equal(estimateTokenCount(messages), Math.ceil((100 + 25) / 2.5))
})

test("a message whose content is neither text nor parts still costs its overhead", () => {
  assert.equal(estimateTokenCount([{ role: "user", content: 42 }]), Math.ceil(25 / 2.5))
})

// ---------------------------------------------------------------------------------------------
// the order a compaction happens in
// ---------------------------------------------------------------------------------------------

interface PipelineMessage {
  readonly role: string
  readonly text?: string
  /** The pipeline's message type carries whatever the caller's own messages do. */
  readonly [key: string]: unknown
}

function pipelineAdapter(options: { tail?: PipelineMessage[]; failGenerate?: boolean } = {}): {
  readonly calls: string[]
  readonly adapter: SummarizationPipelineAdapter<PipelineMessage, string, PipelineMessage>
} {
  const calls: string[] = []
  const tail = options.tail ?? []
  return {
    calls,
    adapter: {
      partitionMessages(messages) {
        calls.push("partition")
        const tailLength = Math.min(tail.length, messages.length)
        return {
          messagesToSummarize: messages.slice(0, messages.length - tailLength),
          preservedTailMessages: tailLength === 0 ? [] : messages.slice(messages.length - tailLength),
          skillBlocks: ["<manually_attached_skills>the skill</manually_attached_skills>"],
        }
      },
      generateSummary() {
        calls.push("generate")
        if (options.failGenerate === true) throw new Error("the summarizer is gone")
        return "the summary"
      },
      buildSummaryMessage(rawSummary, _partitioned, enrichments) {
        calls.push("build")
        return { message: { role: "user", text: rawSummary }, summaryTextLength: rawSummary.length + enrichments.skillBlocks.length }
      },
      assembleFinalMessages(partitioned, message) {
        calls.push("assemble")
        return [message, ...partitioned.preservedTailMessages]
      },
    },
  }
}

test("a compaction splits, summarizes, builds and reassembles, in that order", async () => {
  const { adapter, calls } = pipelineAdapter()
  const messages: PipelineMessage[] = [{ role: "user", text: "one" }, { role: "assistant", text: "two" }]
  const result = await runSummarizationPipeline(adapter, createContext(), messages, { todoContent: "the todos" })

  assert.deepEqual(calls, ["partition", "generate", "build", "assemble"])
  assert.deepEqual(result.messagesActuallySummarized, messages)
  assert.equal(result.rawSummary, "the summary")
  assert.deepEqual(result.newSummaryMessage, { role: "user", text: "the summary" })
  assert.equal(result.summaryTextLength, "the summary".length + 1)
  // The final messages are the summary followed by whatever was preserved.
  assert.deepEqual(result.fullReplacementMessages, [{ role: "user", text: "the summary" }])
  assert.deepEqual(result.preservedOriginalTailMessages, [])
})

test("what was preserved beside the summary is handed back as it was", async () => {
  const { adapter } = pipelineAdapter({ tail: [{ role: "user", text: "the latest question" }] })
  const messages: PipelineMessage[] = [{ role: "user", text: "one" }, { role: "user", text: "the latest question" }]
  const result = await runSummarizationPipeline(adapter, createContext(), messages, {})
  assert.deepEqual(result.messagesActuallySummarized, [messages[0]])
  assert.deepEqual(result.preservedOriginalTailMessages, [messages[1]])
  assert.deepEqual(result.fullReplacementMessages, [{ role: "user", text: "the summary" }, messages[1]])
})

test("the parts of the conversation a summary has to carry reach the builder", async () => {
  const seen: unknown[] = []
  const { adapter } = pipelineAdapter()
  const capturing: SummarizationPipelineAdapter<PipelineMessage, string, PipelineMessage> = {
    ...adapter,
    buildSummaryMessage(rawSummary, partitioned, enrichments) {
      seen.push(enrichments)
      return { message: { role: "user", text: rawSummary }, summaryTextLength: 1 }
    },
  }
  await runSummarizationPipeline(capturing, createContext(), [{ role: "user", text: "one" }], {
    todoContent: "the todos",
    currentPlan: "the plan",
    modePrompt: "the mode",
    projectRootPrompt: "the root prompt",
    automationTriggerContext: "the trigger",
    agentTranscriptsFolder: "/repo/.slate/transcripts",
    conversationId: "conversation-1",
  })
  assert.deepEqual(seen[0], {
    skillBlocks: ["<manually_attached_skills>the skill</manually_attached_skills>"],
    todoContent: "the todos",
    currentPlan: "the plan",
    modePrompt: "the mode",
    projectRootPrompt: "the root prompt",
    automationTriggerContext: "the trigger",
    agentTranscriptsFolder: "/repo/.slate/transcripts",
    conversationId: "conversation-1",
  })
})

test("a summarizer that fails fails the compaction rather than producing an empty one", async () => {
  const { adapter } = pipelineAdapter({ failGenerate: true })
  await assert.rejects(
    () => runSummarizationPipeline(adapter, createContext(), [{ role: "user", text: "one" }], {}),
    /the summarizer is gone/,
  )
})

test("a tail that does not read as a conversation is reported rather than repaired", async () => {
  // A tail with two user turns means the split landed inside a turn.
  const { adapter } = pipelineAdapter({ tail: [{ role: "user" }, { role: "user" }] })
  const result = await runSummarizationPipeline(adapter, createContext(), [
    { role: "user", text: "one" },
    { role: "user", text: "two" },
    { role: "user", text: "three" },
  ], { fullSummarization: true })
  // The pipeline still completes; the shape is logged for the caller to act on.
  assert.equal(result.fullReplacementMessages.length >= 1, true)
})

test("a tail that is only a user message is the shape the invariant wants", async () => {
  const { adapter } = pipelineAdapter({ tail: [{ role: "user", text: "the latest" }] })
  const result = await runSummarizationPipeline(adapter, createContext(), [
    { role: "assistant", text: "one" },
    { role: "user", text: "the latest" },
  ], {})
  assert.deepEqual(result.preservedOriginalTailMessages, [{ role: "user", text: "the latest" }])
})
