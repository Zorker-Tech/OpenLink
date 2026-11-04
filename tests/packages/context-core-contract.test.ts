import assert from "node:assert/strict"
import { test } from "node:test"

import { createContext, createKey, deadlineExceededError } from "../../source/packages/context/context.ts"

test("context values inherit down the chain without leaking between siblings", () => {
  const absent = createKey(Symbol("absent"), "default")
  const override = createKey(Symbol("override"), 0)
  const root = createContext().with(absent, "root")
  const first = root.with(override, 1).withName("first")
  const second = root.with(override, 2).withName("second")

  assert.equal(first.get(absent), "root")
  assert.equal(first.get(override), 1)
  assert.equal(second.get(override), 2)
  assert.equal(root.get(override), 0)
  assert.deepEqual(first.getPath(), ["first"])
  assert.equal(first.getParent()?.get(absent), "root")
})

test("cancellation flows to descendants while a detached context keeps its values", () => {
  const scope = createKey(Symbol("scope"), "unset")
  const [parent, cancel] = createContext().with(scope, "conversation").withCancel()
  const [child] = parent.withCancel()
  const detached = parent.withDetached()

  cancel("user stopped")
  assert.equal(child.canceled, true)
  assert.equal(child.reason, "user stopped")
  assert.equal(detached.canceled, false)
  assert.equal(detached.get(scope), "conversation")
})

test("deadlines name their expiry and explicit cancellation keeps its own reason", async () => {
  const deadline = createContext().withDeadline(new Date(Date.now() - 1))
  assert.equal(deadline.canceled, true)
  assert.equal((deadline.reason as Error).message, deadlineExceededError().message)

  const [timed, cancelTimed] = createContext().withTimeoutAndCancel(10_000)
  cancelTimed("manual stop")
  assert.equal(timed.canceled, true)
  assert.equal(timed.reason, "manual stop")

  const short = createContext().withTimeout(5)
  await new Promise<void>((resolve) => short.signal.addEventListener("abort", () => resolve(), { once: true }))
  assert.equal(short.canceled, true)
  assert.equal((short.reason as Error).message, deadlineExceededError().message)
})
