import { test } from "node:test"
import assert from "node:assert/strict"

import {
  fromInteropConversationState,
  toInteropConversationState,
} from "../../source/adapters/interop/agent/agent-state-message-serdes-adapter.ts"
import { fromRedactedConversationStateStructureInterop } from "../../source/adapters/interop/agent/agent-state-message-serdes-adapter.ts"
import {
  fromRedactedConversationStateStructure,
  toRedactedConversationStateStructure,
} from "../../source/adapters/interop/redacted-protos/generated/agent/v1/agent_redacted.ts"
import {
  AgentMode,
  CommunicateUpdateHistoryEntry,
  CommunicateUpdateTurnState,
  ConversationStateStructure,
  ConversationTokenDetails,
  FileStateStructure,
  GoalState,
  PlanRegistryEntry,
  SubagentPersistedState,
  SubagentExecutionEnvironment,
  SubagentRunState,
  SubagentRunStatus,
  TrackedGitRepo,
  BackgroundTaskCompletionReason,
  PromptContextNode,
  PromptContextSourceRef,
  PromptContextUsageTree,
  PromptTokenBreakdownCategory,
  PromptTokenBreakdownSnapshot,
  StepTiming,
} from "../../source/adapters/interop/proto/generated/agent/v1/agent_pb.ts"
import { GoalStatus } from "../../source/adapters/interop/proto/generated/agent/v1/goal_tool_pb.ts"
import { PrivacyMode } from "../../source/packages/redaction/privacy-mode.ts"
import { SlateMode } from "../../source/packages/agent/mode-processing.ts"
import { SlateGoalState } from "../../source/packages/agent/goal-state.ts"
import { SlateGoalStatus } from "../../source/packages/agent-core/goal-continuation.ts"
import { DataClassification, PrivacyCapability } from "../../source/packages/redaction/classification.ts"
import type {
  SlateCommunicationTurnState,
  SlateConversationTokenDetails,
  SlateRedactedValue,
} from "../../source/packages/agent/conversation-state.ts"
import { RedactedString } from "../../source/packages/redaction/redacted-values.ts"

test("conversation state projects its persisted mode and fields into Slate", () => {
  const source = new ConversationStateStructure({
    turns: [new Uint8Array([1]), new Uint8Array([2])],
    rootPromptMessagesJson: [new Uint8Array([3])],
    mode: AgentMode.PLAN,
    activeBranchName: "feature",
    summaryArchive: new Uint8Array([4]),
    turnTimings: [new StepTiming({ durationMs: BigInt(3), timestampMs: BigInt(7) })],
    conversationStartedTimestampMs: BigInt(10),
    pendingToolCalls: ["{\"role\":\"assistant\"}"],
    previousWorkspaceUris: ["file:///workspace"],
    trackedGitRepoBranches: [new TrackedGitRepo({ repoPath: "/repo", branchName: "feature" })],
  })
  const redacted = toRedactedConversationStateStructure(source, PrivacyMode.NO_STORAGE)
  const slate = fromInteropConversationState(redacted)

  assert.equal(slate.mode, SlateMode.PLAN)
  assert.equal(slate.privacyMode, PrivacyMode.NO_STORAGE)
  assert.deepEqual(slate.turns, source.turns)
  assert.deepEqual(slate.rootPromptMessagesJson, source.rootPromptMessagesJson)
  assert.equal(slate.activeBranchName, "feature")
  assert.deepEqual(slate.summaryArchiveBlobId, new Uint8Array([4]))
  assert.deepEqual(slate.turnTimings, [{ durationMs: BigInt(3), timestampMs: BigInt(7) }])
  assert.equal(slate.conversationStartedTimestampMs, BigInt(10))
  assert.deepEqual(slate.pendingToolCalls, ["{\"role\":\"assistant\"}"])
  assert.deepEqual(slate.previousWorkspaceUris, ["file:///workspace"])
  assert.deepEqual(slate.trackedGitRepoBranches, [{ repoPath: "/repo", branchName: "feature" }])

  const roundTripped = toInteropConversationState(slate)
  assert.equal(roundTripped.mode, AgentMode.PLAN)
  assert.equal(roundTripped._privacyMode, PrivacyMode.NO_STORAGE)
  assert.deepEqual(roundTripped.summaryArchive, new Uint8Array([4]))
  assert.deepEqual(roundTripped.turnTimings.map((timing: StepTiming) => [timing.durationMs, timing.timestampMs]), [[BigInt(3), BigInt(7)]])
  assert.ok(roundTripped.pendingToolCalls[0] instanceof RedactedString)
  assert.equal(roundTripped.pendingToolCalls[0]?.__classification, DataClassification.CODE)
  assert.ok(roundTripped.previousWorkspaceUris[0] instanceof RedactedString)
  assert.equal(roundTripped.previousWorkspaceUris[0]?.__classification, DataClassification.PATH)
  assert.ok(roundTripped.trackedGitRepoBranches[0]?.repoPath instanceof RedactedString)
  assert.equal(roundTripped.trackedGitRepoBranches[0]?.repoPath.__fieldName, "repo_path")

  const persisted = fromRedactedConversationStateStructureInterop(
    roundTripped,
    PrivacyCapability.UNSAFE_ALWAYS_ALLOWED,
    undefined,
  )
  assert.deepEqual(persisted.pendingToolCalls, ["{\"role\":\"assistant\"}"])
  assert.deepEqual(persisted.previousWorkspaceUris, ["file:///workspace"])
  assert.equal(persisted.trackedGitRepoBranches[0]?.repoPath, "/repo")
})

test("an unknown conversation mode uses Slate's fallback without losing its source code", () => {
  const redacted = toRedactedConversationStateStructure(
    new ConversationStateStructure({ mode: 987654 as AgentMode }),
    PrivacyMode.NO_STORAGE,
  )
  const slate = fromInteropConversationState(redacted)
  const roundTripped = toInteropConversationState(slate)

  assert.equal(slate.mode, SlateMode.UNSPECIFIED)
  assert.equal(slate.unknownModeCode, 987654)
  assert.equal(roundTripped.mode, 987654)
})

test("communication update contracts are Slate-owned and redact only at the interop boundary", () => {
  const redacted = toRedactedConversationStateStructure(
    new ConversationStateStructure({
      communicateUpdateHistory: [new CommunicateUpdateHistoryEntry({ step: "global step", messageIndex: 2 })],
      communicateUpdateFinalSummary: "global summary",
      communicateUpdateCompletedSubtitle: "global subtitle",
      communicateUpdateStatesByParentToolCallId: {
        "call-1": new CommunicateUpdateTurnState({
          history: [new CommunicateUpdateHistoryEntry({ step: "call step", messageIndex: 3 })],
          finalSummary: "call summary",
          completedSubtitle: "call subtitle",
        }),
      },
    }),
    PrivacyMode.NO_STORAGE,
  )
  const slate = fromInteropConversationState(redacted)

  assert.deepEqual(slate.communicationHistory, [{ step: "global step", messageIndex: 2 }])
  assert.equal(slate.communicationFinalSummary, "global summary")
  assert.equal(slate.communicationCompletedSubtitle, "global subtitle")
  const callTurn = (slate.communicationTurnsByCallId as ReadonlyMap<string, SlateCommunicationTurnState> | undefined)
    ?.get("call-1")
  assert.deepEqual(callTurn, {
    history: [{ step: "call step", messageIndex: 3 }],
    finalSummary: "call summary",
    completedSubtitle: "call subtitle",
  })

  const interop = toInteropConversationState(slate)
  assert.ok(interop.communicateUpdateHistory[0]?.step instanceof RedactedString)
  assert.equal(interop.communicateUpdateHistory[0]?.step.__classification, DataClassification.CODE)
  assert.equal(
    interop.communicateUpdateHistory[0]?.step.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED),
    "global step",
  )
  assert.ok(interop.communicateUpdateFinalSummary instanceof RedactedString)
  assert.equal(interop.communicateUpdateFinalSummary.__fieldName, "communicate_update_final_summary")

  const persisted = fromRedactedConversationStateStructureInterop(
    interop,
    PrivacyCapability.UNSAFE_ALWAYS_ALLOWED,
    undefined,
  )
  const persistedTurn = persisted.communicateUpdateStatesByParentToolCallId["call-1"]
  assert.equal(persisted.communicateUpdateHistory[0]?.step, "global step")
  assert.equal(persisted.communicateUpdateFinalSummary, "global summary")
  assert.equal(persisted.communicateUpdateCompletedSubtitle, "global subtitle")
  assert.equal(persistedTurn?.history[0]?.step, "call step")
  assert.equal(persistedTurn?.finalSummary, "call summary")
  assert.equal(persistedTurn?.completedSubtitle, "call subtitle")
})

test("conversation token details use Slate values and are redacted only at the interop boundary", () => {
  const tokenDetails = new ConversationTokenDetails({
    usedTokens: 12,
    maxTokens: 100,
    breakdown: new PromptTokenBreakdownSnapshot({
      totalUsedTokens: 12,
      maxTokens: 100,
      categories: [new PromptTokenBreakdownCategory({
        id: "conversation",
        label: "Conversation",
        estimatedTokens: 12,
        characterCount: 48,
      })],
    }),
    promptContextUsageTree: new PromptContextUsageTree({
      schemaVersion: 1,
      nodes: [new PromptContextNode({
        id: "message:0:content",
        kind: "user_message",
        label: "User Message",
        categoryId: "conversation",
        estimatedTokens: 12,
        characterCount: 48,
        contentAvailable: true,
        source: new PromptContextSourceRef({
          sourceType: "root_prompt_message",
          messageIndex: 0,
          contentPath: "content",
          startOffset: 0,
          endOffset: 48,
        }),
        inlineContent: "private prompt text",
      })],
    }),
    promptContextUsageSnapshotBlobId: new Uint8Array([4, 5]),
  })
  const slate = fromInteropConversationState(toRedactedConversationStateStructure(
    new ConversationStateStructure({ tokenDetails }),
    PrivacyMode.NO_STORAGE,
  ))

  const expected: SlateConversationTokenDetails = {
    usedTokens: 12,
    maximumTokens: 100,
    breakdown: {
      totalUsedTokens: 12,
      maxTokens: 100,
      categories: [{ id: "conversation", label: "Conversation", estimatedTokens: 12, characterCount: 48 }],
    },
    contextTree: {
      schemaVersion: 1,
      nodes: [{
        id: "message:0:content",
        kind: "user_message",
        label: "User Message",
        categoryId: "conversation",
        estimatedTokens: 12,
        characterCount: 48,
        contentAvailable: true,
        source: {
          sourceType: "root_prompt_message",
          messageIndex: 0,
          contentPath: "content",
          startOffset: 0,
          endOffset: 48,
        },
        inlineContent: "private prompt text",
      }],
    },
    usageSnapshotBlobId: new Uint8Array([4, 5]),
  }
  assert.deepEqual(slate.tokenDetails, expected)

  const interop = toInteropConversationState(slate)
  const storedTree = interop.tokenDetails?.promptContextUsageTree
  assert.ok(storedTree?.nodes[0]?.label instanceof RedactedString)
  assert.equal(storedTree?.nodes[0]?.label.__classification, DataClassification.CODE)
  assert.equal(storedTree?.nodes[0]?.inlineContent?.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED), "private prompt text")
  const restored = fromRedactedConversationStateStructureInterop(
    interop,
    PrivacyCapability.UNSAFE_ALWAYS_ALLOWED,
    undefined,
  )
  assert.equal(restored.tokenDetails?.usedTokens, 12)
  assert.equal(restored.tokenDetails?.maxTokens, 100)
  assert.equal(restored.tokenDetails?.promptContextUsageSnapshotBlobId?.join(","), "4,5")
})

test("file state paths and blob references become plain Slate values", () => {
  const redacted = toRedactedConversationStateStructure(
    new ConversationStateStructure({
      fileStates: { "/repo/legacy.ts": new Uint8Array([3]) },
      fileStatesV2: {
        "/repo/a.ts": new FileStateStructure({
          content: new Uint8Array([1]),
          initialContent: new Uint8Array([2]),
        }),
      },
    }),
    PrivacyMode.NO_STORAGE,
  )
  const slate = fromInteropConversationState(redacted)

  assert.deepEqual(slate.fileStatesV2.get("/repo/a.ts"), {
    contentBlobId: new Uint8Array([1]),
    initialContentBlobId: new Uint8Array([2]),
  })
  assert.deepEqual(
    (slate.legacyFileContentBlobIds as ReadonlyMap<string, Uint8Array> | undefined)?.get("/repo/legacy.ts"),
    new Uint8Array([3]),
  )

  const slateInterop = toInteropConversationState(slate)
  const legacyFileEntry = [...slateInterop.fileStates.entries()][0]
  assert.ok(legacyFileEntry?.[0] instanceof RedactedString)
  assert.equal(legacyFileEntry?.[0].unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED), "/repo/legacy.ts")
  assert.deepEqual(legacyFileEntry?.[1], new Uint8Array([3]))

  const plain = fromRedactedConversationStateStructure(
    slateInterop,
    PrivacyCapability.UNSAFE_ALWAYS_ALLOWED,
    undefined,
  )
  const restored = Object.values(plain.fileStatesV2)[0] as FileStateStructure | undefined
  assert.deepEqual(restored?.content, new Uint8Array([1]))
  assert.deepEqual(restored?.initialContent, new Uint8Array([2]))
})

test("read paths are plain Slate values in memory and privacy-wrapped only in checkpoints", () => {
  const exactPath = "/repo/ spaced.ts "
  const redacted = toRedactedConversationStateStructure(
    new ConversationStateStructure({
      readPaths: ["/repo/a.ts", "/repo/b.ts", exactPath],
    }),
    PrivacyMode.NO_STORAGE,
  )
  const slate = fromInteropConversationState(redacted)

  assert.deepEqual(slate.readPaths, ["/repo/a.ts", "/repo/b.ts", exactPath])

  const interop = toInteropConversationState(slate)
  const firstReadPath = interop.readPaths[0]
  assert.ok(firstReadPath instanceof RedactedString)
  assert.equal(firstReadPath.__classification, DataClassification.PATH)
  assert.equal(firstReadPath.__fieldName, "read_paths")
  assert.equal(firstReadPath.__privacyMode, PrivacyMode.NO_STORAGE)
  assert.deepEqual(
    interop.readPaths.map(
      (path: SlateRedactedValue<string>) =>
        path.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED),
    ),
    ["/repo/a.ts", "/repo/b.ts", exactPath],
  )
  const plain = fromRedactedConversationStateStructure(
    interop,
    PrivacyCapability.UNSAFE_ALWAYS_ALLOWED,
    undefined,
  )
  assert.deepEqual(plain.readPaths, ["/repo/a.ts", "/repo/b.ts", exactPath])
})

test("plan registry and goal state use Slate types and retain an unknown status code", () => {
  const unknownStatus = 4_096 as GoalStatus
  const redacted = toRedactedConversationStateStructure(
    new ConversationStateStructure({
      plans: {
        "plan-1": new PlanRegistryEntry({ id: "plan-1", path: "/repo/plan.md" }),
      },
      goalState: new GoalState({
        conversationId: "conversation-1",
        goalId: "goal-1",
        objective: "ship the first version",
        status: unknownStatus,
        continuationCount: 2,
      }),
    }),
    PrivacyMode.NO_STORAGE,
  )
  const slate = fromInteropConversationState(redacted)

  assert.deepEqual(slate.plans?.get("plan-1"), { id: "plan-1", path: "/repo/plan.md" })
  assert.ok(slate.goalState instanceof SlateGoalState)
  assert.equal(slate.goalState.status, SlateGoalStatus.UNSPECIFIED)

  const restored = fromRedactedConversationStateStructureInterop(
    toInteropConversationState(slate),
    PrivacyCapability.UNSAFE_ALWAYS_ALLOWED,
    undefined,
  )
  assert.equal(Object.values(restored.plans)[0]?.path, "/repo/plan.md")
  assert.equal(restored.goalState?.status, GoalStatus.UNSPECIFIED)
})

test("subagent state values are typed Slate records and preserve unknown environments", () => {
  const unknownEnvironment = 4_097 as SubagentExecutionEnvironment
  const redacted = toRedactedConversationStateStructure(
    new ConversationStateStructure({
      subagentStates: {
        "subagent-1": new SubagentPersistedState({
          modelId: "model-1",
          environment: unknownEnvironment,
        }),
      },
    }),
    PrivacyMode.NO_STORAGE,
  )
  const slate = fromInteropConversationState(redacted)
  const subagent = slate.subagentStates?.get("subagent-1")

  assert.equal(subagent?.modelId, "model-1")
  assert.equal(subagent?.executionEnvironment, "unspecified")
  assert.equal(subagent?.compatibility?.legacyEnvironmentCode, unknownEnvironment)

  const restored = fromRedactedConversationStateStructureInterop(
    toInteropConversationState(slate),
    PrivacyCapability.UNSAFE_ALWAYS_ALLOWED,
    undefined,
  )
  assert.equal(restored.subagentStates["subagent-1"]?.environment, unknownEnvironment)
  assert.equal(restored.subagentStates["subagent-1"]?.modelId, "model-1")
})

test("subagent run records are Slate values and preserve unknown enum codes", () => {
  const unknownEnvironment = 4_097 as SubagentExecutionEnvironment
  const unknownStatus = 4_098 as SubagentRunStatus
  const unknownReason = 4_099 as BackgroundTaskCompletionReason
  const redacted = toRedactedConversationStateStructure(
    new ConversationStateStructure({
      subagentRunsByParentToolCallId: {
        "call-1": new SubagentRunState({
          parentToolCallId: "call-1",
          environment: unknownEnvironment,
          status: unknownStatus,
          completionReason: unknownReason,
        }),
      },
    }),
    PrivacyMode.NO_STORAGE,
  )
  const slate = fromInteropConversationState(redacted)
  const run = slate.subagentRunsByParentToolCallId?.get("call-1")

  assert.equal(run?.environment, "unspecified")
  assert.equal(run?.status, "unspecified")
  assert.deepEqual(run?.compatibility, {
    legacyEnvironmentCode: unknownEnvironment,
    legacyStatusCode: unknownStatus,
    legacyCompletionReasonCode: unknownReason,
  })

  const restored = fromRedactedConversationStateStructureInterop(
    toInteropConversationState(slate),
    PrivacyCapability.UNSAFE_ALWAYS_ALLOWED,
    undefined,
  )
  const interopRun = restored.subagentRunsByParentToolCallId["call-1"]
  assert.equal(interopRun?.environment, unknownEnvironment)
  assert.equal(interopRun?.status, unknownStatus)
  assert.equal(interopRun?.completionReason, unknownReason)
})
