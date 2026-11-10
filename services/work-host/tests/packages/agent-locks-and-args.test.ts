import { test } from "node:test"
import assert from "node:assert/strict"
import { z } from "zod"

import { createContext } from "../../source/packages/context/context.ts"
import { writeExecutorResource, type WriteExecutorArgs } from "../../source/packages/agent-exec/write-operation.ts"
import { FileOperationLockManager } from "../../source/packages/agent/tools/core/file-operation-locks.ts"
import { ToolCallAbortedError } from "../../source/packages/agent/tools/tool-errors.ts"
import { renderSelectedTerminalContext } from "../../source/packages/agent/context/terminal-context.ts"
import {
  jsonTokens,
  namesAKeyTwice,
  parseArgumentsLeniently,
} from "../../source/packages/agent/tools/mcp/argument-repair.ts"
import { lenientArray } from "../../source/packages/agent/tools/lenient-array.ts"

const ctx = () => createContext()

// ---------------------------------------------------------------------------------------------
// the write operation
// ---------------------------------------------------------------------------------------------

test("the write operation is named once and reachable from both sides", () => {
  assert.equal(typeof writeExecutorResource.symbol, "symbol")
  const executor = writeExecutorResource.remoteImplementation({} as never)
  assert.equal(typeof executor.execute, "function")
  const request: WriteExecutorArgs = { path: "/repo/note.txt", text: "" }
  assert.deepEqual(request, { path: "/repo/note.txt", text: "" })
})

// ---------------------------------------------------------------------------------------------
// file operation locks
// ---------------------------------------------------------------------------------------------

test("a second call for the same file waits for the first to release", async () => {
  const locks = new FileOperationLockManager()
  const first = await locks.waitForLock(ctx(), "/p/a.ts")
  assert.equal(locks.activeFileOperationCount, 1)

  let secondGranted = false
  const second = locks.waitForLock(ctx(), "/p/a.ts").then(lock => {
    secondGranted = true
    return lock
  })
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(secondGranted, false)

  first[Symbol.dispose]()
  const secondLock = await second
  assert.equal(secondGranted, true)
  secondLock[Symbol.dispose]()
  assert.equal(locks.activeFileOperationCount, 0)
})

test("two different files do not wait for each other", async () => {
  const locks = new FileOperationLockManager()
  const first = await locks.waitForLock(ctx(), "/p/a.ts")
  const second = await locks.waitForLock(ctx(), "/p/b.ts")
  assert.equal(locks.activeFileOperationCount, 2)
  first[Symbol.dispose]()
  second[Symbol.dispose]()
})

test("an exclusive lock waits for every file lock and blocks the next one", async () => {
  const locks = new FileOperationLockManager()
  const fileLock = await locks.waitForLock(ctx(), "/p/a.ts")

  let exclusiveGranted = false
  const exclusive = locks.waitForExclusiveLock(ctx()).then(lock => {
    exclusiveGranted = true
    return lock
  })
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(exclusiveGranted, false)

  fileLock[Symbol.dispose]()
  const exclusiveLock = await exclusive
  assert.equal(exclusiveGranted, true)

  // A file lock taken while the exclusive one is held waits, and so does one queued behind it.
  let laterGranted = false
  const later = locks.waitForLock(ctx(), "/p/b.ts").then(lock => {
    laterGranted = true
    return lock
  })
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(laterGranted, false)
  exclusiveLock[Symbol.dispose]()
  const laterLock = await later
  assert.equal(laterGranted, true)
  laterLock[Symbol.dispose]()
})

test("a waiting exclusive lock keeps later file locks behind it", async () => {
  const locks = new FileOperationLockManager()
  const held = await locks.waitForLock(ctx(), "/p/a.ts")
  const exclusive = locks.waitForExclusiveLock(ctx())
  let fileGranted = false
  const file = locks.waitForLock(ctx(), "/p/b.ts").then(lock => {
    fileGranted = true
    return lock
  })
  await new Promise(resolve => setTimeout(resolve, 5))
  // The exclusive lock is ahead in the queue, so the unrelated file does not jump it.
  assert.equal(fileGranted, false)

  held[Symbol.dispose]()
  const exclusiveLock = await exclusive
  exclusiveLock[Symbol.dispose]()
  const fileLock = await file
  fileLock[Symbol.dispose]()
})

test("a lock released twice only releases once", async () => {
  const locks = new FileOperationLockManager()
  const lock = await locks.waitForLock(ctx(), "/p/a.ts")
  lock[Symbol.dispose]()
  lock[Symbol.dispose]()
  assert.equal(locks.activeFileOperationCount, 0)
})

test("the acquisition order is tracked only when asked for", async () => {
  const locks = new FileOperationLockManager()
  const untracked = await locks.waitForLock(ctx(), "/p/a.ts")
  assert.equal(untracked.acquisitionOrder, undefined)
  const first = await locks.waitForLock(ctx(), "/p/b.ts", { trackAcquisitionOrder: true })
  const second = await locks.waitForLock(ctx(), "/p/c.ts", { trackAcquisitionOrder: true })
  assert.equal(second.acquisitionOrder! > first.acquisitionOrder!, true)
  untracked[Symbol.dispose]()
  first[Symbol.dispose]()
  second[Symbol.dispose]()
})

test("a call cancelled before it waits takes no lock, and one cancelled while waiting leaves the queue", async () => {
  const locks = new FileOperationLockManager()
  const [abortedContext, cancel] = ctx().withCancel()
  cancel(new Error("stopped"))
  await assert.rejects(locks.waitForLock(abortedContext, "/p/a.ts"), ToolCallAbortedError)

  const held = await locks.waitForLock(ctx(), "/p/a.ts")
  const [waitingContext, cancelWaiting] = ctx().withCancel()
  const waiting = locks.waitForLock(waitingContext, "/p/a.ts")
  await new Promise(resolve => setTimeout(resolve, 5))
  cancelWaiting(new Error("stopped"))
  await assert.rejects(waiting, ToolCallAbortedError)

  // The queue is empty, so releasing the held lock leaves nothing behind.
  held[Symbol.dispose]()
  assert.equal(locks.activeFileOperationCount, 0)
})

test("an exclusive lock cancelled while waiting is not left held", async () => {
  const locks = new FileOperationLockManager()
  const held = await locks.waitForLock(ctx(), "/p/a.ts")
  const [waitingContext, cancelWaiting] = ctx().withCancel()
  const waiting = locks.waitForExclusiveLock(waitingContext)
  await new Promise(resolve => setTimeout(resolve, 5))
  cancelWaiting(new Error("stopped"))
  await assert.rejects(waiting, ToolCallAbortedError)

  held[Symbol.dispose]()
  // Nothing is held, so an unrelated file can be locked straight away.
  const free = await locks.waitForLock(ctx(), "/p/b.ts")
  free[Symbol.dispose]()
})

// ---------------------------------------------------------------------------------------------
// terminal context
// ---------------------------------------------------------------------------------------------

test("nothing is rendered when no terminal was attached", () => {
  assert.deepEqual(renderSelectedTerminalContext([], [], {}), [])
})

test("a whole terminal is tagged with its title and path and carries no line numbers", () => {
  const parts = renderSelectedTerminalContext([{ title: "dev server", path: "/t/1", content: "line one\nline two" }], [], {})
  assert.equal(parts.length, 1)
  assert.match(parts[0]!.text, /^\n<terminal_output title="dev server" path="\/t\/1">/)
  assert.match(parts[0]!.text, /line one\nline two/)
  assert.doesNotMatch(parts[0]!.text, /\|line one/)
})

test("a terminal selection carries its line range", () => {
  const parts = renderSelectedTerminalContext([], [{
    title: "shell",
    path: "/t/2",
    content: "middle",
    range: { start: { line: 10 }, end: { line: 20 } },
  }], {})
  assert.match(parts[0]!.text, /^\n<terminal_selection title="shell" path="\/t\/2" lines="10-20">/)
  assert.match(parts[0]!.text, /middle/)
})

test("a selection with no range is a single line at the start", () => {
  const parts = renderSelectedTerminalContext([], [{ content: "one line" }], {})
  assert.match(parts[0]!.text, /lines="1-1"/)
})

test("a very long terminal is capped from both ends", () => {
  const parts = renderSelectedTerminalContext([{ content: "s".repeat(60_000) }], [], {})
  assert.match(parts[0]!.text, /\.\.\. \(output truncated\) \.\.\./)
  assert.ok(parts[0]!.text.length < 20_100)
})

test("a selection is not capped, since the user chose the lines", () => {
  const parts = renderSelectedTerminalContext([], [{ content: "s".repeat(60_000) }], {})
  assert.ok(parts[0]!.text.length > 60_000)
})

// ---------------------------------------------------------------------------------------------
// reading MCP arguments that are not quite JSON
// ---------------------------------------------------------------------------------------------

test("the tokenizer yields strings and structure and skips whitespace", () => {
  const tokens = [...jsonTokens('{"a": [1]}', 0)]
  assert.deepEqual(tokens.map(token => token.kind === "punctuation" ? token.char : token.raw), ["{", '"a"', ":", "[", "]", "}"])
})

test("a key written twice is detected, and a key repeated in a sibling object is not", () => {
  assert.equal(namesAKeyTwice('{"a":1,"a":2}'), true)
  assert.equal(namesAKeyTwice('{"a":1,"b":2}'), false)
  assert.equal(namesAKeyTwice('[{"a":1},{"a":2}]'), false)
  assert.equal(namesAKeyTwice('{"outer":{"a":1,"a":2}}'), true)
})

test("plain JSON is read without repair", () => {
  const parsed = parseArgumentsLeniently('{"server":"s","tool":"t"}')
  assert.deepEqual(parsed, { args: { server: "s", tool: "t" }, repaired: false })
})

test("a stray closing brace is dropped and the call is read", () => {
  const parsed = parseArgumentsLeniently('{"server":"s","tool":"t"}}')
  assert.equal(parsed?.repaired, true)
  assert.deepEqual(parsed?.args, { server: "s", tool: "t" })
})

test("a leaked description is absorbed into the arguments", () => {
  const parsed = parseArgumentsLeniently('{"server":"s","tool":"t"}<parameter name="description">look it up</parameter>')
  assert.equal(parsed?.repaired, true)
  assert.deepEqual(parsed?.envelopeFields, { description: "look it up" })
  assert.deepEqual(parsed?.args, { server: "s", tool: "t" })
})

test("a leaked parameter other than the description is refused", () => {
  assert.equal(
    parseArgumentsLeniently('{"server":"s"}<parameter name="tool">t</parameter>'),
    undefined,
  )
})

test("a blob with two readings is refused rather than guessed at", () => {
  // Two different objects can be read out of this, so neither is chosen.
  assert.equal(parseArgumentsLeniently('{"a":1}{"b":2}'), undefined)
})

test("a blob with no object at all is refused", () => {
  assert.equal(parseArgumentsLeniently("not json"), undefined)
})

// ---------------------------------------------------------------------------------------------
// reading an array a model sent as text
// ---------------------------------------------------------------------------------------------

const arraySchema = z.object({
  items: lenientArray(z.array(z.string()), { field: "items", primitiveItems: true }),
})

test("a clean array in a string is read", () => {
  assert.deepEqual(arraySchema.parse({ items: '["a","b"]' }), { items: ["a", "b"] })
})

test("a real array is passed through", () => {
  assert.deepEqual(arraySchema.parse({ items: ["a"] }), { items: ["a"] })
})

test("a single item sent where a list belongs is wrapped", () => {
  assert.deepEqual(arraySchema.parse({ items: "only one" }), { items: ["only one"] })
})

test("a value that looks like several items is not wrapped", () => {
  assert.equal(arraySchema.safeParse({ items: "one, two" }).success, false)
  assert.equal(arraySchema.safeParse({ items: "one\ntwo" }).success, false)
})

test("leaked markup naming this parameter is stripped", () => {
  const parsed = arraySchema.parse({ items: '<parameter name="items">["a"]</parameter>' })
  assert.deepEqual(parsed, { items: ["a"] })
})

test("leaked markup naming another parameter is not recoverable", () => {
  assert.equal(arraySchema.safeParse({ items: '<parameter name="other">["a"]</parameter>' }).success, false)
})

test("a complete array with a contentless tail is read", () => {
  assert.deepEqual(arraySchema.parse({ items: '["a","b"],' }), { items: ["a", "b"] })
})

test("an empty string and a truncated array are refused", () => {
  assert.equal(arraySchema.safeParse({ items: "   " }).success, false)
  assert.equal(arraySchema.safeParse({ items: '["a",' }).success, false)
})

test("a duplicate key makes a blob unreadable", () => {
  assert.equal(arraySchema.safeParse({ items: '["a","a"]' }).success, true)
  assert.equal(namesAKeyTwice('{"a":1,"a":2}'), true)
})
