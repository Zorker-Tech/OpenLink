import assert from "node:assert/strict"
import { test } from "node:test"

import {
  AgentMode,
  CloudSubagentReference,
  ConversationStateStructure,
  SubagentExecutionEnvironment,
  SubagentPersistedState,
  TargetMachine,
  NewCloudVmTarget,
} from "../../source/adapters/interop/proto/generated/agent/v1/agent_pb.ts"
import {
  SubagentType,
  SubagentTypeCustom,
} from "../../source/adapters/interop/proto/generated/agent/v1/subagents_pb.ts"
import {
  createSlateSubagentPersistedStateSerde,
  deserializeSlateSubagentPersistedStateInterop,
} from "../../source/adapters/interop/agent/agent-state-message-serdes-adapter.ts"
import { createSlateSubagentPersistedState } from "../../source/packages/agent/subagent-persisted-state.ts"
import { createSlateSubagentType, SlateSubagentKind } from "../../source/packages/agent/subagent-type.ts"
import { DataClassification, PrivacyCapability } from "../../source/packages/redaction/classification.ts"
import { createRedactedString } from "../../source/packages/redaction/create.ts"
import { PrivacyMode } from "../../source/packages/redaction/privacy-mode.ts"
import { RedactedString } from "../../source/packages/redaction/redacted-values.ts"

const serde = (privacyMode = PrivacyMode.NO_STORAGE) => createSlateSubagentPersistedStateSerde(privacyMode)

test("new subagent state blobs use Slate field names and reapply snapshot privacy", () => {
  const snapshot = {
    privacyMode: PrivacyMode.USAGE_DATA_TRAINING_ALLOWED,
    rootPromptMessagesJson: [new Uint8Array([1, 2])],
    turns: [new Uint8Array([3, 4])],
    todos: [],
    previousWorkspaceUris: [],
    summaryArchives: [],
    fileStatesV2: new Map([[
      "/repo/readme.txt",
      { contentBlobId: new Uint8Array([5]), initialContentBlobId: new Uint8Array([6]) },
    ]]),
    readPaths: ["/repo/readme.txt"],
    tokenDetails: {
      note: createRedactedString("usage detail", DataClassification.CODE, "usage", PrivacyMode.NO_STORAGE),
    },
    conversationStartedTimestampMs: BigInt("9223372036854775807"),
  }
  const state = createSlateSubagentPersistedState({
    conversationSnapshot: snapshot,
    createdAtMs: BigInt(10),
    lastUsedAtMs: BigInt(20),
    subagentType: createSlateSubagentType(SlateSubagentKind.COMPUTER_USE),
    modelId: "model-1",
    executionEnvironment: "cloud",
    cloudAgent: { agentId: "worker-1", transcriptUri: "/repo/transcript.jsonl" },
    firstClassAgentId: "agent-1",
    requestedRuntimeBuildId: "build-1",
    targetMachine: { type: "new_cloud_vm", base_branch: "main", environment_build_id: "build-1" },
  })
  const codec = serde()
  const bytes = codec.serialize(state)
  const json = new TextDecoder().decode(bytes)
  assert.ok(json.startsWith("SLATE-AGENT-SUBAGENT-STATE\n"))
  assert.deepEqual(codec.getBlobType?.(), { kind: "json", typeName: "slate.agent-subagent-state" })
  const stored = JSON.parse(json.slice("SLATE-AGENT-SUBAGENT-STATE\n".length)) as {
    readonly format: string
    readonly version: number
    readonly state: Record<string, unknown>
  }
  assert.equal(stored.format, "slate.agent-subagent-state")
  assert.equal(stored.version, 1)
  assert.equal(stored.state.createdAtMs, "10")
  assert.equal(stored.state.lastUsedAtMs, "20")
  assert.equal(stored.state.executionEnvironment, "cloud")
  assert.deepEqual(stored.state.subagentType, { kind: "computer-use" })
  assert.deepEqual(stored.state.cloudAgent, { agentId: "worker-1", transcriptUri: "/repo/transcript.jsonl" })
  assert.equal("createdTimestampMs" in stored.state, false)
  assert.equal("cloudSubagent" in stored.state, false)

  const restored = codec.deserialize(bytes)
  assert.deepEqual(restored.subagentType, state.subagentType)
  assert.deepEqual(restored.targetMachine, state.targetMachine)
  assert.deepEqual(restored.conversationSnapshot?.turns, snapshot.turns)
  assert.deepEqual(restored.conversationSnapshot?.fileStatesV2.get("/repo/readme.txt"), {
    contentBlobId: new Uint8Array([5]),
    initialContentBlobId: new Uint8Array([6]),
  })
  assert.equal(restored.conversationSnapshot?.conversationStartedTimestampMs, snapshot.conversationStartedTimestampMs)
  const note = restored.conversationSnapshot?.tokenDetails?.note
  assert.ok(note instanceof RedactedString)
  assert.equal(note.__privacyMode, PrivacyMode.NO_STORAGE)
  assert.equal(note.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED), "usage detail")
})

test("legacy subagent blobs upgrade to Slate while preserving enum values and nested unknown fields", () => {
  const nested = new ConversationStateStructure({
    turns: [new Uint8Array([9])],
    mode: 987654 as AgentMode,
  })
  ConversationStateStructure.runtime.bin.onUnknownField(nested, 111, 0, new Uint8Array([2]))
  const type = new SubagentType({ type: { case: "custom", value: new SubagentTypeCustom({ name: "helper" }) } })
  SubagentType.runtime.bin.onUnknownField(type, 112, 0, new Uint8Array([3]))
  const cloudAgent = new CloudSubagentReference({ bcId: "worker-1", transcriptPath: "/tmp/transcript.jsonl" })
  CloudSubagentReference.runtime.bin.onUnknownField(cloudAgent, 113, 0, new Uint8Array([4]))
  const legacy = new SubagentPersistedState({
    conversationState: nested,
    createdTimestampMs: BigInt(30),
    lastUsedTimestampMs: BigInt(40),
    subagentType: type,
    modelId: "model-2",
    environment: 987 as SubagentExecutionEnvironment,
    cloudSubagent: cloudAgent,
    firstClassBcId: "agent-1",
    cloudRequestedEnvironmentBuildId: "build-2",
    machine: new TargetMachine({ machine: { case: "newCloudVm", value: new NewCloudVmTarget({ baseBranch: "main" }) } }),
  })
  SubagentPersistedState.runtime.bin.onUnknownField(legacy, 114, 0, new Uint8Array([5]))

  const codec = serde()
  const imported = codec.deserialize(legacy.toBinary())
  assert.equal(imported.executionEnvironment, "unspecified")
  assert.equal(imported.compatibility?.legacyEnvironmentCode, 987)
  assert.equal(imported.compatibility?.legacyUnknownFields?.length, 4)
  assert.equal(imported.conversationSnapshot?.unknownModeCode, 987654)
  assert.equal(imported.subagentType?.kind, "custom")
  assert.equal(imported.subagentType?.customName, "helper")

  const migrated = codec.serialize(imported)
  assert.ok(new TextDecoder().decode(migrated).startsWith("SLATE-AGENT-SUBAGENT-STATE\n"))
  const runnerView = deserializeSlateSubagentPersistedStateInterop(migrated)
  assert.equal(runnerView.environment, 987)
  assert.equal(runnerView.createdTimestampMs, BigInt(30))
  assert.equal(runnerView.lastUsedTimestampMs, BigInt(40))
  assert.equal(runnerView.conversationState?.mode, 987654)
  assert.equal(runnerView.cloudSubagent?.bcId, "worker-1")
  assert.equal(SubagentPersistedState.runtime.bin.listUnknownFields(runnerView).length, 1)
  assert.equal(ConversationStateStructure.runtime.bin.listUnknownFields(runnerView.conversationState!).length, 1)
  assert.equal(SubagentType.runtime.bin.listUnknownFields(runnerView.subagentType!).length, 1)
  assert.equal(CloudSubagentReference.runtime.bin.listUnknownFields(runnerView.cloudSubagent!).length, 1)
})

test("malformed Slate subagent envelopes are rejected instead of parsed as legacy records", () => {
  assert.throws(
    () => serde().deserialize(new TextEncoder().encode("SLATE-AGENT-SUBAGENT-STATE\n{")),
    /not valid JSON/,
  )
  assert.throws(
    () => serde().deserialize(new TextEncoder().encode("SLATE-AGENT-SUBAGENT-STATE\n{}")),
    /envelope is invalid/,
  )
  assert.throws(
    () => serde().serialize(createSlateSubagentPersistedState({ createdAtMs: -1n })),
    /unsigned 64-bit milliseconds/,
  )
})
