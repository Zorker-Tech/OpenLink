import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, it } from "node:test"

import {
  automationStoreForDbPath,
  channelStoreForDbPath,
  createUnavailableMemoryStore,
  NO_SESSION_MEMORY,
  workflowStoreForDbPath,
} from "../../source/host/extensions/session/session-store-factories.ts"

describe("session store factories", () => {
  it("provides empty memory operations when a session has no memory store", () => {
    const memory = createUnavailableMemoryStore()
    assert.deepEqual(memory.recall(), { profile: [], recent: [] })
    assert.deepEqual(memory.listMemories(), [])
    assert.equal(memory.addMemory(), null)
    assert.equal(memory.removeMemoryByContent(), false)
    assert.equal(memory.getLocation(), null)
    assert.equal(memory.setOnChange(), undefined)
    assert.equal(memory.removeMemory(), false)
    assert.equal(memory.clearMemories(), undefined)
    assert.equal(NO_SESSION_MEMORY.agentHasContent(), false)
    assert.deepEqual(NO_SESSION_MEMORY.createAgentStore().recall(), { profile: [], recent: [] })
  })

  it("anchors agent stores beside the database and the shared workflow library at the Slate root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "slate-session-store-factories-"))
    try {
      const agentDirectory = path.join(root, "agents", "agent-1")
      const databasePath = path.join(agentDirectory, "store.db")
      const automations = automationStoreForDbPath(databasePath)
      const channels = channelStoreForDbPath(databasePath)
      const workflows = workflowStoreForDbPath(databasePath)

      assert.equal(automations.automationsDir, path.join(agentDirectory, "automations"))
      assert.equal(channels.channelsDir, path.join(agentDirectory, "channels"))
      assert.equal(workflows.agentDir, agentDirectory)
      assert.equal(workflows.automations.automationsDir, path.join(agentDirectory, "automations"))
      assert.equal(workflows.library.getLocation(), path.join(root, "workflows"))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
