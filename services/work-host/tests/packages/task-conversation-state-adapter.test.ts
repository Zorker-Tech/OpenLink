import { test } from "node:test"
import assert from "node:assert/strict"

import {
  AgentMode,
  CommunicateUpdateHistoryEntry,
  CommunicateUpdateTurnState,
  ConversationStateStructure,
  ConversationTokenDetails,
  FileStateStructure,
  GoalState,
  PlanRegistryEntry,
  StepTiming,
  SubagentExecutionEnvironment,
  SubagentPersistedState,
  SubagentRunState,
  SubagentRunStatus,
  TrackedGitRepo,
} from "../../source/adapters/interop/proto/generated/agent/v1/agent_pb.ts"
import { GoalStatus } from "../../source/adapters/interop/proto/generated/agent/v1/goal_tool_pb.ts"
import {
  fromInteropTaskConversationState,
  fromRedactedTaskConversationState,
  toInteropTaskConversationState,
  toRedactedTaskConversationState,
} from "../../source/adapters/interop/agent/task-conversation-state-adapter.ts"
import { serializeRedactedConversationStateInterop } from "../../source/adapters/interop/agent/agent-state-message-serdes-adapter.ts"
import { SlateMode } from "../../source/packages/agent/mode-processing.ts"
import { DataClassification, PrivacyCapability } from "../../source/packages/redaction/classification.ts"
import { PrivacyMode } from "../../source/packages/redaction/privacy-mode.ts"
import { RedactedString } from "../../source/packages/redaction/redacted-values.ts"

test("subagent snapshots project the shared conversation fields into the Slate schema", () => {
  const turnId = new Uint8Array([1, 2, 3])
  const source = new ConversationStateStructure({
    rootPromptMessagesJson: [new Uint8Array([9])],
    todos: [new Uint8Array([8])],
    turns: [turnId],
    mode: AgentMode.PLAN,
    readPaths: ["/repo/read.ts", "/repo/ spaced.ts "],
    fileStatesV2: {
      "/repo/state.ts": new FileStateStructure({
        content: new Uint8Array([4]),
        initialContent: new Uint8Array([5]),
      }),
    },
    activeBranchName: "feature/state",
    selfSummaryCount: 3,
  })

  const state = fromInteropTaskConversationState(source, PrivacyMode.NO_STORAGE)
  turnId[0] = 99

  assert.equal(state.privacyMode, PrivacyMode.NO_STORAGE)
  assert.equal(state.mode, SlateMode.PLAN)
  assert.deepEqual(state.turns, [new Uint8Array([1, 2, 3])])
  assert.deepEqual(state.rootPromptMessagesJson, [new Uint8Array([9])])
  assert.deepEqual(state.todos, [new Uint8Array([8])])
  assert.deepEqual(state.readPaths, ["/repo/read.ts", "/repo/ spaced.ts "])
  assert.deepEqual(state.fileStatesV2.get("/repo/state.ts"), {
    contentBlobId: new Uint8Array([4]),
    initialContentBlobId: new Uint8Array([5]),
  })
  assert.equal(state.activeBranchName, "feature/state")
  assert.equal(state.selfSummaryCount, 3)
})

test("subagent snapshots retain historical field encoding through launch and redacted persistence", () => {
  const source = new ConversationStateStructure({
    rootPromptMessagesJson: [new Uint8Array([9])],
    todos: [new Uint8Array([8])],
    pendingToolCalls: ["call-1"],
    tokenDetails: new ConversationTokenDetails({ usedTokens: 12, maxTokens: 100 }),
    summary: new Uint8Array([7]),
    plan: new Uint8Array([6]),
    turns: [new Uint8Array([1])],
    mode: AgentMode.MULTITASK,
    previousWorkspaceUris: ["file:///workspace"],
    summaryArchive: new Uint8Array([5]),
    fileStates: { "/repo/legacy.ts": new Uint8Array([4]) },
    summaryArchives: [new Uint8Array([3])],
    turnTimings: [new StepTiming({ durationMs: BigInt(10), timestampMs: BigInt(20) })],
    readPaths: ["/repo/read.ts", "/repo/ spaced.ts "],
    fileStatesV2: {
      "/repo/state.ts": new FileStateStructure({ content: new Uint8Array([2]), initialContent: new Uint8Array([1]) }),
    },
    subagentStates: {
      "child-1": new SubagentPersistedState({
        conversationState: new ConversationStateStructure({
          communicateUpdateStatesByParentToolCallId: {
            "nested-call": new CommunicateUpdateTurnState({
              history: [new CommunicateUpdateHistoryEntry({ step: "nested", messageIndex: 2 })],
            }),
          },
        }),
        createdTimestampMs: BigInt(30),
        lastUsedTimestampMs: BigInt(40),
        environment: SubagentExecutionEnvironment.LOCAL,
      }),
    },
    selfSummaryCount: 2,
    activeBranchName: "feature/state",
    plans: { "plan-1": new PlanRegistryEntry({ id: "plan-1", path: "/repo/plan.md" }) },
    trackedGitRepoBranches: [new TrackedGitRepo({ repoPath: "/repo", branchName: "feature/state" })],
    agentType: "cli",
    communicateUpdateHistory: [new CommunicateUpdateHistoryEntry({ step: "doing work", messageIndex: 1 })],
    subagentThreads: { "call-1": "thread-1" },
    communicateUpdateFinalSummary: "finished",
    conversationStartedTimestampMs: BigInt(50),
    conversationStartedTimeZone: "Asia/Shanghai",
    communicateUpdateCompletedSubtitle: "done",
    communicateUpdateStatesByParentToolCallId: {
      "call-1": new CommunicateUpdateTurnState({
        history: [new CommunicateUpdateHistoryEntry({ step: "doing work", messageIndex: 1 })],
        finalSummary: "finished",
        completedSubtitle: "done",
      }),
    },
    subagentRunsByParentToolCallId: {
      "call-1": new SubagentRunState({
        parentToolCallId: "call-1",
        status: SubagentRunStatus.BACKGROUNDED,
        environment: SubagentExecutionEnvironment.LOCAL,
      }),
    },
    subagentStateRefs: { "child-1": new Uint8Array([11]) },
    goalState: new GoalState({
      conversationId: "conversation-1",
      goalId: "goal-1",
      objective: "finish work",
      status: GoalStatus.ACTIVE,
      idleContinuationsWithoutToolCalls: 0,
      continuationCount: 1,
    }),
    isRootProjectConversation: true,
    completedAskQuestionToolCallIds: ["question-1"],
  })
  const state = fromInteropTaskConversationState(source, PrivacyMode.NO_STORAGE)
  const redacted = toRedactedTaskConversationState(state, PrivacyMode.NO_STORAGE)
  const firstReadPath = redacted.readPaths[0]

  assert.ok(firstReadPath instanceof RedactedString)
  assert.equal(firstReadPath.__classification, DataClassification.PATH)
  assert.equal(firstReadPath.__fieldName, "read_paths")
  assert.deepEqual(
    toInteropTaskConversationState(state),
    source,
  )
  const persisted = ConversationStateStructure.fromBinary(
    serializeRedactedConversationStateInterop(redacted),
  )
  assert.equal(ConversationStateStructure.equals(persisted, source), true)

  const restored = fromRedactedTaskConversationState(redacted)
  assert.equal(restored.mode, SlateMode.MULTITASK)
  assert.equal(restored.privacyMode, PrivacyMode.NO_STORAGE)
  assert.deepEqual(restored.readPaths, ["/repo/read.ts", "/repo/ spaced.ts "])
  assert.deepEqual(
    fromRedactedTaskConversationState(redacted).readPaths.map(path => path),
    restored.readPaths,
  )
  assert.equal(
    firstReadPath.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED),
    "/repo/read.ts",
  )
})

test("an empty Slate task snapshot reconstructs the historical empty conversation", () => {
  const empty = fromInteropTaskConversationState(new ConversationStateStructure())
  assert.deepEqual(toInteropTaskConversationState(empty), new ConversationStateStructure())
})
