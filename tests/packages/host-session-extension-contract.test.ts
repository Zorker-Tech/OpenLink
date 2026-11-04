import assert from "node:assert/strict"
import { test } from "node:test"

import type { SlateAgentSessionStore } from "../../source/host/extensions/session/agent-session.ts"
import type { BoxHandoffDeps } from "../../source/host/extensions/session/box-handoff-service.ts"
import {
  conversationHardLimitBytes,
  conversationSoftLimitBytes,
  pinConversationGc,
  pinConversationSizeLimitsReader,
} from "../../source/host/extensions/session/conversation-size-limits.ts"
import { sessionExtension } from "../../source/host/extensions/session/extension.ts"
import { pinLegacyStoreBlobRetirement, pinStaleRootGc } from "../../source/host/extensions/session/session-maintenance.ts"
import type { SessionExtensionContext } from "../../source/host/extensions/session/session-extension-contracts.ts"

test("the session extension wires host settings, maintenance gates, handoff and store shutdown", async () => {
  let timeZone: string | undefined = "Europe/Paris"
  let storeClosed = 0
  const store = { closeWorkerPool: async () => { storeClosed += 1 } } as unknown as SlateAgentSessionStore
  const timeZoneReaders: Array<() => string | undefined> = []
  const bootGateListeners: Array<{ name: string; listener: (enabled: boolean) => void }> = []
  const configReads: string[] = []
  const stopHandlers: Array<() => void | Promise<void>> = []
  const startedEvents: Array<{ agentId: string; instruction: string }> = []
  const endedEvents: Array<{ agentId: string; requestId: string; resolution: string; trigger: string }> = []

  const context: SessionExtensionContext = {
    rootDir: "/profile",
    getTranscriptsDir: () => "/profile/transcripts",
    deps: {
      settings: { getUserTimeZone: () => timeZone },
      experiments: {
        pinGateOnAuthenticatedBootstrap: (name, listener) => bootGateListeners.push({ name, listener }),
        getDynamicConfig: name => {
          configReads.push(name)
          return { soft_limit_mb: 11, hard_limit_mb: 22 }
        },
      },
    },
    createStore: readTimeZone => {
      timeZoneReaders.push(readTimeZone)
      return store
    },
    createHandoffDeps: (): BoxHandoffDeps => ({
      onStarted: event => startedEvents.push(event),
      onEnded: event => { endedEvents.push(event) },
    }),
    onStop: stop => stopHandlers.push(stop),
  }

  assert.equal(sessionExtension.id, "session")
  assert.deepEqual(sessionExtension.dependencies, ["experiments", "forever-box", "settings", "telemetry"])
  const api = sessionExtension.start(context)

  assert.equal(api.store, store)
  assert.equal(timeZoneReaders.length, 1)
  assert.equal(timeZoneReaders[0]?.(), "Europe/Paris")
  timeZone = "Asia/Shanghai"
  assert.equal(timeZoneReaders[0]?.(), "Asia/Shanghai", "the store resolves the current setting when asked")
  assert.equal(api.transcriptsDir(), "/profile/transcripts")
  assert.equal(api.conversationBlobsPath("/profile/agents/a/session.db"), "/profile/agents/a/conversation-blobs.db")

  assert.deepEqual(bootGateListeners.map(({ name }) => name), [
    "slate_stale_root_gc",
    "slate_legacy_store_blob_retirement",
    "slate_conversation_gc",
  ])
  assert.deepEqual(bootGateListeners.map(({ listener }) => listener), [
    pinStaleRootGc,
    pinLegacyStoreBlobRetirement,
    pinConversationGc,
  ])

  try {
    assert.equal(conversationSoftLimitBytes({}), 11 * 1024 * 1024)
    assert.equal(conversationHardLimitBytes({}), 22 * 1024 * 1024)
    assert.deepEqual(configReads, ["slate_conversation_size_limits", "slate_conversation_size_limits"])
  } finally {
    pinConversationSizeLimitsReader(null)
  }

  const handoff = api.startHandoff({ agentId: "agent-1", instruction: "Please review this change" })
  if (handoff.kind !== "started") throw new Error("expected the first handoff to start")
  assert.deepEqual(startedEvents, [{ agentId: "agent-1", instruction: "Please review this change" }])
  assert.deepEqual(api.pendingHandoff("agent-1"), {
    requestId: handoff.requestId,
    instruction: "Please review this change",
  })
  await api.endHandoff("agent-1", "returned-to-user")
  assert.deepEqual(endedEvents, [{
    agentId: "agent-1",
    requestId: handoff.requestId,
    resolution: "completed",
    trigger: "returned-to-user",
  }])
  assert.equal(api.pendingHandoff("agent-1"), null)
  api.forgetHandoff("agent-1")

  assert.equal(stopHandlers.length, 1)
  await stopHandlers[0]?.()
  assert.equal(storeClosed, 1)
})
