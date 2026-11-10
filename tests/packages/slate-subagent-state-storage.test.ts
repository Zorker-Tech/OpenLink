import assert from "node:assert/strict"
import { test } from "node:test"

import { createSlateSubagentPersistedStateSerde } from "../../source/adapters/interop/agent/agent-state-message-serdes-adapter.ts"
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
      usedTokens: 0,
      maximumTokens: 0,
      compatibility: {
        legacyFields: {
          note: createRedactedString("usage detail", DataClassification.CODE, "usage", PrivacyMode.NO_STORAGE),
        },
      },
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
    targetMachine: { kind: "cloud-machine", baseBranch: "main", environmentBuildId: "build-1" },
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
  assert.equal(stored.version, 2)
  assert.equal(stored.state.createdAtMs, "10")
  assert.equal(stored.state.lastUsedAtMs, "20")
  assert.equal(stored.state.executionEnvironment, "cloud")
  assert.deepEqual(stored.state.subagentType, { kind: "computer-use" })
  assert.deepEqual(stored.state.cloudAgent, { agentId: "worker-1", transcriptUri: "/repo/transcript.jsonl" })
  assert.deepEqual(stored.state.targetMachine, {
    kind: "cloud-machine",
    baseBranch: "main",
    environmentBuildId: "build-1",
  })
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
  const note = restored.conversationSnapshot?.tokenDetails?.compatibility?.legacyFields?.note
  assert.ok(note instanceof RedactedString)
  assert.equal(note.__privacyMode, PrivacyMode.NO_STORAGE)
  assert.equal(note.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED), "usage detail")
})

test("legacy loose token fields migrate into the Slate compatibility area without loss", () => {
  const codec = serde()
  const bytes = codec.serialize(createSlateSubagentPersistedState({
    conversationSnapshot: {
      privacyMode: PrivacyMode.NO_STORAGE,
      rootPromptMessagesJson: [],
      turns: [],
      todos: [],
      previousWorkspaceUris: [],
      summaryArchives: [],
      fileStatesV2: new Map(),
      readPaths: [],
    },
  }))
  const prefix = "SLATE-AGENT-SUBAGENT-STATE\n"
  const envelope = JSON.parse(new TextDecoder().decode(bytes.subarray(prefix.length))) as {
    state: { conversationSnapshot: { kind: string; entries: [string, unknown][] } }
  }
  envelope.state.conversationSnapshot.entries.push(["tokenDetails", {
    kind: "object",
    entries: [["note", {
      kind: "redacted-string",
      rawText: "legacy usage detail",
      classification: DataClassification.CODE,
      fieldName: "usage",
    }]],
  }])

  const restored = codec.deserialize(new TextEncoder().encode(`${prefix}${JSON.stringify(envelope)}`))
  const tokenDetails = restored.conversationSnapshot?.tokenDetails
  assert.equal(tokenDetails?.usedTokens, 0)
  assert.equal(tokenDetails?.maximumTokens, 0)
  const note = tokenDetails?.compatibility?.legacyFields?.note
  assert.ok(note instanceof RedactedString)
  assert.equal(note.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED), "legacy usage detail")
})

test("Slate subagent state v1 placement migrates to the Slate v2 vocabulary", () => {
  const legacyEnvelope = {
    format: "slate.agent-subagent-state",
    version: 1,
    state: {
      createdAtMs: "10",
      lastUsedAtMs: "20",
      executionEnvironment: "cloud",
      targetMachine: {
        type: "new_cloud_vm",
        base_branch: "release",
        environment_build_id: "build-4",
      },
    },
  }
  const legacyBytes = new TextEncoder().encode(`SLATE-AGENT-SUBAGENT-STATE\n${JSON.stringify(legacyEnvelope)}`)
  const codec = serde()
  const imported = codec.deserialize(legacyBytes)

  assert.deepEqual(imported.targetMachine, {
    kind: "cloud-machine",
    baseBranch: "release",
    environmentBuildId: "build-4",
  })
  const rewritten = JSON.parse(new TextDecoder().decode(codec.serialize(imported)).slice("SLATE-AGENT-SUBAGENT-STATE\n".length)) as {
    readonly version: number
    readonly state: { readonly targetMachine?: unknown }
  }
  assert.equal(rewritten.version, 2)
  assert.deepEqual(rewritten.state.targetMachine, {
    kind: "cloud-machine",
    baseBranch: "release",
    environmentBuildId: "build-4",
  })
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
