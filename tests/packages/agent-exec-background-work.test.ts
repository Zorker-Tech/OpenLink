import { test } from "node:test"
import assert from "node:assert/strict"

import { InMemoryBackgroundWorkRegistry, LEGACY_LOCAL_WAKEUP_CONVERSATION_ID } from "../../source/packages/agent-exec/background-work-registry.ts"
import { mergeWakeup, type Wakeup } from "../../source/packages/agent-exec/wakeup/index.ts"

// ---------------------------------------------------------------------------------------------
// merging wakeups into a queue
// ---------------------------------------------------------------------------------------------

const wakeup = (conversationId: string, id: string, groupKey?: string): Wakeup =>
  ({ conversationId, id, ...(groupKey === undefined ? {} : { groupKey }) })

test("the same work in the same conversation is one wakeup", () => {
  const queue = [wakeup("conversation-1", "task-1")]
  const merged = mergeWakeup(queue, wakeup("conversation-1", "task-1"))
  assert.deepEqual(merged.queue, queue)
  assert.equal(merged.replaced, undefined)
  // The queue is replaced rather than changed, since the caller may still be holding the one it passed.
  assert.notEqual(merged.queue, queue)
})

test("the same work in another conversation is another wakeup", () => {
  const merged = mergeWakeup([wakeup("conversation-1", "task-1")], wakeup("conversation-2", "task-1"))
  assert.equal(merged.queue.length, 2)
})

test("a wakeup with no group is added", () => {
  const merged = mergeWakeup<Wakeup>([], wakeup("conversation-1", "task-1"))
  assert.equal(merged.queue.length, 1)
  assert.equal(merged.replaced, undefined)
})

test("a wakeup with a group replaces the one waiting for that group", () => {
  const previous = wakeup("conversation-1", "task-1", "progress")
  const merged = mergeWakeup([previous, wakeup("conversation-1", "task-2")], wakeup("conversation-1", "task-3", "progress"))
  assert.deepEqual(merged.queue.map(entry => entry.id), ["task-3", "task-2"])
  assert.equal(merged.replaced, previous)
})

test("a group nobody is waiting for is added", () => {
  const merged = mergeWakeup([wakeup("conversation-1", "task-1")], wakeup("conversation-1", "task-2", "progress"))
  assert.deepEqual(merged.queue.map(entry => entry.id), ["task-1", "task-2"])
})

test("a group in another conversation does not replace this one", () => {
  const merged = mergeWakeup([wakeup("conversation-1", "task-1", "progress")], wakeup("conversation-2", "task-2", "progress"))
  assert.equal(merged.queue.length, 2)
})

test("the queue keeps its own copy of the wakeup it was given", () => {
  const incoming = { ...wakeup("conversation-1", "task-1"), payload: "first" }
  const merged = mergeWakeup<typeof incoming>([], incoming)
  incoming.payload = "changed"
  assert.equal(merged.queue[0]?.payload, "first")
})

// ---------------------------------------------------------------------------------------------
// the work a session is running
// ---------------------------------------------------------------------------------------------

test("work is listed with what a caller needs to decide about it", () => {
  const registry = new InMemoryBackgroundWorkRegistry()
  registry.upsertWork({ id: "task-1", kind: "shell", state: "running", ownerId: "conversation-1", metadata: { command: "npm test" } })
  registry.upsertWork({ id: "task-2", kind: "subagent", state: "completed", ownerId: "conversation-2" })
  assert.deepEqual(registry.listWork().map(work => work.id), ["task-1", "task-2"])
  assert.deepEqual(registry.listWork({ kind: "shell" }).map(work => work.id), ["task-1"])
  assert.deepEqual(registry.listWork({ state: "completed" }).map(work => work.id), ["task-2"])
  assert.deepEqual(registry.listWork({ ownerId: "conversation-1" }).map(work => work.id), ["task-1"])
  assert.deepEqual(registry.listWork({ kind: "shell", state: "completed" }), [])
  assert.deepEqual(registry.listWork()[0]?.metadata, { command: "npm test" })
})

test("a snapshot says whether work can be stopped", () => {
  const registry = new InMemoryBackgroundWorkRegistry()
  registry.upsertWork({ id: "task-1", kind: "shell", state: "running", abort: () => {} })
  registry.upsertWork({ id: "task-2", kind: "shell", state: "running" })
  assert.deepEqual(registry.listWork().map(work => work.hasAbort), [true, false])
})

test("only running work counts as running", () => {
  const registry = new InMemoryBackgroundWorkRegistry()
  registry.upsertWork({ id: "task-1", kind: "shell", state: "completed" })
  assert.equal(registry.hasRunningWork(), false)
  registry.upsertWork({ id: "task-2", kind: "subagent", state: "running" })
  assert.equal(registry.hasRunningWork(), true)
  assert.equal(registry.hasRunningWork({ kind: "shell" }), false)
  assert.equal(registry.hasRunningWork({ kind: "subagent" }), true)
})

test("work that is upserted again replaces what was known about it", () => {
  const registry = new InMemoryBackgroundWorkRegistry()
  registry.upsertWork({ id: "task-1", kind: "shell", state: "running" })
  registry.upsertWork({ id: "task-1", kind: "shell", state: "completed" })
  assert.deepEqual(registry.listWork().map(work => work.state), ["completed"])
})

test("stopping work runs its own abort and forgets it", () => {
  const registry = new InMemoryBackgroundWorkRegistry()
  let aborted = 0
  registry.upsertWork({ id: "task-1", kind: "shell", state: "running", abort: () => { aborted++ } })
  assert.equal(registry.abortWork("task-1"), true)
  assert.equal(aborted, 1)
  assert.deepEqual(registry.listWork(), [])
  assert.equal(registry.abortWork("task-1"), false)
})

test("work that is forgotten without being stopped is not aborted", () => {
  const registry = new InMemoryBackgroundWorkRegistry()
  let aborted = 0
  registry.upsertWork({ id: "task-1", kind: "shell", state: "completed", abort: () => { aborted++ } })
  assert.equal(registry.clearWork("task-1"), true)
  assert.equal(aborted, 0)
  assert.equal(registry.clearWork("task-1"), false)
})

test("all matching work can be stopped at once", () => {
  const registry = new InMemoryBackgroundWorkRegistry()
  const aborted: string[] = []
  registry.upsertWork({ id: "task-1", kind: "shell", state: "running", abort: () => aborted.push("task-1") })
  registry.upsertWork({ id: "task-2", kind: "shell", state: "running" })
  registry.upsertWork({ id: "task-3", kind: "subagent", state: "running", abort: () => aborted.push("task-3") })
  assert.equal(registry.abortAllWork({ kind: "shell" }), 2)
  assert.deepEqual(aborted, ["task-1"])
  assert.deepEqual(registry.listWork().map(work => work.id), ["task-3"])
  assert.equal(registry.abortAllWork(), 1)
  assert.deepEqual(registry.listWork(), [])
})

// ---------------------------------------------------------------------------------------------
// the wakeups a conversation is owed
// ---------------------------------------------------------------------------------------------

test("a completion is queued, drained and acknowledged in one go", () => {
  const registry = new InMemoryBackgroundWorkRegistry()
  registry.enqueueCompletion({ taskId: "task-1", kind: "shell", output: "done" })
  assert.equal(registry.hasPendingCompletions(), true)
  assert.deepEqual(registry.drainCompletions(), [{ taskId: "task-1", kind: "shell", output: "done" }])
  // What was drained was acknowledged, so it is not handed over twice.
  assert.equal(registry.hasPendingCompletions(), false)
  assert.deepEqual(registry.drainCompletions(), [])
  // Acknowledging it also releases the id, so the same task can be reported again later.
  registry.enqueueCompletion({ taskId: "task-1", kind: "shell", output: "again" })
  assert.deepEqual(registry.drainCompletions(), [{ taskId: "task-1", kind: "shell", output: "again" }])
})

test("a completion that is awaited is not queued", () => {
  const registry = new InMemoryBackgroundWorkRegistry()
  registry.markAwaitedCompletion("task-1")
  registry.enqueueCompletion({ taskId: "task-1", kind: "shell" })
  assert.equal(registry.hasPendingCompletions(), false)
  // Another task's completion is unaffected.
  registry.enqueueCompletion({ taskId: "task-2", kind: "shell" })
  assert.equal(registry.hasPendingCompletions(), true)
})

test("a completion that is awaited after being queued is dropped", () => {
  const registry = new InMemoryBackgroundWorkRegistry()
  registry.enqueueCompletion({ taskId: "task-1", kind: "shell" })
  registry.enqueueCompletion({ taskId: "task-2", kind: "shell" })
  registry.markAwaitedCompletion("task-1")
  // Only the awaited one is dropped: what the conversation has not seen still wakes it.
  assert.deepEqual(registry.drainCompletions(), [{ taskId: "task-2", kind: "shell" }])
})

test("awaiting a queued completion takes it out of pending", () => {
  const registry = new InMemoryBackgroundWorkRegistry()
  registry.enqueueCompletion({ taskId: "task-1", kind: "shell" })
  registry.markAwaitedCompletion("task-1")
  assert.equal(registry.hasPendingCompletions(LEGACY_LOCAL_WAKEUP_CONVERSATION_ID), false)
  assert.deepEqual(registry.drainCompletions(), [])
})

test("work that is over is no longer suppressed", () => {
  const registry = new InMemoryBackgroundWorkRegistry()
  registry.markAwaitedCompletion("task-1")
  registry.clearWork("task-1")
  registry.enqueueCompletion({ taskId: "task-1", kind: "shell" })
  assert.equal(registry.hasPendingCompletions(), true)
})

test("a completion with no id is not queued", () => {
  const registry = new InMemoryBackgroundWorkRegistry()
  registry.enqueueCompletion({ taskId: "   ", kind: "shell" })
  assert.equal(registry.hasPendingCompletions(), false)
})

test("a completion is queued once however often it is reported", () => {
  const registry = new InMemoryBackgroundWorkRegistry()
  registry.enqueueCompletion({ taskId: "task-1", kind: "shell", attempt: 1 })
  registry.enqueueCompletion({ taskId: "task-1", kind: "shell", attempt: 2 })
  assert.equal(registry.drainCompletions().length, 1)
})

test("a wakeup is held in flight until it is acknowledged", () => {
  const registry = new InMemoryBackgroundWorkRegistry()
  registry.enqueue({ conversationId: "conversation-1", id: "task-1", payload: { taskId: "task-1" } })
  const pulled = registry.pull("conversation-1")
  assert.equal(pulled.length, 1)
  assert.deepEqual(pulled[0]?.payload, { taskId: "task-1" })
  // It is in flight, so pulling again hands over nothing.
  assert.deepEqual(registry.pull("conversation-1"), [])
  assert.deepEqual(registry.ack(["task-1"]).map(wakeup => wakeup.id), ["task-1"])
  assert.deepEqual(registry.ack(["task-1"]), [])
})

test("a pulled wakeup is handed over as a copy", () => {
  const registry = new InMemoryBackgroundWorkRegistry()
  registry.enqueue({ conversationId: "conversation-1", id: "task-1", payload: { taskId: "task-1" } })
  const pulled = registry.pull("conversation-1")[0]
  assert.notEqual(pulled, undefined)
  if (pulled !== undefined) pulled.id = "changed"
  registry.nack(["task-1"], { requeue: true })
  assert.deepEqual(registry.pull("conversation-1").map(wakeup => wakeup.id), ["task-1"])
})

test("a wakeup that is not acknowledged goes back", () => {
  const registry = new InMemoryBackgroundWorkRegistry()
  registry.enqueue({ conversationId: "conversation-1", id: "task-1", payload: { taskId: "task-1" } })
  registry.pull("conversation-1")
  registry.nack(["task-1"], { requeue: true })
  assert.deepEqual(registry.pull("conversation-1").map(wakeup => wakeup.id), ["task-1"])
})

test("a wakeup that is refused goes back only if the caller says so", () => {
  const registry = new InMemoryBackgroundWorkRegistry()
  registry.enqueue({ conversationId: "conversation-1", id: "task-1", payload: { taskId: "task-1" } })
  registry.pull("conversation-1")
  registry.nack(["task-1"], { requeue: false })
  assert.deepEqual(registry.pull("conversation-1"), [])
  // It was refused rather than acknowledged, so the same work can be queued again.
  registry.enqueue({ conversationId: "conversation-1", id: "task-1", payload: { taskId: "task-1" } })
  assert.equal(registry.pull("conversation-1").length, 1)
})

test("a wakeup that is not in flight is not affected by a refusal", () => {
  const registry = new InMemoryBackgroundWorkRegistry()
  registry.enqueue({ conversationId: "conversation-1", id: "task-1", payload: { taskId: "task-1" } })
  registry.nack(["task-1"], { requeue: true })
  assert.equal(registry.pull("conversation-1").length, 1)
})

test("each conversation is handed only its own wakeups", () => {
  const registry = new InMemoryBackgroundWorkRegistry()
  registry.enqueue({ conversationId: "conversation-1", id: "task-1", payload: { taskId: "task-1" } })
  registry.enqueue({ conversationId: "conversation-2", id: "task-2", payload: { taskId: "task-2" } })
  assert.deepEqual(registry.pull("conversation-1").map(wakeup => wakeup.id), ["task-1"])
  assert.equal(registry.hasPendingCompletions(), true)
  assert.equal(registry.hasPendingCompletions("conversation-1"), false)
  assert.equal(registry.hasPendingCompletions("conversation-2"), true)
})

test("a suppressed wakeup is not handed over even from in flight", () => {
  const registry = new InMemoryBackgroundWorkRegistry()
  registry.enqueue({ conversationId: "conversation-1", id: "task-1", payload: { taskId: "task-1" } })
  registry.pull("conversation-1")
  registry.suppress("conversation-1", "task-1")
  // The caller that held it is not told about it either, and nothing comes back on a refusal.
  registry.nack(["task-1"], { requeue: true })
  assert.deepEqual(registry.pull("conversation-1"), [])
})

test("a group replaces the wakeup waiting for it", () => {
  const registry = new InMemoryBackgroundWorkRegistry()
  registry.enqueue({ conversationId: "conversation-1", id: "task-1", groupKey: "progress", payload: { taskId: "task-1" } })
  registry.enqueue({ conversationId: "conversation-1", id: "task-2", groupKey: "progress", payload: { taskId: "task-2" } })
  assert.deepEqual(registry.pull("conversation-1").map(wakeup => wakeup.id), ["task-2"])
})

test("the revision moves when the queue does and not when it does not", () => {
  const registry = new InMemoryBackgroundWorkRegistry()
  const start = registry.getWakeupRevision()
  registry.enqueue({ conversationId: "conversation-1", id: "task-1", payload: {} })
  assert.equal(registry.getWakeupRevision(), start + 1)
  // The same wakeup again is not a change.
  registry.enqueue({ conversationId: "conversation-1", id: "task-1", payload: {} })
  assert.equal(registry.getWakeupRevision(), start + 1)
  registry.pull("conversation-1")
  assert.equal(registry.getWakeupRevision(), start + 2)
  // Pulling again changes nothing, since there is nothing left to pull.
  registry.pull("conversation-1")
  assert.equal(registry.getWakeupRevision(), start + 2)
})

test("a wakeup replaced by its group releases its claim, so the old id can queue again", () => {
  const registry = new InMemoryBackgroundWorkRegistry()
  registry.enqueue({ conversationId: "conversation-1", id: "task-1", groupKey: "progress", payload: {} })
  registry.enqueue({ conversationId: "conversation-1", id: "task-2", groupKey: "progress", payload: {} })
  registry.enqueue({ conversationId: "conversation-1", id: "task-1", payload: {} })
  assert.deepEqual(registry.pull("conversation-1").map(wakeup => wakeup.id), ["task-2", "task-1"])
})

test("a refused wakeup is merged back with what is waiting for its group", () => {
  const registry = new InMemoryBackgroundWorkRegistry()
  registry.enqueue({ conversationId: "conversation-1", id: "task-1", groupKey: "progress", payload: {} })
  registry.pull("conversation-1")
  registry.enqueue({ conversationId: "conversation-1", id: "task-2", groupKey: "progress", payload: {} })
  registry.nack(["task-1"], { requeue: true })
  assert.deepEqual(registry.pull("conversation-1").map(wakeup => wakeup.id), ["task-2"])
  // The replaced wakeup released its claim too, so a later report of it is queued again.
  registry.enqueue({ conversationId: "conversation-1", id: "task-1", payload: {} })
  assert.deepEqual(registry.pull("conversation-1").map(wakeup => wakeup.id), ["task-1"])
})

test("a drain hands conversations over in the order they first appear", () => {
  const registry = new InMemoryBackgroundWorkRegistry()
  registry.enqueue({ conversationId: "conversation-2", id: "b-1", payload: "b-1" })
  registry.enqueue({ conversationId: "conversation-1", id: "a-1", payload: "a-1" })
  registry.enqueue({ conversationId: "conversation-2", id: "b-2", payload: "b-2" })
  assert.deepEqual(registry.drainCompletions(), ["b-1", "b-2", "a-1"])
})

test("ids are trimmed for claiming, acknowledging and suppressing", () => {
  const registry = new InMemoryBackgroundWorkRegistry()
  registry.enqueue({ conversationId: "conversation-1", id: "  task-1  ", payload: { attempt: 1 } })
  registry.enqueue({ conversationId: "conversation-1", id: "task-1", payload: { attempt: 2 } })
  assert.deepEqual(registry.pull("conversation-1").map(wakeup => wakeup.id), ["task-1"])
  assert.deepEqual(registry.ack([" task-1 "]).map(wakeup => wakeup.id), ["task-1"])
  registry.enqueue({ conversationId: "conversation-1", id: "task-1", payload: { attempt: 3 } })
  assert.equal(registry.pull("conversation-1").length, 1, "an acknowledged id can be queued again")
})

test("an in-flight wakeup's id cannot be queued again until it is acknowledged", () => {
  const registry = new InMemoryBackgroundWorkRegistry()
  registry.enqueue({ conversationId: "conversation-1", id: "task-1", payload: { attempt: 1 } })
  registry.pull("conversation-1")
  registry.enqueue({ conversationId: "conversation-1", id: "task-1", payload: { attempt: 2 } })
  assert.deepEqual(registry.pull("conversation-1"), [], "the id is still claimed by the wakeup in flight")
  registry.ack(["task-1"])
  registry.enqueue({ conversationId: "conversation-1", id: "task-1", payload: { attempt: 3 } })
  assert.equal(registry.pull("conversation-1").length, 1, "acknowledging releases the id for a later report")
})

test("a suppressed wakeup leaves flight too, so it is never acknowledged", () => {
  const registry = new InMemoryBackgroundWorkRegistry()
  registry.enqueue({ conversationId: "conversation-1", id: "task-1", payload: {} })
  registry.pull("conversation-1")
  registry.suppress("conversation-1", "task-1")
  assert.deepEqual(registry.ack(["task-1"]), [])
  registry.nack(["task-1"], { requeue: true })
  assert.deepEqual(registry.pull("conversation-1"), [])
})

test("the legacy conversation is the one completions belong to", () => {
  const registry = new InMemoryBackgroundWorkRegistry()
  registry.enqueueCompletion({ taskId: "task-1", kind: "shell" })
  assert.equal(registry.hasPendingCompletions(LEGACY_LOCAL_WAKEUP_CONVERSATION_ID), true)
  assert.equal(registry.hasPendingCompletions("some-other-conversation"), false)
})
