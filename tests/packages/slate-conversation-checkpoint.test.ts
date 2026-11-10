import { test } from "node:test"
import assert from "node:assert/strict"

import {
  AgentMode,
  BackgroundTaskCompletionReason,
  CloudSubagentReference,
  CommunicateUpdateHistoryEntry,
  CommunicateUpdateTurnState,
  ConversationStateStructure,
  ConversationTokenDetails,
  FileStateStructure,
  GoalState,
  PlanRegistryEntry,
  PromptContextNode,
  PromptContextSourceRef,
  PromptContextUsageTree,
  PromptTokenBreakdownCategory,
  PromptTokenBreakdownSnapshot,
  SelfHostedPoolTarget,
  SelfHostedWorkerLabel,
  SelfHostedWorkerTarget,
  NewCloudVmTarget,
  SameMachineTarget,
  StepTiming,
  SubagentExecutionEnvironment,
  SubagentPersistedState,
  SubagentRunState,
  SubagentRunStatus,
  TargetMachine,
  TrackedGitRepo,
} from "../../source/adapters/interop/proto/generated/agent/v1/agent_pb.ts"
import { SubagentType, SubagentTypeCustom, SubagentTypeShell } from "../../source/adapters/interop/proto/generated/agent/v1/subagents_pb.ts"
import { encodeInteropAgentConversationCheckpoint, decodeInteropAgentConversationCheckpoint } from "../../source/adapters/interop/agent/agent-conversation-protobuf-adapter.ts"
import {
  createEmptySlateConversationCheckpointV2,
  isSlateConversationCheckpointV2,
} from "../../source/packages/agent/conversation-checkpoint-state.ts"
import { deserializeSlateAgentCheckpoint } from "../../source/packages/agent-kv/agent-checkpoint-schema.ts"
import { GoalStatus } from "../../source/adapters/interop/proto/generated/agent/v1/goal_tool_pb.ts"

test("an empty first-party checkpoint has complete, stable collection defaults", () => {
  const checkpoint = createEmptySlateConversationCheckpointV2()
  assert.equal(isSlateConversationCheckpointV2(checkpoint), true)
  assert.deepEqual(checkpoint, {
    promptMessageBlobIds: [],
    todoBlobIds: [],
    pendingOperationIds: [],
    turnBlobIds: [],
    workspaceUris: [],
    legacyFileContentBlobIds: {},
    summaryArchiveBlobIds: [],
    turnTimings: [],
    fileContentBlobIds: {},
    subagents: {},
    selfSummaryCount: 0,
    readPaths: [],
    planRegistry: {},
    trackedRepositories: [],
    communicationHistory: [],
    subagentThreads: {},
    communicationTurnsByCallId: {},
    subagentRunsByCallId: {},
    subagentStateBlobIds: {},
    completedQuestionCallIds: [],
  })
})

test("Slate checkpoint v2 owns all conversation fields and round-trips nested state", () => {
  const state = new ConversationStateStructure({
    rootPromptMessagesJson: [new Uint8Array([1, 2]), new Uint8Array([3])],
    todos: [new Uint8Array([4])],
    pendingToolCalls: ["call-a", "call-b"],
    tokenDetails: new ConversationTokenDetails({
      usedTokens: 38,
      maxTokens: 256,
      breakdown: new PromptTokenBreakdownSnapshot({
        totalUsedTokens: 38,
        maxTokens: 256,
        categories: [new PromptTokenBreakdownCategory({
          id: "messages",
          label: "Messages",
          estimatedTokens: 30,
          characterCount: 120,
        })],
      }),
      promptContextUsageTree: new PromptContextUsageTree({
        schemaVersion: 1,
        nodes: [new PromptContextNode({
          id: "node-1",
          kind: "message",
          label: "User message",
          categoryId: "messages",
          estimatedTokens: 30,
          characterCount: 120,
          contentAvailable: true,
          source: new PromptContextSourceRef({
            sourceType: "message",
            messageIndex: 2,
            contentPath: "parts[0]",
            startOffset: 0,
            endOffset: 120,
          }),
          inlineContent: "Question",
        })],
      }),
      promptContextUsageSnapshotBlobId: new Uint8Array([5, 6]),
    }),
    summary: new Uint8Array([7]),
    plan: new Uint8Array([8]),
    turns: [new Uint8Array([9, 10])],
    previousWorkspaceUris: ["file:///workspace", "file:///repo"],
    mode: AgentMode.AGENT,
    summaryArchive: new Uint8Array([11]),
    fileStates: { "/repo/legacy.ts": new Uint8Array([12]) },
    summaryArchives: [new Uint8Array([13])],
    turnTimings: [new StepTiming({ durationMs: 9_007_199_254_740_993n, timestampMs: 1_700_000_000_123n })],
    fileStatesV2: {
      "/repo/state.ts": new FileStateStructure({ content: new Uint8Array([14]), initialContent: new Uint8Array([15]) }),
      "/repo/initial-only.ts": new FileStateStructure({ initialContent: new Uint8Array([16]) }),
    },
    subagentStates: {
      "child-custom": new SubagentPersistedState({
        conversationState: new ConversationStateStructure({
          turns: [new Uint8Array([17])],
          mode: AgentMode.AGENT,
          readPaths: ["/nested/ exact.ts "],
          subagentThreads: { "nested-call": "nested-thread" },
        }),
        createdTimestampMs: 1_700_000_000_123n,
        lastUsedTimestampMs: 1_700_000_000_456n,
        subagentType: new SubagentType({ type: { case: "custom", value: new SubagentTypeCustom({ name: "reviewer" }) } }),
        modelId: "model-a",
        environment: SubagentExecutionEnvironment.LOCAL,
        cloudSubagent: new CloudSubagentReference({ bcId: "worker-a", transcriptPath: "/worker/transcript.jsonl" }),
        firstClassBcId: "cloud-run-a",
        cloudRequestedEnvironmentBuildId: "build-a",
        machine: new TargetMachine({ machine: {
          case: "selfHostedPool",
          value: new SelfHostedPoolTarget({
            pool: "pool-a",
            labels: [
              new SelfHostedWorkerLabel({ key: "zone", value: "west" }),
              new SelfHostedWorkerLabel({ key: "zone", value: "east" }),
            ],
          }),
        } }),
      }),
      "child-shell": new SubagentPersistedState({
        subagentType: new SubagentType({ type: { case: "shell", value: new SubagentTypeShell() } }),
        environment: 91 as never,
        machine: new TargetMachine({ machine: { case: "sameMachine", value: new SameMachineTarget() } }),
      }),
      "child-cloud": new SubagentPersistedState({
        environment: SubagentExecutionEnvironment.CLOUD,
        machine: new TargetMachine({ machine: {
          case: "newCloudVm",
          value: new NewCloudVmTarget({ baseBranch: "main", environmentBuildId: "build-b" }),
        } }),
      }),
      "child-worker": new SubagentPersistedState({
        machine: new TargetMachine({ machine: {
          case: "selfHostedWorker",
          value: new SelfHostedWorkerTarget({ workerId: "worker-b" }),
        } }),
      }),
    },
    selfSummaryCount: 3,
    readPaths: ["/repo/read.ts", "/repo/ spaced.ts "],
    activeBranchName: "feature/checkpoint",
    plans: { "registry-key": new PlanRegistryEntry({ id: "plan-id", path: "/repo/plan.md" }) },
    trackedGitRepoBranches: [new TrackedGitRepo({ repoPath: "/repo", branchName: "feature/checkpoint" })],
    agentType: "assistant",
    communicateUpdateHistory: [new CommunicateUpdateHistoryEntry({ step: "working", messageIndex: 4 })],
    subagentThreads: { "call-a": "thread-a" },
    communicateUpdateFinalSummary: "finished",
    conversationStartedTimestampMs: 1_700_000_000_789n,
    conversationStartedTimeZone: "Asia/Shanghai",
    communicateUpdateCompletedSubtitle: "complete",
    communicateUpdateStatesByParentToolCallId: {
      "call-a": new CommunicateUpdateTurnState({
        history: [new CommunicateUpdateHistoryEntry({ step: "working", messageIndex: 4 })],
        finalSummary: "finished",
        completedSubtitle: "complete",
      }),
    },
    subagentRunsByParentToolCallId: {
      "call-a": new SubagentRunState({
        parentToolCallId: "call-a",
        subagentId: "child-custom",
        environment: 92 as never,
        status: 93 as never,
        title: "Review",
        detail: "Inspecting changes",
        transcriptPath: "/worker/transcript.jsonl",
        outputPath: "/repo/review.md",
        completedTimestampMs: 1_700_000_000_999n,
        completionReason: 94 as never,
      }),
    },
    subagentStateRefs: { "child-blob": new Uint8Array([18, 19]) },
    goalState: new GoalState({
      conversationId: "conversation-1",
      goalId: "goal-1",
      objective: "finish safely",
      status: GoalStatus.ACTIVE,
      idleContinuationsWithoutToolCalls: 2,
      activeDurationMs: 1_000_000_000_000n,
      lastAccruedAtMs: 1_700_000_001_000n,
      continuationCount: 4,
      agentSessionId: "session-1",
    }),
    isRootProjectConversation: false,
    completedAskQuestionToolCallIds: ["question-a", "question-b"],
  })

  const bytes = encodeInteropAgentConversationCheckpoint(state)
  const envelope = deserializeSlateAgentCheckpoint(bytes)
  assert.equal(envelope?.version, 2)
  assert.ok(envelope && envelope.version === 2)
  assert.equal("interopSnapshot" in envelope, false)
  assert.equal(isSlateConversationCheckpointV2(envelope.conversation), true)
  const decoded = decodeInteropAgentConversationCheckpoint(bytes)
  assert.equal(ConversationStateStructure.equals(decoded, state), true)
})

test("Slate checkpoint v2 rejects malformed identifiers and unknown fields instead of dropping them", () => {
  const base = {
    promptMessageBlobIds: [],
    todoBlobIds: [],
    pendingOperationIds: [],
    turnBlobIds: [],
    workspaceUris: [],
    legacyFileContentBlobIds: {},
    summaryArchiveBlobIds: [],
    turnTimings: [],
    fileContentBlobIds: {},
    subagents: {},
    selfSummaryCount: 0,
    readPaths: [],
    planRegistry: {},
    trackedRepositories: [],
    communicationHistory: [],
    subagentThreads: {},
    communicationTurnsByCallId: {},
    subagentRunsByCallId: {},
    subagentStateBlobIds: {},
    completedQuestionCallIds: [],
  }
  assert.equal(isSlateConversationCheckpointV2(base), true)
  assert.equal(isSlateConversationCheckpointV2({ ...base, turnBlobIds: ["0g"] }), false)
  assert.equal(isSlateConversationCheckpointV2({ ...base, foreignField: "not a Slate field" }), false)
})

test("unordered root maps serialize deterministically regardless of insertion order", () => {
  const first = new ConversationStateStructure({
    plans: {
      "z-key": new PlanRegistryEntry({ id: "z", path: "/repo/z.md" }),
      "a-key": new PlanRegistryEntry({ id: "a", path: "/repo/a.md" }),
    },
    subagentThreads: { "z-call": "z-thread", "a-call": "a-thread" },
    subagentStateRefs: { "z-child": new Uint8Array([2]), "a-child": new Uint8Array([1]) },
  })
  const second = new ConversationStateStructure({
    plans: {
      "a-key": new PlanRegistryEntry({ id: "a", path: "/repo/a.md" }),
      "z-key": new PlanRegistryEntry({ id: "z", path: "/repo/z.md" }),
    },
    subagentThreads: { "a-call": "a-thread", "z-call": "z-thread" },
    subagentStateRefs: { "a-child": new Uint8Array([1]), "z-child": new Uint8Array([2]) },
  })
  assert.deepEqual(encodeInteropAgentConversationCheckpoint(first), encodeInteropAgentConversationCheckpoint(second))
})


