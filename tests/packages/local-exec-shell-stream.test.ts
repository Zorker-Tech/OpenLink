import { test } from "node:test"
import assert from "node:assert/strict"

import { LocalShellStreamExecutor } from "../../source/packages/local-exec/shell-stream.ts"
import { createContext } from "../../source/packages/context/context.ts"

// The stream executor turns a command into the events a caller consumes. The checks in front of the
// command are what these tests are about, since they are what a caller sees before anything runs.

function createExecutor(overrides: Record<string, unknown> = {}) {
  const permissions = {
    shouldEnforceShellInvariantBlocks: async () => ({ kind: "allow" }),
    shouldBlockShellCommand: async () => ({ kind: "allow" }),
    ...overrides,
  }
  const core = { execute: () => ({ async *[Symbol.asyncIterator]() {} }), getCwd: async () => "/repo" }
  const ignore = { getWorkspaceIgnoreMapping: async () => ({}) }
  const background = { generateShellId: () => 1, adopt: async () => undefined, abort: () => true }
  return new LocalShellStreamExecutor(permissions as never, core as never, ignore as never, background as never)
}

async function collect(executor: LocalShellStreamExecutor, args: Record<string, unknown>) {
  const events = []
  for await (const event of executor.execute(createContext(), args as never)) events.push(event)
  return events
}

test("a command an administrator forbade is refused before anything runs", async () => {
  const executor = createExecutor()
  const events = await collect(executor, { command: "npm install left-pad", adminCommandDenylist: ["npm:install *"] })

  assert.equal(events.length, 1)
  assert.equal(events[0]?.type, "rejected")
  assert.match(events[0]?.type === "rejected" ? events[0].reason : "", /denylist rule/)
})

test("a command the platform refuses to reason about is blocked rather than run", async () => {
  const executor = createExecutor({
    shouldBlockShellCommand: async () => ({ kind: "block", reason: { type: "unsafeWorkingDirectory", message: "unsafe" } }),
  })
  const events = await collect(executor, { command: "echo hi" })

  assert.equal(events[0]?.type, "rejected")
  assert.equal(events[0]?.type === "rejected" ? events[0].reason : "", "unsafe")
})

test("an invariant the platform enforces is checked before the approval", async () => {
  const executor = createExecutor({
    shouldEnforceShellInvariantBlocks: async () => ({ kind: "block", reason: { type: "userDeclined", detail: "not now" } }),
  })
  const events = await collect(executor, { command: "echo hi" })

  assert.equal(events[0]?.type, "rejected")
  assert.equal(events[0]?.type === "rejected" ? events[0].reason : "", "not now")
})

test("a command that was already approved is not approved again", async () => {
  // The caller says the approval is not needed, so the classifier is not asked.
  let asked = false
  const executor = createExecutor({
    shouldBlockShellCommand: async () => {
      asked = true
      return { kind: "block", reason: { type: "approvalRequired" } }
    },
  })
  const events = await collect(executor, { command: "echo hi", skipApproval: true })

  // The classifier was not asked, and the command started rather than being refused.
  assert.equal(asked, false)
  assert.equal(events[0]?.type, "start")
})

test("a command blocked by a read-only session is a permission denial", async () => {
  const executor = createExecutor({
    shouldBlockShellCommand: async () => ({ kind: "block", reason: { type: "permissionConfiguration", isReadOnly: true } }),
  })
  const events = await collect(executor, { command: "rm -rf /" })

  assert.equal(events[0]?.type, "permissionDenied")
  assert.equal(events[0]?.type === "permissionDenied" ? events[0].isReadonly : false, true)
})

test("a shell nobody started cannot be moved to the background", async () => {
  const executor = createExecutor()
  const result = await executor.forceBackgroundByToolCallId("call-1")
  assert.equal(result.status, "not_found")
})
