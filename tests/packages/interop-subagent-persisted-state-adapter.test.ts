import { test } from "node:test"
import assert from "node:assert/strict"

import {
  AgentMode,
  CloudSubagentReference,
  FileStateStructure,
  NewCloudVmTarget,
  SubagentExecutionEnvironment,
  SubagentPersistedState,
  TargetMachine,
} from "../../source/adapters/interop/proto/generated/agent/v1/agent_pb.ts"
import {
  SubagentType,
  SubagentTypeUnspecified,
} from "../../source/adapters/interop/proto/generated/agent/v1/subagents_pb.ts"
import {
  fromInteropSubagentPersistedState,
  toInteropSubagentPersistedState,
} from "../../source/adapters/interop/agent/subagent-persisted-state-adapter.ts"
import { ConversationStateStructure } from "../../source/adapters/interop/proto/generated/agent/v1/agent_pb.ts"
import { SlateMode } from "../../source/packages/agent/mode-processing.ts"
import { PrivacyMode } from "../../source/packages/redaction/privacy-mode.ts"

test("a persisted subagent round-trips through Slate metadata and its conversation snapshot", () => {
  const type = new SubagentType({ type: { case: "unspecified", value: new SubagentTypeUnspecified({}) } })
  const wire = new SubagentPersistedState({
    conversationState: new ConversationStateStructure({
      turns: [new Uint8Array([1, 2])],
      mode: AgentMode.PLAN,
      activeBranchName: "feature/slate",
      readPaths: ["/repo/read.ts", "/repo/ spaced.ts "],
      fileStatesV2: {
        "/repo/file.ts": new FileStateStructure({
          content: new Uint8Array([3, 4]),
          initialContent: new Uint8Array([5, 6]),
        }),
      },
      selfSummaryCount: 2,
    }),
    createdTimestampMs: BigInt(10),
    lastUsedTimestampMs: BigInt(20),
    subagentType: type,
    modelId: "model-1",
    environment: SubagentExecutionEnvironment.CLOUD,
    cloudSubagent: new CloudSubagentReference({
      bcId: "worker-1",
      transcriptPath: "/repo/transcript.jsonl",
    }),
    firstClassBcId: "worker-1",
    cloudRequestedEnvironmentBuildId: "build-1",
    machine: new TargetMachine({
      machine: {
        case: "newCloudVm",
        value: new NewCloudVmTarget({ baseBranch: "main" }),
      },
    }),
  })

  const slate = fromInteropSubagentPersistedState(wire, PrivacyMode.NO_STORAGE)
  assert.deepEqual(slate.conversationSnapshot?.turns, [new Uint8Array([1, 2])])
  assert.equal(slate.conversationSnapshot?.mode, SlateMode.PLAN)
  assert.equal(slate.conversationSnapshot?.privacyMode, PrivacyMode.NO_STORAGE)
  assert.equal(slate.conversationSnapshot?.activeBranchName, "feature/slate")
  assert.deepEqual(slate.conversationSnapshot?.readPaths, ["/repo/read.ts", "/repo/ spaced.ts "])
  assert.deepEqual(slate.conversationSnapshot?.fileStatesV2.get("/repo/file.ts"), {
    contentBlobId: new Uint8Array([3, 4]),
    initialContentBlobId: new Uint8Array([5, 6]),
  })
  assert.equal(slate.conversationSnapshot?.selfSummaryCount, 2)
  assert.equal(slate.createdAtMs, BigInt(10))
  assert.equal(slate.lastUsedAtMs, BigInt(20))
  assert.equal(slate.subagentType?.kind, "general-purpose")
  assert.equal(slate.subagentType?.compatibility?.legacyDiscriminator, "unspecified")
  assert.equal(slate.modelId, "model-1")
  assert.equal(slate.executionEnvironment, "cloud")
  assert.deepEqual(slate.cloudAgent, {
    agentId: "worker-1",
    transcriptUri: "/repo/transcript.jsonl",
  })
  assert.equal(slate.firstClassAgentId, "worker-1")
  assert.equal(slate.requestedRuntimeBuildId, "build-1")
  assert.deepEqual(slate.targetMachine, {
    kind: "cloud-machine",
    baseBranch: "main",
  })

  const interop = toInteropSubagentPersistedState(slate)
  assert.ok(interop.conversationState)
  assert.equal(ConversationStateStructure.equals(interop.conversationState, wire.conversationState), true)
  assert.equal(SubagentPersistedState.equals(interop, wire), true)
})

test("an unknown mode nested in a subagent snapshot keeps its source enum value", () => {
  const unknownMode = 987654 as AgentMode
  const slate = fromInteropSubagentPersistedState(new SubagentPersistedState({
    conversationState: new ConversationStateStructure({ mode: unknownMode }),
  }))

  assert.equal(slate.conversationSnapshot?.mode, SlateMode.UNSPECIFIED)
  assert.equal(toInteropSubagentPersistedState(slate).conversationState?.mode, AgentMode.UNSPECIFIED)
})
