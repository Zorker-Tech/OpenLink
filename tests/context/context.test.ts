import { test } from "node:test"
import assert from "node:assert/strict"

import { createContext, createKey, type Context } from "../../source/packages/context/context.ts"

const numberKey = createKey(Symbol("number"), 0)
const textKey = createKey(Symbol("text"), "unset")

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** Resolves once the context is canceled, at the latest after `budgetMs`. */
function canceled(context: Context, budgetMs = 200): Promise<void> {
  if (context.canceled) return Promise.resolve()
  return new Promise(resolve => {
    context.signal.addEventListener("abort", () => resolve(), { once: true })
    setTimeout(() => resolve(), budgetMs)
  })
}

test("values are inherited by descendants and invisible to siblings", () => {
  const root = createContext()
  const child = root.with(numberKey, 1)
  const grandchild = child.with(textKey, "two")

  assert.equal(root.get(numberKey), 0, "the root keeps the declared default")
  assert.equal(child.get(numberKey), 1)
  assert.equal(child.get(textKey), "unset")
  assert.equal(grandchild.get(numberKey), 1, "values travel down the chain")
  assert.equal(grandchild.get(textKey), "two")

  const sibling = root.with(textKey, "sibling")
  assert.equal(sibling.get(numberKey), 0, "a sibling does not see its sibling's values")
  assert.equal(sibling.get(textKey), "sibling")
})

test("a value set to undefined shadows the declared default", () => {
  const optionalKey = createKey<string | undefined>(Symbol("optional"), "declared default")
  const root = createContext()
  const child = root.with(optionalKey, undefined)

  assert.equal(child.get(optionalKey), undefined, "an explicit undefined is a value, not an absence")
  assert.equal(root.get(optionalKey), "declared default")
  assert.equal(child.with(numberKey, 1).get(optionalKey), undefined, "and it stays shadowed below")
})

test("canceling a child leaves its ancestors untouched and aborts its descendants", async () => {
  const root = createContext()
  const [child, cancel] = root.withCancel()
  const grandchild = child.with(numberKey, 5)
  const reason = new Error("client went away")

  cancel(reason)
  await canceled(child)

  assert.equal(child.canceled, true)
  assert.equal(child.reason, reason)
  assert.equal(grandchild.canceled, true, "cancellation propagates downwards")
  assert.equal(grandchild.reason, reason, "the reason is carried with it")
  assert.equal(root.canceled, false, "the parent is unaffected")
})

test("canceling an ancestor aborts children that already exist", async () => {
  const root = createContext()
  const [parent, cancelParent] = root.withCancel()
  const child = parent.withCancel()[0]
  const reason = new Error("shutting down")

  assert.equal(child.canceled, false)
  cancelParent(reason)
  await canceled(child)

  assert.equal(child.canceled, true)
  assert.equal(child.reason, reason)
})

test("a child created under a canceled context starts canceled with the same reason", () => {
  const root = createContext()
  const [parent, cancelParent] = root.withCancel()
  const reason = new Error("already gone")
  cancelParent(reason)

  const late = parent.with(numberKey, 1)
  assert.equal(late.canceled, true)
  assert.equal(late.reason, reason)
  assert.equal(late.get(numberKey), 1, "values still resolve")
})

test("a timeout aborts with the deadline error once the budget passes", async () => {
  const root = createContext()
  const timed = root.withTimeout(10)
  const child = timed.with(numberKey, 1)

  assert.equal(timed.canceled, false)
  await canceled(timed)
  assert.equal(timed.canceled, true)
  assert.ok(timed.reason instanceof Error)
  assert.equal((timed.reason as Error).message, "context deadline exceeded")
  assert.equal(child.canceled, true)
})

test("a canceled timeout clears its timer instead of firing later", async () => {
  const root = createContext()
  const [timed, cancel] = root.withTimeoutAndCancel(10)
  const reason = new Error("done early")
  let clears = 0
  const realClearTimeout = globalThis.clearTimeout
  globalThis.clearTimeout = ((handle: Parameters<typeof clearTimeout>[0]) => {
    clears += 1
    return realClearTimeout(handle)
  }) as typeof clearTimeout
  try {
    cancel(reason)
    await canceled(timed)
    await delay(30)
  } finally {
    globalThis.clearTimeout = realClearTimeout
  }

  assert.equal(clears, 1, "the pending timer was cleared when the context was canceled")
  assert.equal(timed.reason, reason, "the deadline never overwrote the cancel reason")
})

test("a deadline in the past is already canceled, in the future it behaves like a timeout", async () => {
  const root = createContext()
  const expired = root.withDeadline(new Date(Date.now() - 1_000))
  assert.equal(expired.canceled, true)
  assert.equal((expired.reason as Error).message, "context deadline exceeded")

  const soon = root.withDeadline(new Date(Date.now() + 10))
  assert.equal(soon.canceled, false)
  await canceled(soon)
  assert.equal(soon.canceled, true)
})

test("withTimeoutAndCancel cancels through both paths", async () => {
  const root = createContext()
  const [byTimer] = root.withTimeoutAndCancel(10)
  await canceled(byTimer)
  assert.equal((byTimer.reason as Error).message, "context deadline exceeded")

  const [byCancel, cancel] = root.withTimeoutAndCancel(5_000)
  cancel("stop")
  await canceled(byCancel)
  assert.equal(byCancel.reason, "stop")
})

test("a detached child keeps values but drops cancellation", async () => {
  const root = createContext()
  const [parent, cancelParent] = root.withCancel()
  const child = parent.with(numberKey, 7)
  const detached = child.withDetached()

  assert.equal(detached.get(numberKey), 7, "values survive detachment")
  cancelParent(new Error("parent canceled"))
  await canceled(parent)
  await delay(5)
  assert.equal(detached.canceled, false, "detached work is not canceled with its parent")
  assert.equal(detached.getParent(), child, "the chain is still readable")
})

test("getPath lists names root first and skips unnamed steps", () => {
  const root = createContext().withName("run")
  const named = root.with(numberKey, 1).withName("step").withName("").withDetached()
  assert.deepEqual(named.getPath(), ["run", "step"])
  assert.deepEqual(createContext().getPath(), [])
})

test("a named context stays usable and cancelable", async () => {
  const root = createContext()
  const named = root.withName("agent-turn")
  const [child, cancel] = named.withCancel()

  assert.equal(named.name, "agent-turn")
  assert.deepEqual(child.getPath(), ["agent-turn"])
  cancel()
  await canceled(child)
  assert.equal(named.canceled, false)
})
