import assert from "node:assert/strict"
import { test } from "node:test"

import { createContext } from "../../source/packages/context/context.ts"
import { HistoryVisibilityMode } from "../../source/adapters/interop/agent/conversation-message-trace-adapter.ts"
import { createProductionBindingProviders, productionSecretsContext } from "../../source/host/production-binding-providers.ts"

test("production binding providers preserve the secrets context factory", () => {
  const createSecretsContext = createContext
  const providers = createProductionBindingProviders({
    createSecretsContext,
    getAgentsRootDir: () => "/agents",
    readDbBytes: () => null,
    checkpointDb: () => false,
    convertConversationMessagesToTrace: () => [],
  })

  assert.equal(providers.secretsContext, createSecretsContext)
  assert.equal(productionSecretsContext, createContext)
})

test("state-backstop bindings capture the root and forward each database path with the checkpoint port", () => {
  const roots = ["/agents/first", "/agents/second"]
  const checkpointCalls: string[] = []
  const readCalls: Array<{ readonly path: string; readonly checkpoint: (path: string) => void }> = []
  const checkpointDb = (path: string) => {
    checkpointCalls.push(path)
    return true
  }
  const bytes = Buffer.from([4, 2])
  const providers = createProductionBindingProviders({
    createSecretsContext: createContext,
    getAgentsRootDir: () => roots.shift()!,
    readDbBytes: (path, checkpoint) => {
      readCalls.push({ path, checkpoint })
      checkpoint(path)
      return bytes
    },
    checkpointDb,
    convertConversationMessagesToTrace: () => [],
  })

  const first = providers.createStateBackstop()
  const second = providers.createStateBackstop()

  assert.equal(first.agentsRootDir, "/agents/first")
  assert.equal(second.agentsRootDir, "/agents/second")
  assert.equal(first.readDbBytes("/agents/first/a/store.db"), bytes)
  assert.equal(second.readDbBytes("/agents/second/b/store.db"), bytes)
  assert.deepEqual(readCalls, [
    { path: "/agents/first/a/store.db", checkpoint: checkpointDb },
    { path: "/agents/second/b/store.db", checkpoint: checkpointDb },
  ])
  assert.deepEqual(checkpointCalls, ["/agents/first/a/store.db", "/agents/second/b/store.db"])
})

test("cloud conversation traces always use no-preamble visibility and return the adapter result", () => {
  const conversation = { messages: ["human turn"] }
  const trace = [{ role: "user", content: "human turn" }]
  const calls: Array<{ readonly conversation: unknown; readonly mode: HistoryVisibilityMode }> = []
  const providers = createProductionBindingProviders({
    createSecretsContext: createContext,
    getAgentsRootDir: () => "/agents",
    readDbBytes: () => null,
    checkpointDb: () => false,
    convertConversationMessagesToTrace: (input, mode) => {
      calls.push({ conversation: input, mode })
      return trace
    },
  })

  assert.equal(providers.convertCloudAgentConversationToTrace(conversation), trace)
  assert.deepEqual(calls, [{ conversation, mode: HistoryVisibilityMode.NO_PREAMBLE }])
})
