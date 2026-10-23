import { test } from "node:test"
import assert from "node:assert/strict"

import {
  AgentConversationTurnHandle,
  ConversationStateHandle,
  ShellConversationTurnHandle,
  buildTimestampPrefix,
  renderIncomingMessageIdTag,
} from "../../source/packages/agent/state.ts"
import { createContext, type Context } from "../../source/packages/context/context.ts"
import { PrivacyMode } from "../../source/packages/redaction/privacy-mode.ts"
import { createRedactedString } from "../../source/packages/redaction/create.ts"
import { DataClassification } from "../../source/packages/redaction/classification.ts"
import {
  toRedactedConversationStateStructure,
  toRedactedShellCommand,
  toRedactedShellOutput,
} from "../../source/packages/redacted-protos/generated/agent/v1/agent_redacted.ts"
import {
  AgentMode,
  ConversationStateStructure,
  GoalState,
  PlanRegistryEntry,
  ShellCommand,
  ShellOutput,
} from "../../source/packages/proto/generated/agent/v1/agent_pb.ts"
import { TodoItem } from "../../source/packages/proto/generated/agent/v1/todo_tool_pb.ts"
import { toRedactedTodoItem } from "../../source/packages/redacted-protos/generated/agent/v1/todo_tool_redacted.ts"
import { SubagentType, SubagentTypeUnspecified } from "../../source/packages/proto/generated/agent/v1/subagents_pb.ts"
import { getBlobId } from "../../source/packages/agent-kv/blob-store.ts"

// ---------------------------------------------------------------------------------------------
// the state handle over a blob store
// ---------------------------------------------------------------------------------------------

interface Harness {
  readonly blobs: Map<string, Uint8Array>
  readonly written: string[]
  readonly handle: ConversationStateHandle
  readonly builder: {
    readonly appended: unknown[]
    appendMessages(messages: unknown | readonly unknown[]): void
    getState(): readonly unknown[]
    clearMessages(): void
  }
}

function harness(state: ConversationStateStructure = new ConversationStateStructure({})): Harness {
  const blobs = new Map<string, Uint8Array>()
  const written: string[] = []
  const keyOf = (id: Uint8Array): string => Buffer.from(id).toString("hex")
  const blobStore = {
    async getBlob(_ctx: Context, blobId: Uint8Array) { return blobs.get(keyOf(blobId)) },
    async setBlob(_ctx: Context, blobId: Uint8Array, data: Uint8Array) { written.push(keyOf(blobId)); blobs.set(keyOf(blobId), data) },
    async setBlobLocallyOnly(_ctx: Context, blobId: Uint8Array, data: Uint8Array) { written.push(keyOf(blobId)); blobs.set(keyOf(blobId), data) },
    async flush() {},
  }
  const appended: unknown[] = []
  const builder = {
    appended,
    appendMessages(messages: unknown | readonly unknown[]) {
      appended.push(...(Array.isArray(messages) ? messages : [messages]))
    },
    getState: () => appended,
    clearMessages() { appended.length = 0 },
  }
  return {
    blobs,
    written,
    builder,
    handle: new ConversationStateHandle(
      blobStore as never,
      toRedactedConversationStateStructure(state, PrivacyMode.NO_STORAGE),
      builder as never,
      {},
      "composer-2",
    ),
  }
}

const redactedPath = (value: string) => createRedactedString(value, DataClassification.PATH, "path", PrivacyMode.NO_STORAGE)
/** The state handle stores redacted values, so a caller hands it one rather than a plain message. */
const redactedShellCommand = (command: string) =>
  toRedactedShellCommand(new ShellCommand({ command }), PrivacyMode.NO_STORAGE)

// ---------------------------------------------------------------------------------------------
// the two prompt helpers
// ---------------------------------------------------------------------------------------------

test("a message id is rendered as a tag the model can be told about", () => {
  assert.equal(renderIncomingMessageIdTag(undefined), undefined)
  assert.equal(renderIncomingMessageIdTag("  "), undefined)
  const tag = renderIncomingMessageIdTag("message-1") ?? ""
  assert.match(tag, /message-1/)
})

test("a message id that cannot be written into a prompt is not rendered", () => {
  // A control character cannot appear in a prompt's text, so nothing is rendered for it.
  assert.equal(renderIncomingMessageIdTag("bad\u0000id"), undefined)
  assert.equal(renderIncomingMessageIdTag("bad\u0007id"), undefined)
  // Markup in an id is escaped rather than refused, since the tag has to hold whatever the id was.
  const withMarkup = renderIncomingMessageIdTag("a<b>&c") ?? ""
  assert.match(withMarkup, /<incoming_message_id>/)
  assert.doesNotMatch(withMarkup, /a<b>/)
})

test("a timestamp prefix is written for a time zone, and for none", () => {
  const withZone = buildTimestampPrefix("America/New_York")
  assert.match(withZone, /^<timestamp>[A-Z][a-z]+, [A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2} [AP]M \(UTC[+-]\d+\)<\/timestamp>\n$/)

  const withoutZone = buildTimestampPrefix()
  assert.match(withoutZone, /^<timestamp>.+<\/timestamp>\n$/)
  assert.notEqual(withoutZone, "")
})

test("an unusable time zone falls back rather than throwing", () => {
  const prefix = buildTimestampPrefix("Not/AZone")
  assert.match(prefix, /^<timestamp>.+<\/timestamp>\n$/)
})

// ---------------------------------------------------------------------------------------------
// what the state handle keeps
// ---------------------------------------------------------------------------------------------

test("a handle reports the session it was built for", () => {
  const harnessed = harness()
  assert.equal(harnessed.handle.getPrivacyMode(), PrivacyMode.NO_STORAGE)
  assert.equal(harnessed.handle.getBlobStore(), (harnessed.handle as unknown as { blobStore: unknown }).blobStore)
  assert.equal(harnessed.handle.isDsv3(), false)
})

test("the paths read in a turn are remembered and deduplicated", () => {
  const harnessed = harness()
  assert.equal(harnessed.handle.hasReadPath(redactedPath("/repo/a.ts")), false)
  harnessed.handle.recordReadPath(redactedPath("/repo/a.ts"))
  assert.equal(harnessed.handle.hasReadPath(redactedPath("/repo/a.ts")), true)
  assert.equal(harnessed.handle.hasReadPath(redactedPath("/repo/b.ts")), false)
})

test("a question that was answered is remembered as answered", () => {
  const harnessed = harness()
  assert.equal(harnessed.handle.hasCompletedAskQuestion("call-1"), false)
  harnessed.handle.markAskQuestionCompleted("call-1")
  assert.equal(harnessed.handle.hasCompletedAskQuestion("call-1"), true)
})

test("the turn's usage is accumulated and then reset", () => {
  const harnessed = harness()
  harnessed.handle.addTurnUsage({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 1, cacheWriteTokens: 2, reasoningTokens: 3 })
  harnessed.handle.addTurnUsage({ inputTokens: 4, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 })
  const usage = harnessed.handle.getTurnUsageAndReset()
  assert.deepEqual(usage, { inputTokens: 14, outputTokens: 6, cacheReadTokens: 1, cacheWriteTokens: 2, reasoningTokens: 3 })
  // Reading it resets it, so the next turn starts from nothing.
  assert.deepEqual(harnessed.handle.getTurnUsageAndReset(), { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 })
})

test("the mode of the conversation is set and read back", () => {
  const harnessed = harness()
  harnessed.handle.setMode(AgentMode.PLAN)
  assert.equal(harnessed.handle.mode, AgentMode.PLAN)
})

test("a plan is stored, replaced and cleared", async () => {
  const harnessed = harness()
  assert.equal(await harnessed.handle.getPlan(createContext()), undefined)
  harnessed.handle.setPlan({ steps: [{ description: "first" }] } as never)
  const plan = await harnessed.handle.getPlan(createContext()) as { steps: unknown[] }
  assert.equal(plan.steps.length, 1)
  harnessed.handle.setPlan(undefined)
  assert.equal(await harnessed.handle.getPlan(createContext()), undefined)
})

test("a plan registry entry is added once and updated in place", () => {
  const harnessed = harness()
  harnessed.handle.upsertPlanEntry(new PlanRegistryEntry({ id: "plan-1", path: "/repo/plan.md" } as never))
  assert.equal(harnessed.handle.plans.size, 1)
  harnessed.handle.upsertPlanEntry(new PlanRegistryEntry({ id: "plan-1", path: "/repo/plan-2.md" } as never))
  assert.equal(harnessed.handle.plans.size, 1)
  assert.equal(harnessed.handle.plans.get("plan-1")?.path, "/repo/plan-2.md")
})

test("the goal state is kept and cleared", () => {
  const harnessed = harness()
  harnessed.handle.setGoalState(new GoalState({ goalId: "0123abcd-4567-89ef-0123-456789abcdef", objective: "ship it" } as never))
  assert.equal(harnessed.handle.goalState?.objective, "ship it")
  harnessed.handle.setGoalState(undefined as never)
  assert.equal(harnessed.handle.goalState, undefined)
})

test("a subagent's state is persisted with its type, and found again by either id", () => {
  const harnessed = harness()
  const subagentType = new SubagentType({ type: { case: "unspecified", value: new SubagentTypeUnspecified({}) } })
  harnessed.handle.persistSubagentState(createContext(), "subagent-1", subagentType, { modelId: "composer-2-fast" })
  const restored = harnessed.handle.restoreSubagentState(createContext(), "subagent-1")
  assert.equal(restored?.modelId, "composer-2-fast")
  assert.equal(typeof restored?.createdTimestampMs, "bigint")
  assert.equal(restored?.createdTimestampMs, restored?.lastUsedTimestampMs)
})

test("the most recent subagent of a type is the one a resume mode finds", () => {
  const harnessed = harness()
  const subagentType = new SubagentType({ type: { case: "unspecified", value: new SubagentTypeUnspecified({}) } })
  assert.equal(harnessed.handle.getSubagentIdToResume("generalPurpose", "DEFAULT"), undefined)
  harnessed.handle.persistSubagentState(createContext(), "subagent-1", subagentType, {})
  assert.equal(harnessed.handle.getSubagentIdToResume("generalPurpose", "LAST_AGENT"), "subagent-1")
  assert.equal(harnessed.handle.getSubagentIdToResume("generalPurpose", "LAST_AGENT_SAME_TYPE"), "subagent-1")
  assert.equal(harnessed.handle.getSubagentIdToResume("explore", "LAST_AGENT_SAME_TYPE"), undefined)
})

test("a file's state is recorded and read back", async () => {
  const harnessed = harness()
  assert.equal(await harnessed.handle.getFileState(createContext(), "/repo/a.ts"), undefined)
  harnessed.handle.recordFileState("/repo/a.ts", "const a = 1", undefined)
  assert.equal(await harnessed.handle.getFileState(createContext(), "/repo/a.ts"), "const a = 1")
})

// ---------------------------------------------------------------------------------------------
// the turns it makes
// ---------------------------------------------------------------------------------------------

test("a shell turn is created with its command stored, and its output recorded", async () => {
  const harnessed = harness()
  const turn = await harnessed.handle.createShellTurn(createContext(), redactedShellCommand("ls"))
  assert.equal(turn instanceof ShellConversationTurnHandle, true)
  // The command was written to the store as its own blob.
  assert.equal(harnessed.written.length, 2)
  turn.recordShellOutput(toRedactedShellOutput(new ShellOutput({ stdout: "a file\n", stderr: "", exitCode: 0 }), PrivacyMode.NO_STORAGE))
  const blobId = await turn.writeToBlobStore(createContext())
  assert.equal(blobId instanceof Uint8Array, true)
  // Writing again without a change returns the same blob rather than writing a second copy.
  const before = harnessed.written.length
  assert.deepEqual(await turn.writeToBlobStore(createContext()), blobId)
  assert.equal(harnessed.written.length, before)
})

test("a shell turn's serialized form is a shell conversation turn", async () => {
  const harnessed = harness()
  const turn = await harnessed.handle.createShellTurn(createContext(), redactedShellCommand("ls"))
  const bytes = turn.serialize()
  assert.equal(bytes instanceof Uint8Array, true)
  assert.equal(Buffer.from(bytes).length > 0, true)
})

test("a new structure keeps the turns the conversation already had", async () => {
  const existingTurnBlobId = await getBlobId(new Uint8Array([1, 2, 3]))
  const harnessed = harness(new ConversationStateStructure({ turns: [existingTurnBlobId] }))
  const structure = await harnessed.handle.computeNewStructure(createContext())
  assert.equal(structure.turns.length, 1)
})

test("the message index counts what the conversation already holds", () => {
  const harnessed = harness()
  assert.equal(typeof harnessed.handle.getNextMessageIndex(), "number")
})

test("a conversation's start date is written once and reused", () => {
  const harnessed = harness()
  const first = harnessed.handle.getOrInitializeConversationStartedDate()
  const second = harnessed.handle.getOrInitializeConversationStartedDate()
  assert.equal(first, second)
})

test("clearing the turns empties the conversation", async () => {
  const harnessed = harness(new ConversationStateStructure({ turns: [new Uint8Array([1])] }))
  harnessed.handle.clearTurns()
  const structure = await harnessed.handle.computeNewStructure(createContext())
  assert.deepEqual(structure.turns, [])
})

test("the todos a conversation holds are written into its structure", async () => {
  const harnessed = harness()
  harnessed.handle.setTodos([toRedactedTodoItem(new TodoItem({ id: "1", content: "do the thing", status: 1 }), PrivacyMode.NO_STORAGE)])
  const structure = await harnessed.handle.computeNewStructure(createContext())
  // The list is carried as its own blob reference, not as a turn.
  assert.equal(structure.todos.length, 1)
  assert.equal(harnessed.written.length >= 1, true)
})

// ---------------------------------------------------------------------------------------------
// the turn handles themselves
// ---------------------------------------------------------------------------------------------

test("a turn handle without a change writes nothing new", async () => {
  // The handle writes its own blobs when asked to, and a second write of an unchanged turn is the same id.
  const harnessed = harness()
  const turn = await harnessed.handle.createShellTurn(createContext(), redactedShellCommand("pwd"))
  const first = await turn.writeToBlobStore(createContext())
  const second = await turn.writeToBlobStore(createContext())
  assert.deepEqual(second, first)
  assert.equal(turn instanceof ShellConversationTurnHandle, true)
  assert.equal(turn instanceof AgentConversationTurnHandle, false)
})
// ---------------------------------------------------------------------------------------------
// the edges the state handle keeps
// ---------------------------------------------------------------------------------------------

/** Restoring a handle through the static path, over the same fake blob store the harness uses. */
async function restored(
  state: ConversationStateStructure = new ConversationStateStructure({}),
  runtimeAgentType: ReturnType<typeof import("../../source/packages/agent/state-agent-type.ts").parseAgentType> = undefined,
  options: Record<string, unknown> = {},
) {
  const blobs = new Map<string, Uint8Array>()
  const keyOf = (id: Uint8Array): string => Buffer.from(id).toString("hex")
  const blobStore = {
    async getBlob(_ctx: Context, blobId: Uint8Array) { return blobs.get(keyOf(blobId)) },
    async setBlob(_ctx: Context, blobId: Uint8Array, data: Uint8Array) { blobs.set(keyOf(blobId), data) },
    async setBlobLocallyOnly(_ctx: Context, blobId: Uint8Array, data: Uint8Array) { blobs.set(keyOf(blobId), data) },
    async flush() {},
  }
  const appended: unknown[] = []
  const builder = {
    appendMessages(messages: unknown | readonly unknown[]) { appended.push(...(Array.isArray(messages) ? messages : [messages])) },
    getState: () => appended,
    clearMessages() { appended.length = 0 },
  }
  const handle = await ConversationStateHandle.fromConversationStateStructure(
    createContext(),
    blobStore as never,
    toRedactedConversationStateStructure(state, PrivacyMode.NO_STORAGE),
    builder as never,
    {},
    "composer-2",
    runtimeAgentType,
    options as never,
  )
  return { handle, appended, blobs }
}

test("a thread can be forgotten again", () => {
  const harnessed = harness()
  harnessed.handle.setSubagentThreadId("sub-1", "thread-1")
  assert.equal(harnessed.handle.getSubagentThreadId("sub-1"), "thread-1")
  harnessed.handle.setSubagentThreadId("sub-1", undefined)
  assert.equal(harnessed.handle.getSubagentThreadId("sub-1"), undefined)
})

test("the next message index counts the messages already loaded", () => {
  const harnessed = harness()
  harnessed.builder.appendMessages([{ role: "user", content: "one" }, { role: "user", content: "two" }])
  assert.equal(harnessed.handle.getNextMessageIndex(), 2)
  harnessed.handle.clearTurns()
  assert.equal(harnessed.handle.getNextMessageIndex(), 2)
})

test("a large-context model is the kind this handle calls dsv3", () => {
  const small = harness()
  assert.equal(small.handle.isDsv3(), false)
  const large = new ConversationStateHandle(
    (small.handle as unknown as { blobStore: unknown }).blobStore as never,
    (small.handle as unknown as { conversationStateStructure: unknown }).conversationStateStructure as never,
    small.builder as never,
    {},
    "dsv3-composer",
  )
  assert.equal(large.isDsv3(), true)
})

test("the active branch name is kept", () => {
  const harnessed = harness()
  harnessed.handle.setActiveBranchName("feature/branch")
  assert.equal(harnessed.handle.activeBranchName, "feature/branch")
  harnessed.handle.setActiveBranchName(undefined)
  assert.equal(harnessed.handle.activeBranchName, undefined)
})

test("communicated updates are kept in their history and inside their call state", () => {
  const harnessed = harness()
  harnessed.handle.appendCommunicateUpdateHistoryEntry({ step: "one", messageIndex: 1, finalSummary: "done" })
  harnessed.handle.appendCommunicateUpdateHistoryEntry({ step: "two", messageIndex: 2, parentToolCallId: "call-1", finalSummary: "call summary" })
  harnessed.handle.appendCommunicateUpdateHistoryEntry({ step: "three", messageIndex: 3, parentToolCallId: "call-1", completedSubtitle: "subtitle" })
  assert.deepEqual(harnessed.handle.communicateUpdateHistory.map((entry) => [entry.step, entry.messageIndex]), [["one", 1]])
  assert.equal(harnessed.handle.communicateUpdateFinalSummary, "done")
  const state = harnessed.handle.communicateUpdateStatesByParentToolCallId.get("call-1")
  assert.equal(state?.history.length, 2)
  assert.equal(state?.finalSummary, "call summary")
  assert.equal(state?.completedSubtitle, "subtitle")
})

test("token details are stored as they were given", () => {
  const harnessed = harness()
  const details = harnessed.handle.tokenDetails
  const replacement = new (details.constructor as new (data: Record<string, unknown>) => typeof details)({ inputTokens: 42 })
  harnessed.handle.setTokenDetails(replacement)
  assert.equal(harnessed.handle.tokenDetails, replacement)
})

test("a restore keeps its read paths, plans, skipped-prompt flag and agent-type change", async () => {
  const state = new ConversationStateStructure({
    readPaths: ["/repo/read.ts"],
    plans: { "plan-1": new PlanRegistryEntry({ id: "plan-1" }) },
  })
  const restoreWithChange = await restored(state, "cli" as never, { shouldTrackAgentTypeChange: true });
  assert.deepEqual([...restoreWithChange.handle.readPaths], ["/repo/read.ts"])
  assert.deepEqual([...restoreWithChange.handle.plans.keys()], ["plan-1"])
  assert.equal(restoreWithChange.handle.skippedRootPromptBlobs, false)
  assert.equal(restoreWithChange.handle.agentTypeChangedFromPersistedState, false)
  const changedType = await restored(new ConversationStateStructure({ agentType: "ide" }), "cli" as never, { shouldTrackAgentTypeChange: true })
  assert.equal(changedType.handle.agentTypeChangedFromPersistedState, true)
  assert.equal(changedType.handle.hasAgentTypeChangedFromPersistedState(), true)

  const withoutBlobs = await restored(state, undefined, { loadRootPromptBlobs: false })
  assert.equal(withoutBlobs.handle.skippedRootPromptBlobs, true)
})

