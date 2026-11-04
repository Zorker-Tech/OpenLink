import assert from "node:assert/strict"
import { test } from "node:test"

import { HostExtensions } from "../../source/host/extensions/extension-ids.generated.ts"
import { turnExecutionExtension } from "../../source/host/extensions/turn-execution/extension.ts"
import { TurnExecutionRegistry } from "../../source/host/extensions/turn-execution/turn-execution-service.ts"

test("turn execution registers as a root extension and creates a fresh registry per host", async () => {
  assert.equal(turnExecutionExtension.kind, "host-extension")
  assert.equal(turnExecutionExtension.id, HostExtensions.TurnExecution)
  assert.deepEqual(turnExecutionExtension.dependencies, [])

  const startContext = { deps: {}, host: {}, onStop: () => {} }
  const first = await turnExecutionExtension.start(startContext)
  const second = await turnExecutionExtension.start(startContext)

  assert.equal(first instanceof TurnExecutionRegistry, true)
  assert.equal(second instanceof TurnExecutionRegistry, true)
  assert.notEqual(first, second)
  assert.equal(first.canExecute, false)
  assert.equal(second.canExecute, false)
})
