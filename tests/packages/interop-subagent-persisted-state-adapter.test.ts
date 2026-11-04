import { test } from "node:test"
import assert from "node:assert/strict"

import {
  AgentMode,
  CloudSubagentReference,
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

test("a persisted subagent round-trips through Slate metadata and its opaque conversation snapshot", () => {
  const type = new SubagentType({ type: { case: "unspecified", value: new SubagentTypeUnspecified({}) } })
  const wire = new SubagentPersistedState({
    conversationState: new ConversationStateStructure({
      turns: [new Uint8Array([1, 2])],
      mode: AgentMode.PLAN,
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

  const slate = fromInteropSubagentPersistedState(wire)
  assert.deepEqual(slate.conversationState?.turns, [new Uint8Array([1, 2])])
  assert.equal((slate.conversationState as { mode?: unknown }).mode, AgentMode.PLAN)
  assert.equal(slate.createdTimestampMs, BigInt(10))
  assert.equal(slate.lastUsedTimestampMs, BigInt(20))
  assert.equal(slate.subagentType?.type.case, "unspecified")
  assert.equal(slate.modelId, "model-1")
  assert.equal(slate.environment, "cloud")
  assert.deepEqual(slate.cloudSubagent, {
    bcId: "worker-1",
    transcriptPath: "/repo/transcript.jsonl",
  })
  assert.equal(slate.firstClassBcId, "worker-1")
  assert.equal(slate.cloudRequestedEnvironmentBuildId, "build-1")
  assert.deepEqual(slate.machine, {
    type: "new_cloud_vm",
    base_branch: "main",
  })

  assert.equal(SubagentPersistedState.equals(toInteropSubagentPersistedState(slate), wire), true)
})
