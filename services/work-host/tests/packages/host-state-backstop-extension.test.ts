import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { HostExtensions } from "../../source/host/extensions/extension-ids.generated.ts"
import { createStateBackstopExtension } from "../../source/host/extensions/state-backstop/extension.ts"

describe("state backstop extension", () => {
  it("returns inert operations when the feature switch is off", async () => {
    const extension = createStateBackstopExtension({
      agentsRootDir: "/agents",
      readDbBytes: () => { throw new Error("disabled backstop must not read files") },
    }, { SLATE_STATE_S3_BACKSTOP: "false" })
    const api = extension.start({ deps: {}, host: { log: () => {} }, onStop: () => {} } as never) as {
      isEnabled: boolean
      scheduleSnapshot(agentId: string): void
      snapshotNow(agentId: string): Promise<unknown>
      readSnapshot(agentId: string): Promise<Uint8Array | null>
    }

    assert.equal(api.isEnabled, false)
    api.scheduleSnapshot("agent-1")
    assert.deepEqual(await api.snapshotNow("agent-1"), { status: "skipped", reason: "backstop disabled" })
    assert.equal(await api.readSnapshot("agent-1"), null)
  })

  it("wires the host object store, source map, snapshot reader and stop lifecycle", async () => {
    const stored = new Map<string, Uint8Array>()
    const sourceIds: string[] = []
    const stopHandlers: Array<() => void | Promise<void>> = []
    const messages: string[] = []
    const objectStore = {
      put: async (key: string, bytes: Uint8Array) => { stored.set(key, new Uint8Array(bytes)) },
      get: async (key: string) => stored.get(key) ?? null,
    }
    const extension = createStateBackstopExtension({
      agentsRootDir: "/agents",
      readDbBytes: (path) => path === "/agents/agent-1/store.db" ? new Uint8Array([1, 2, 3]) : null,
    }, { SLATE_STATE_S3_BACKSTOP: "1" })

    assert.deepEqual(extension.dependencies, [HostExtensions.BoxStoreSync, HostExtensions.SourceMap])
    const api = extension.start({
      deps: {
        [HostExtensions.BoxStoreSync]: { objectStoreProvider: { forStore: (sourceId: string) => { sourceIds.push(sourceId); return objectStore } } },
        [HostExtensions.SourceMap]: { getOrCreate: async (agentId: string) => ({ sourceId: `source:${agentId}` }) },
      },
      host: { log: (message: string) => { messages.push(message) } },
      onStop: (stop: () => void | Promise<void>) => { stopHandlers.push(stop) },
    } as never) as {
      isEnabled: boolean
      scheduleSnapshot(agentId: string): void
      snapshotNow(agentId: string): Promise<unknown>
      readSnapshot(agentId: string): Promise<Uint8Array | null>
    }

    assert.equal(api.isEnabled, true)
    assert.deepEqual(messages, ["SlateState S3 backstop enabled"])
    assert.deepEqual(await api.snapshotNow("agent-1"), { status: "uploaded", bytes: 3 })
    assert.deepEqual([...stored.keys()], ["state/store.db"])
    assert.deepEqual(sourceIds, ["source:agent-1"])
    assert.deepEqual([...await api.readSnapshot("agent-1") ?? []], [1, 2, 3])
    assert.deepEqual(sourceIds, ["source:agent-1", "source:agent-1"])
    assert.equal(stopHandlers.length, 1)
    await stopHandlers[0]?.()
  })
})
