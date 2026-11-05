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
import { DataClassification, PrivacyCapability } from "../../source/packages/redaction/classification.ts"
import {
  toRedactedConversationStateStructure,
} from "../../source/adapters/interop/redacted-protos/generated/agent/v1/agent_redacted.ts"
import {
  AgentMode,
  CloudSubagentReference,
  CommunicateUpdateHistoryEntry,
  CommunicateUpdateTurnState,
  ConversationStateStructure,
  FileStateStructure,
  SubagentRunState,
  SubagentRunStatus,
  SubagentPersistedState,
  SubagentExecutionEnvironment,
  NewCloudVmTarget,
  TargetMachine,
  UserMessage,
  PlanRegistryEntry as PlanRegistryEntryInterop,
} from "../../source/adapters/interop/proto/generated/agent/v1/agent_pb.ts"
import { TodoItem } from "../../source/adapters/interop/proto/generated/agent/v1/todo_tool_pb.ts"
import { toRedactedTodoItem } from "../../source/adapters/interop/redacted-protos/generated/agent/v1/todo_tool_redacted.ts"
import { SubagentType, SubagentTypeUnspecified } from "../../source/adapters/interop/proto/generated/agent/v1/subagents_pb.ts"
import { getBlobId } from "../../source/packages/agent-kv/blob-store.ts"
import { SlateMode } from "../../source/packages/agent/mode-processing.ts"
import { SlateGoalState } from "../../source/packages/agent/goal-state.ts"
import { createSlateSubagentType, SlateSubagentKind } from "../../source/packages/agent/subagent-type.ts"
import { fromInteropUserMessage } from "../../source/adapters/interop/agent/user-message-action-protocol-adapter.ts"
import { deserializeSlateConversationPlan } from "../../source/adapters/interop/agent/agent-state-message-serdes-adapter.ts"
import { fromRedactedInteropTodoItem } from "../../source/adapters/interop/agent/todo-schema-adapter.ts"
import { toPlainInteropUserMessage } from "../../source/adapters/interop/agent/user-message-action-protocol-adapter.ts"
import { fromRedactedSubagentPersistedStateInterop } from "../../source/adapters/interop/agent/agent-state-message-serdes-adapter.ts"
import {
  createSlateShellInvocation,
  createSlateShellResult,
  storeSlateShellInvocation,
  storeSlateShellResult,
} from "../../source/packages/agent/shell-state.ts"

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

function harness(
  state: ConversationStateStructure = new ConversationStateStructure({}),
  restoreOptions: { readonly serializeSubagentStatesAsBlobRefs?: boolean } = {},
): Harness {
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
      restoreOptions as never,
    ),
  }
}

const redactedPath = (value: string) => createRedactedString(value, DataClassification.PATH, "path", PrivacyMode.NO_STORAGE)
/** The state handle stores Slate values after applying the conversation's privacy policy. */
const redactedShellCommand = (command: string) =>
  storeSlateShellInvocation(createSlateShellInvocation(command), PrivacyMode.NO_STORAGE)

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
  assert.equal(harnessed.handle.usesLargeContextTreatment(), false)
})

test("the paths read in a turn are remembered, deduplicated and checkpointed", async () => {
  const harnessed = harness()
  assert.equal(harnessed.handle.hasReadPath("/repo/a.ts"), false)
  harnessed.handle.recordReadPath("/repo/a.ts")
  assert.equal(harnessed.handle.hasReadPath("/repo/a.ts"), true)
  assert.equal(harnessed.handle.hasReadPath("/repo/a.ts"), true)
  harnessed.handle.recordReadPath("/repo/a.ts")
  const exactPath = "/repo/ spaced.ts "
  harnessed.handle.recordReadPath(exactPath)
  assert.equal(harnessed.handle.hasReadPath(exactPath), true)
  assert.equal(harnessed.handle.hasReadPath(exactPath.trim()), false)
  assert.deepEqual([...harnessed.handle.readPaths], ["/repo/a.ts", exactPath])
  assert.equal(harnessed.handle.hasReadPath("/repo/b.ts"), false)
  const checkpoint = await harnessed.handle.computeNewStructure(createContext())
  const redactedCheckpoint = checkpoint as unknown as {
    readonly readPaths: readonly { unwrap(purpose: PrivacyCapability): string }[]
  }
  assert.deepEqual(
    redactedCheckpoint.readPaths.map(path => path.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED)),
    ["/repo/a.ts", exactPath],
  )
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
  harnessed.handle.setMode(SlateMode.PLAN)
  assert.equal(harnessed.handle.mode, SlateMode.PLAN)
  assert.equal(harnessed.handle.slateMode, SlateMode.PLAN)
  assert.equal(harnessed.handle.conversationStateStructure.mode, SlateMode.PLAN)
})

test("a persisted wire mode is projected once into the Slate mode vocabulary", () => {
  const harnessed = harness(new ConversationStateStructure({ mode: AgentMode.MULTITASK }))
  assert.equal(harnessed.handle.slateMode, SlateMode.MULTITASK)
  assert.equal(harnessed.handle.mode, SlateMode.MULTITASK)
  assert.equal(harnessed.handle.conversationStateStructure.mode, SlateMode.MULTITASK)
})

test("an unknown persisted wire mode is normalized before policy runs", () => {
  const harnessed = harness(new ConversationStateStructure({ mode: 987654 as AgentMode }))
  assert.equal(harnessed.handle.slateMode, SlateMode.UNSPECIFIED)
  assert.equal(harnessed.handle.mode, SlateMode.UNSPECIFIED)
  assert.equal(harnessed.handle.conversationStateStructure.mode, SlateMode.UNSPECIFIED)
  assert.equal(harnessed.handle.conversationStateStructure.unknownModeCode, 987654)
})

test("setting a new Slate mode clears an unknown persisted mode code", async () => {
  const harnessed = harness(new ConversationStateStructure({ mode: 987654 as AgentMode }))
  harnessed.handle.setMode(SlateMode.CHAT)

  assert.equal(harnessed.handle.conversationStateStructure.mode, SlateMode.CHAT)
  assert.equal(harnessed.handle.conversationStateStructure.unknownModeCode, undefined)
  assert.equal((await harnessed.handle.computeNewStructure(createContext())).mode, AgentMode.ASK)
})

test("a new persisted snapshot encodes the Slate mode instead of dropping it", async () => {
  const harnessed = harness()
  harnessed.handle.setMode(SlateMode.PLAN)

  const snapshot = await harnessed.handle.computeNewStructure(createContext())

  assert.equal(snapshot.mode, AgentMode.PLAN)
})

test("a plan is stored, replaced and cleared", async () => {
  const harnessed = harness()
  assert.equal(await harnessed.handle.getPlan(createContext()), undefined)
  harnessed.handle.setPlan({ content: "# First plan\n\nDo the work." })
  assert.deepEqual(await harnessed.handle.getPlan(createContext()), {
    content: "# First plan\n\nDo the work.",
  })
  const persisted = await harnessed.handle.computeNewStructure(createContext())
  assert.ok(persisted.plan)
  const bytes = harnessed.blobs.get(Buffer.from(persisted.plan).toString("hex"))
  assert.deepEqual(deserializeSlateConversationPlan(bytes!), { content: "# First plan\n\nDo the work." })
  harnessed.handle.setPlan(undefined)
  assert.equal(await harnessed.handle.getPlan(createContext()), undefined)
})

test("a plan registry entry is added once and updated in place", () => {
  const harnessed = harness()
  harnessed.handle.upsertPlanEntry({ id: "plan-1", path: "/repo/plan.md" })
  assert.equal(harnessed.handle.plans.size, 1)
  harnessed.handle.upsertPlanEntry({ id: "plan-1", path: "/repo/plan-2.md" })
  assert.equal(harnessed.handle.plans.size, 1)
  assert.equal(harnessed.handle.plans.get("plan-1")?.path, "/repo/plan-2.md")
})

test("the goal state is kept and cleared", () => {
  const harnessed = harness()
  harnessed.handle.setGoalState(new SlateGoalState({
    conversationId: "conversation-1",
    goalId: "0123abcd-4567-89ef-0123-456789abcdef",
    objective: "ship it",
    status: "active",
    idleContinuationsWithoutToolCalls: 0,
    continuationCount: 0,
  }))
  assert.equal(harnessed.handle.goalState?.objective, "ship it")
  harnessed.handle.setGoalState(undefined as never)
  assert.equal(harnessed.handle.goalState, undefined)
})

test("a subagent's state is persisted with its type, and found again by either id", () => {
  const harnessed = harness()
  const subagentType = createSlateSubagentType(SlateSubagentKind.GENERAL_PURPOSE)
  harnessed.handle.persistSubagentState(createContext(), "subagent-1", subagentType, { modelId: "composer-2-fast" })
  const restored = harnessed.handle.restoreSubagentState(createContext(), "subagent-1")
  assert.equal(restored?.modelId, "composer-2-fast")
  assert.equal(typeof restored?.createdAtMs, "bigint")
  assert.equal(restored?.createdAtMs, restored?.lastUsedAtMs)
})

test("an explicit subagent type and environment transition retires stale legacy markers", () => {
  const harnessed = harness()
  const legacyType = createSlateSubagentType(SlateSubagentKind.UNKNOWN, {
    compatibility: { legacyDiscriminator: "future-agent" },
  })
  harnessed.handle.persistSubagentState(createContext(), "subagent-1", legacyType, {
    executionEnvironment: "unspecified",
    compatibility: {
      legacyEnvironmentCode: 987,
      legacyUnknownFields: [
        { path: [], number: 100, wireType: 0, dataHex: "01" },
        { path: [{ field: "subagentType" }], number: 101, wireType: 0, dataHex: "02" },
      ],
    },
  })

  harnessed.handle.persistSubagentState(createContext(), "subagent-1", createSlateSubagentType(SlateSubagentKind.EXPLORE), {
    executionEnvironment: "cloud",
  })

  const state = harnessed.handle.restoreSubagentState(createContext(), "subagent-1")
  assert.equal(state?.executionEnvironment, "cloud")
  assert.equal(state?.compatibility?.legacyEnvironmentCode, undefined)
  assert.deepEqual(state?.compatibility?.legacyUnknownFields?.map(field => field.number), [100])
})

test("the most recent subagent of a type is the one a resume mode finds", () => {
  const harnessed = harness()
  const subagentType = createSlateSubagentType(SlateSubagentKind.GENERAL_PURPOSE)
  assert.equal(harnessed.handle.getSubagentIdToResume("generalPurpose", "DEFAULT"), undefined)
  harnessed.handle.persistSubagentState(createContext(), "subagent-1", subagentType, {})
  assert.equal(harnessed.handle.getSubagentIdToResume("generalPurpose", "LAST_AGENT"), "subagent-1")
  assert.equal(harnessed.handle.getSubagentIdToResume("generalPurpose", "LAST_AGENT_SAME_TYPE"), "subagent-1")
  assert.equal(harnessed.handle.getSubagentIdToResume("explore", "LAST_AGENT_SAME_TYPE"), undefined)
})

test("a legacy persisted subagent is restored into Slate state and written back compatibly", async () => {
  const subagentType = new SubagentType({ type: { case: "unspecified", value: new SubagentTypeUnspecified({}) } })
  const harnessed = harness(new ConversationStateStructure({
    subagentStates: {
      "subagent-1": new SubagentPersistedState({
        conversationState: new ConversationStateStructure({
          turns: [new Uint8Array([1])],
          mode: AgentMode.PLAN,
          activeBranchName: "feature/subagent",
          readPaths: ["/repo/subagent-read.ts"],
          fileStatesV2: {
            "/repo/subagent-file.ts": new FileStateStructure({ content: new Uint8Array([8]) }),
          },
          communicateUpdateStatesByParentToolCallId: {
            "nested-call": new CommunicateUpdateTurnState({
              history: [new CommunicateUpdateHistoryEntry({ step: "nested", messageIndex: 4 })],
            }),
          },
          selfSummaryCount: 2,
        }),
        createdTimestampMs: BigInt(10),
        lastUsedTimestampMs: BigInt(20),
        subagentType,
        modelId: "model-1",
        environment: SubagentExecutionEnvironment.CLOUD,
        cloudSubagent: new CloudSubagentReference({ bcId: "worker-1" }),
        machine: new TargetMachine({
          machine: { case: "newCloudVm", value: new NewCloudVmTarget({ baseBranch: "main" }) },
        }),
      }),
    },
  }))

  const restored = harnessed.handle.restoreSubagentState(createContext(), "subagent-1")
  assert.equal(restored?.conversationSnapshot?.turns.length, 1)
  assert.equal(restored?.conversationSnapshot?.mode, SlateMode.PLAN)
  assert.equal(restored?.conversationSnapshot?.activeBranchName, "feature/subagent")
  assert.deepEqual(restored?.conversationSnapshot?.readPaths, ["/repo/subagent-read.ts"])
  assert.deepEqual(restored?.conversationSnapshot?.fileStatesV2.get("/repo/subagent-file.ts"), {
    contentBlobId: new Uint8Array([8]),
  })
  assert.equal(restored?.conversationSnapshot?.selfSummaryCount, 2)
  assert.equal(restored?.createdAtMs, BigInt(10))
  assert.equal(restored?.lastUsedAtMs, BigInt(20))
  assert.equal(restored?.modelId, "model-1")
  assert.equal(restored?.executionEnvironment, "cloud")
  assert.equal(restored?.cloudAgent?.agentId, "worker-1")
  assert.deepEqual(restored?.targetMachine, { kind: "cloud-machine", baseBranch: "main" })

  const snapshot = await harnessed.handle.computeNewStructure(createContext())
  const persistedRedacted = snapshot.subagentStates?.get("subagent-1")
  const persisted = persistedRedacted === undefined
    ? undefined
    : fromRedactedSubagentPersistedStateInterop(
        persistedRedacted,
        PrivacyCapability.UNSAFE_ALWAYS_ALLOWED,
        undefined,
      )
  assert.equal(persisted?.conversationState?.turns.length, 1)
  assert.equal(persisted?.conversationState?.mode, AgentMode.PLAN)
  assert.equal(persisted?.conversationState?.activeBranchName, "feature/subagent")
  assert.deepEqual(persisted?.conversationState?.readPaths, ["/repo/subagent-read.ts"])
  assert.deepEqual(persisted?.conversationState?.fileStatesV2["/repo/subagent-file.ts"]?.content, new Uint8Array([8]))
  assert.equal(persisted?.conversationState?.selfSummaryCount, 2)
  assert.equal(
    persisted?.conversationState?.communicateUpdateStatesByParentToolCallId["nested-call"]?.history[0]?.step,
    "nested",
  )
  assert.equal(persisted?.createdTimestampMs, BigInt(10))
  assert.equal(persisted?.modelId, "model-1")
  assert.equal(persisted?.environment, SubagentExecutionEnvironment.CLOUD)
  assert.equal(persisted?.cloudSubagent?.bcId, "worker-1")
})

test("out-of-line subagent state writes and restores the Slate schema", async () => {
  const harnessed = harness(new ConversationStateStructure(), { serializeSubagentStatesAsBlobRefs: true })
  const ctx = createContext()
  harnessed.handle.persistSubagentState(ctx, "subagent-blob", createSlateSubagentType(SlateSubagentKind.COMPUTER_USE), {
    conversationSnapshot: {
      privacyMode: PrivacyMode.NO_STORAGE,
      rootPromptMessagesJson: [new Uint8Array([1])],
      turns: [new Uint8Array([2, 3])],
      todos: [],
      previousWorkspaceUris: [],
      summaryArchives: [],
      fileStatesV2: new Map([["/repo/file.txt", { contentBlobId: new Uint8Array([4]) }]]),
      readPaths: ["/repo/file.txt"],
    },
    executionEnvironment: "cloud",
    cloudAgent: { agentId: "worker-slate", transcriptUri: "/repo/transcript.jsonl" },
    requestedRuntimeBuildId: "runtime-1",
    targetMachine: { kind: "cloud-machine", baseBranch: "main", environmentBuildId: "runtime-1" },
  })

  await harnessed.handle.computeNewStructure(ctx)
  const blobId = harnessed.handle.conversationStateStructure.subagentStateRefs?.get("subagent-blob")
  assert.ok(blobId)
  const blob = harnessed.blobs.get(Buffer.from(blobId).toString("hex"))
  assert.ok(blob)
  const json = new TextDecoder().decode(blob)
  assert.ok(json.startsWith("SLATE-AGENT-SUBAGENT-STATE\n"))
  const envelope = JSON.parse(json.slice("SLATE-AGENT-SUBAGENT-STATE\n".length)) as {
    readonly state: { readonly executionEnvironment: string; readonly createdAtMs: string }
  }
  assert.equal(envelope.state.executionEnvironment, "cloud")
  assert.match(envelope.state.createdAtMs, /^\d+$/)

  harnessed.handle.subagentStates.clear()
  await harnessed.handle.loadSubagentStateRefs(ctx)
  const restored = harnessed.handle.restoreSubagentState(ctx, "subagent-blob")
  assert.equal(restored?.subagentType?.kind, SlateSubagentKind.COMPUTER_USE)
  assert.equal(restored?.cloudAgent?.agentId, "worker-slate")
  assert.equal(restored?.requestedRuntimeBuildId, "runtime-1")
  assert.deepEqual(restored?.conversationSnapshot?.turns, [new Uint8Array([2, 3])])
  assert.deepEqual(restored?.conversationSnapshot?.fileStatesV2.get("/repo/file.txt"), {
    contentBlobId: new Uint8Array([4]),
  })
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
  turn.recordShellResult(storeSlateShellResult(
    createSlateShellResult({ standardOutput: "a file\n", standardError: "", exitCode: 0 }),
    PrivacyMode.NO_STORAGE,
  ))
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

test("an agent turn persists a user message through the Slate compatibility boundary", async () => {
  const harnessed = harness()
  const ctx = createContext()
  const turn = await harnessed.handle.createAgentTurn(
    ctx,
    fromInteropUserMessage(new UserMessage({
      text: "hello",
      messageId: "message-1",
      mode: AgentMode.PLAN,
    })),
    { env: {}, gitRepos: [] } as never,
    {
      enableTerminalFiles: false,
      enableAgentNotes: false,
      enableImageFiles: false,
      enableLongCodeSelectionSpillToFile: false,
      formattingOptions: {},
      planSystemReminderGenerator: () => "",
      askSystemReminderGenerator: () => "",
      debugSystemReminderGenerator: () => "",
      triageSystemReminderGenerator: () => "",
      webScraperService: { getContentInWebsiteFast: async () => null },
      documentationHydrationService: { hydrate: async () => undefined },
    } as never,
    undefined,
  )

  const stored = await turn.userMessage.get(ctx)
  const plain = toPlainInteropUserMessage(stored)
  assert.equal(plain.text, "hello")
  assert.equal(plain.messageId, "message-1")
  assert.equal(plain.mode, AgentMode.PLAN)
  assert.ok(harnessed.written.length > 0)
})

test("an agent turn records assistant and thinking steps in Slate's step vocabulary", async () => {
  const harnessed = harness()
  const ctx = createContext()
  const turn = await harnessed.handle.createAgentTurn(
    ctx,
    fromInteropUserMessage(new UserMessage({ text: "hello", messageId: "message-1" })),
    { env: {}, gitRepos: [] } as never,
    {
      enableTerminalFiles: false,
      enableAgentNotes: false,
      enableImageFiles: false,
      enableLongCodeSelectionSpillToFile: false,
      formattingOptions: {},
      planSystemReminderGenerator: () => "",
      askSystemReminderGenerator: () => "",
      debugSystemReminderGenerator: () => "",
      triageSystemReminderGenerator: () => "",
      webScraperService: { getContentInWebsiteFast: async () => null },
      documentationHydrationService: { hydrate: async () => undefined },
    } as never,
    undefined,
  )

  await turn.recordText(ctx, "answer")
  await turn.recordText(ctx, " continued")
  await turn.recordThinking(ctx, "reason", 0)
  const steps = await Promise.all(turn.steps.map((step) => step.get(ctx)))

  assert.equal(steps[0]?.kind, "assistant-message")
  if (steps[0]?.kind === "assistant-message") {
    assert.equal(steps[0].text.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED), "answer continued")
  }
  assert.equal(steps[1]?.kind, "thinking-message")
  if (steps[1]?.kind === "thinking-message") {
    assert.equal(steps[1].text.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED), "reason")
    assert.equal(steps[1].durationMs, 0)
  }
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
  harnessed.handle.setTodos([fromRedactedInteropTodoItem(
    toRedactedTodoItem(new TodoItem({ id: "1", content: "do the thing", status: 1 }), PrivacyMode.NO_STORAGE),
  )])
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
  runtimeAgentType: ReturnType<typeof import("../../source/packages/agent/state-agent-type.ts").resolveAgentType> = undefined,
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

test("a large-context model enables the handle's large-context treatment", () => {
  const small = harness()
  assert.equal(small.handle.usesLargeContextTreatment(), false)
  const large = new ConversationStateHandle(
    (small.handle as unknown as { blobStore: unknown }).blobStore as never,
    (small.handle as unknown as { conversationStateStructure: unknown }).conversationStateStructure as never,
    small.builder as never,
    {},
    "dsv3-composer",
  )
  assert.equal(large.usesLargeContextTreatment(), true)
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
    plans: { "plan-1": new PlanRegistryEntryInterop({ id: "plan-1" }) },
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

test("a persisted subagent run is restored into Slate state and written back compatibly", async () => {
  const harnessed = harness(new ConversationStateStructure({
    subagentRunsByParentToolCallId: {
      "call-1": new SubagentRunState({
        parentToolCallId: "call-1",
        subagentId: "agent-1",
        status: SubagentRunStatus.BACKGROUNDED,
        title: "research",
      }),
    },
  }))

  assert.deepEqual(harnessed.handle.subagentRunsByParentToolCallId.get("call-1"), {
    parentToolCallId: "call-1",
    subagentId: "agent-1",
    environment: "unspecified",
    status: "backgrounded",
    title: "research",
  })

  const snapshot = await harnessed.handle.computeNewStructure(createContext())
  assert.ok(snapshot.subagentRunsByParentToolCallId instanceof Map)
  const persisted = snapshot.subagentRunsByParentToolCallId.get("call-1") as SubagentRunState | undefined
  assert.ok(persisted)
  assert.equal(persisted.parentToolCallId, "call-1")
  assert.equal(persisted.subagentId, "agent-1")
  assert.equal(persisted.status, SubagentRunStatus.BACKGROUNDED)
  assert.equal(
    (persisted.title as unknown as { unwrap(purpose: PrivacyCapability): string }).unwrap(
      PrivacyCapability.UNSAFE_ALWAYS_ALLOWED,
    ),
    "research",
  )
})

test("a finished subagent completion updates Slate's durable run record", () => {
  const harnessed = harness()
  const subagentType = createSlateSubagentType(SlateSubagentKind.GENERAL_PURPOSE)
  harnessed.handle.persistSubagentState(createContext(), "agent-1", subagentType, {
    executionEnvironment: "cloud",
    cloudAgent: { agentId: "worker-1", transcriptUri: "/repo/transcript.jsonl" },
  })

  harnessed.handle.recordSubagentRunCompletion({
    kind: "subagent",
    status: "success",
    taskId: "task-1",
    title: "  research  ",
    toolCallId: "call-1",
    subagentId: "agent-1",
    outputPath: "/repo/output.txt",
    reason: "worker-reparented",
  })

  const run = harnessed.handle.subagentRunsByParentToolCallId.get("call-1")
  assert.ok(run)
  assert.deepEqual({
    ...run,
    completedTimestampMs: typeof run.completedTimestampMs,
  }, {
    parentToolCallId: "call-1",
    subagentId: "agent-1",
    environment: "cloud",
    status: "success",
    title: "research",
    transcriptPath: "/repo/transcript.jsonl",
    outputPath: "/repo/output.txt",
    completedTimestampMs: "bigint",
    completionReason: "worker-reparented",
  })
})

test("self-summary suppression becomes due at the recorded token count", () => {
  const harnessed = harness()
  // Nothing recorded: nothing to suppress yet.
  assert.equal(harnessed.handle.shouldSuppressSelfSummaryAfterInputLimitFailure(0), false)
  assert.equal(harnessed.handle.shouldSuppressSelfSummaryAfterInputLimitFailure(1_000_000), false)
  // Once a failed input limit is recorded, the suppression is due from that count onwards.
  harnessed.handle.setSelfSummaryInputLimitFailureTokenCount(10)
  assert.equal(harnessed.handle.shouldSuppressSelfSummaryAfterInputLimitFailure(9), false)
  assert.equal(harnessed.handle.shouldSuppressSelfSummaryAfterInputLimitFailure(10), true)
  assert.equal(harnessed.handle.shouldSuppressSelfSummaryAfterInputLimitFailure(11), true)
  // Clearing the record makes it due again, not suppressed.
  harnessed.handle.clearSelfSummaryInputLimitFailureTokenCount()
  assert.equal(harnessed.handle.shouldSuppressSelfSummaryAfterInputLimitFailure(1_000_000), false)
})

