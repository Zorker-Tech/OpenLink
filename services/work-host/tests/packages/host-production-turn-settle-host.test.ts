import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { StepTiming } from "../../source/adapters/interop/proto/generated/agent/v1/agent_pb.ts"
import {
  createProductionTurnSettleHost,
  type ProductionTurnSettleRunner,
} from "../../source/host/runner/production-turn-settle-host.ts"

function store(overrides: Record<string, unknown> = {}) {
  const calls: unknown[] = []
  return {
    calls,
    value: {
      async handleCheckpoint(context: unknown, checkpoint: unknown) {
        calls.push(["handleCheckpoint", context, checkpoint])
      },
      getMetadata(key: string) {
        calls.push(["getMetadata", key])
        return "root-blob"
      },
      getBlobStore() {
        calls.push("getBlobStore")
        return "agent-store-blobs"
      },
      ...overrides,
    },
  }
}

describe("the production turn-settle host adapter", () => {
  it("binds the session, store, generation, mirror and profile persistence", async () => {
    const backingStore = store()
    const checkpointState = { summaryArchives: [], turnTimings: [] }
    const profileSnapshot = {
      version: 1 as const,
      profileSection: "profile section",
      systemIdentity: { name: "Ada", description: "writer" },
      announcedIdentity: { name: "Ada", description: "writer" },
      compactionEpoch: 2,
    }
    let localState: unknown
    let persisted: unknown[] = []
    const runner: ProductionTurnSettleRunner = {
      currentRunGeneration: 7,
      getBlobStore: () => "runner-blobs",
      getLatestPromptMessages: () => ["latest-prompt"],
      setAgentConversationStateStructure: (value) => { localState = value },
    }
    const mirror = { prepareCheckpoint: async () => {} } as never
    const host = createProductionTurnSettleHost({
      transcriptId: "agent-1",
      isSharedRoomTurn: true,
      runner,
      agentStore: backingStore.value,
      transcriptMirror: mirror,
      persistAnnouncedAgentProfile: (...args) => { persisted = args },
    })

    assert.equal(host.isSubagentRunner, true)
    assert.equal(host.getTranscriptId(), "agent-1")
    assert.equal(host.getBlobStore(), "runner-blobs")
    assert.equal(host.transcriptMirror, mirror)
    const turnTiming = host.createTurnTiming?.({ timestampMs: 9n, durationMs: 4n })
    assert.ok(turnTiming instanceof StepTiming)
    assert.equal(turnTiming?.timestampMs, 9n)
    assert.equal(turnTiming?.durationMs, 4n)
    assert.equal(host.ownsRunner(), true)
    assert.equal(host.isRunSuperseded(), false)
    runner.currentRunGeneration = 8
    assert.equal(host.isRunSuperseded(), true)
    assert.deepEqual(host.latestPromptMessages(), ["latest-prompt"])
    host.setLocalState(checkpointState)
    assert.equal(localState, checkpointState)
    await host.agentStore()?.handleCheckpoint("context", checkpointState)
    assert.equal(host.agentStore()?.getMetadata("root"), "root-blob")
    host.persistAnnouncedAgentProfile(["snapshots"], profileSnapshot, { name: "Ada", description: "writer" })
    assert.deepEqual(backingStore.calls.slice(0, 2), [
      ["handleCheckpoint", "context", checkpointState],
      ["getMetadata", "root"],
    ])
    assert.deepEqual(persisted, [["snapshots"], profileSnapshot, { name: "Ada", description: "writer" }])
  })

  it("falls back to the Agent store's blob store and returns no messages without a runner", () => {
    const backingStore = store()
    const host = createProductionTurnSettleHost({
      transcriptId: "agent-2",
      isSharedRoomTurn: false,
      runner: undefined,
      agentStore: backingStore.value,
    })

    assert.equal(host.getBlobStore(), "agent-store-blobs")
    assert.deepEqual(host.latestPromptMessages(), [])
    assert.equal(host.isRunSuperseded(), false)
    assert.ok(backingStore.calls.includes("getBlobStore"))
  })

  it("requires the checkpoint store immediately, but checks the local checkpoint writer when used", () => {
    assert.throws(
      () => createProductionTurnSettleHost({
        transcriptId: "agent-3",
        isSharedRoomTurn: false,
        runner: undefined,
        agentStore: {},
      }),
      /checkpoint store is not bound/,
    )

    const host = createProductionTurnSettleHost({
      transcriptId: "agent-3",
      isSharedRoomTurn: false,
      runner: undefined,
      agentStore: store().value,
    })
    assert.throws(() => host.setLocalState({ summaryArchives: [], turnTimings: [] }), /local checkpoint store is not bound/)
  })
})
