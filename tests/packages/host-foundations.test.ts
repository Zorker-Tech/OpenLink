import { test } from "node:test"
import { createContext } from "../../source/packages/context/context.ts"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { AgentWorkflowEnablement, ENABLEMENT_FILENAME } from "../../source/host/agents/agent-workflow-enablement.ts"
import { BoxLifecycleService } from "../../source/host/boxes/box-lifecycle/box-lifecycle-service.ts"
import { SlateLocalExecError } from "../../source/host/local-exec/local-exec-error.ts"
import { createNotifyDrainGate, NOTIFY_DRAIN_FLOOR_MS, NOTIFY_SAFETY_POLL_MS } from "../../source/host/notifications/notify-drain-gate.ts"
import { createNoopSlateProductAnalytics } from "../../source/host/ports/product-analytics.ts"
import { slateMessageLengthBucket } from "../../source/host/ports/slate-analytics-types.ts"
import { createSingleUserComputer, DEFAULT_SLATE_COMPUTER_ID } from "../../source/host/ports/user-computer.ts"
import { SlateToolInputError } from "../../source/host/runner/tools/tool-input-error.ts"
import { sha256Hex } from "../../source/host/sha256.ts"
import { displaySpaceSentence, SLATE_MONITOR_HEIGHT, SLATE_MONITOR_WIDTH } from "../../source/host/boxes/box-monitor-layout.ts"
import { isSlateRemoteRoomDir, normalizeRemoteRoomMembers, readSlateRemoteRoomConfig, writeSlateRemoteRoomConfig } from "../../source/host/groups/remote-room-store.ts"
import { SLATE_HIDDEN_PROMPT_MARKER, SLATE_TRUSTED_AUTOMATION_PROMPT_MARKER } from "../../source/host/runner/slate-prompt-markers.ts"
import { createToolCallIdentity } from "../../source/host/runner/tool-call-identity.ts"
import { slateQuietWorkOriginKey } from "../../source/host/slate-quiet-work-origin.ts"
import { pinBoxStoreDiagnosticsReporter, reportBoxStoreDiagnostic } from "../../source/host/boxes/box-store-sync/box-store-diagnostics.ts"
import { pinHostDiagnosticsReporter, reportHostDiagnostic } from "../../source/host/host-diagnostics.ts"
import { handleProcessCrash, toError } from "../../source/host/process-crash-guard.ts"
import { stateWriteFailed, stateWriteOk } from "../../source/host/runner/agent-state.ts"

// ---------------------------------------------------------------------------------------------
// What an agent keeps for itself
// ---------------------------------------------------------------------------------------------

test("a workflow is enabled unless the agent turned it off", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slate-enablement-"))
  try {
    const enablement = new AgentWorkflowEnablement(dir)
    assert.equal(enablement.path, path.join(dir, ENABLEMENT_FILENAME))
    // Nothing written yet means everything is available, and nothing was said explicitly.
    assert.equal(enablement.isEnabled("nightly"), true)
    assert.equal(enablement.hasExplicitEntries(), false)

    enablement.setEnabled("nightly", false)
    assert.equal(enablement.isEnabled("nightly"), false)
    assert.equal(enablement.hasExplicitEntries(), true)
    // The file holds the disabled ids, sorted.
    enablement.setEnabled("alpha", false)
    const written = JSON.parse(fs.readFileSync(enablement.path, "utf8")) as { disabled: string[] }
    assert.deepEqual(written.disabled, ["alpha", "nightly"])

    // Turning one back on, forgetting one, and enabling all are all the same file.
    enablement.setEnabled("nightly", true)
    assert.equal(enablement.isEnabled("nightly"), true)
    enablement.forget("alpha")
    assert.equal(enablement.hasExplicitEntries(), false)
    enablement.setEnabled("a", false)
    enablement.enableAll(["a"])
    assert.equal(enablement.isEnabled("a"), true)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("a shared room is read defensively and kept beside the agent", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slate-room-"))
  try {
    assert.equal(readSlateRemoteRoomConfig(dir), null)
    assert.equal(isSlateRemoteRoomDir(dir), false)

    writeSlateRemoteRoomConfig(dir, {
      version: 1,
      roomId: "room-1",
      hostAuthId: "host-1",
      hostName: "The host",
      members: [
        { kind: "agent", authId: "a1", agentId: "agent-1", displayName: "One" },
        { kind: "human", authId: "h1", agentId: "", displayName: "Two", avatarUrl: "https://example.com/a.png" },
      ],
    })
    const read = readSlateRemoteRoomConfig(dir)
    assert.equal(read?.roomId, "room-1")
    assert.equal(read?.members.length, 2)
    assert.equal(isSlateRemoteRoomDir(dir), true)

    // A member that names nobody is dropped, a name that says nothing is replaced, and a missing room is nothing.
    const members = normalizeRemoteRoomMembers([
      { authId: "a1" },
      { authId: "" },
      { agentId: "x" },
      { authId: "a2", displayName: "  ", kind: "agent" },
    ])
    assert.deepEqual(members.map(member => member.authId), ["a1", "a2"])
    assert.equal(members[0]?.displayName, "Someone")
    assert.equal(members[1]?.kind, "agent")
    assert.deepEqual(normalizeRemoteRoomMembers("not a list"), [])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------------------------
// The host's own small pieces
// ---------------------------------------------------------------------------------------------

test("a box is rebuilt only as far as the box says it was", async () => {
  const calls: Array<Record<string, unknown>> = []
  const service = new BoxLifecycleService({
    getSandBoxRunState: async () => ({ imageUpdateAvailable: true }),
    recreateSandBox: async input => {
      calls.push(input)
      return { started: true }
    },
  })
  assert.equal(await service.fetchImageUpdateAvailable(new AbortController().signal), true)
  assert.deepEqual(await service.recreateInBox({ preserveData: true }), { started: true })
  // A rebuild that did not start is reported with the reason it did not.
  const refused = new BoxLifecycleService({
    getSandBoxRunState: async () => ({ imageUpdateAvailable: false }),
    recreateSandBox: async () => ({ started: false, reason: "busy" }),
  })
  assert.deepEqual(await refused.recreateInBox({ preserveData: false }), { started: false, reason: "busy" })
  assert.deepEqual(calls, [{ preserveData: true, force: false }])
})

test("the notification gate drains when it should and remembers what it drained", () => {
  let now = 1_000
  let connected = true
  const gate = createNotifyDrainGate({ now: () => now, isConnected: () => connected })

  // The first poll drains, since there has not been one yet.
  assert.equal(gate.shouldDrain({ hasOwedWork: false }), true)
  gate.recordPoll()

  // Nothing recorded and nothing owed: the gate waits for the safety poll.
  now += NOTIFY_DRAIN_FLOOR_MS
  assert.equal(gate.shouldDrain({ hasOwedWork: false }), false)
  gate.recordPoll()
  now += NOTIFY_SAFETY_POLL_MS
  assert.equal(gate.shouldDrain({ hasOwedWork: false }), true)
  gate.recordPoll()

  // A recorded notification drains once the floor has passed.
  now += NOTIFY_DRAIN_FLOOR_MS
  gate.recordNotify()
  assert.equal(gate.shouldDrain({ hasOwedWork: false }), true)
  gate.recordPoll()
  assert.equal(gate.shouldDrain({ hasOwedWork: false }), false)

  // Owed work and a dropped connection drain regardless.
  assert.equal(gate.shouldDrain({ hasOwedWork: true }), true)
  connected = false
  assert.equal(gate.shouldDrain({ hasOwedWork: false }), true)
})

test("the user's own computer is one machine, and it answers only while it is connected", () => {
  assert.equal(DEFAULT_SLATE_COMPUTER_ID, "this-computer")
  const computer = createSingleUserComputer({ box: { id: "box-1" } })
  assert.deepEqual(computer.list(), [{ id: "this-computer", label: "this computer", connected: true }])
  assert.deepEqual(computer.resolve(), { id: "this-computer", label: "this computer", box: { id: "box-1" } })
  // A request for another machine, or one made while this one is not there, resolves to nothing.
  assert.equal(computer.resolve("somewhere-else"), undefined)
  const offline = createSingleUserComputer({ box: { id: "box-1" }, isConnected: () => false })
  assert.equal(offline.resolve(), undefined)
  assert.deepEqual(offline.list(), [{ id: "this-computer", label: "this computer", connected: false }])
})

test("the small names and numbers the host shares are the ones it promises", () => {
  assert.equal(sha256Hex("abc").length, 64)
  assert.equal(sha256Hex("abc"), sha256Hex(Buffer.from("abc")))
  assert.equal(slateMessageLengthBucket(0), "empty")
  assert.equal(slateMessageLengthBucket(10), "xs")
  assert.equal(slateMessageLengthBucket(50), "s")
  assert.equal(slateMessageLengthBucket(200), "m")
  assert.equal(slateMessageLengthBucket(1_000), "l")
  assert.equal(slateMessageLengthBucket(5_000), "xl")
  assert.equal(SLATE_MONITOR_WIDTH, 1_280)
  assert.equal(SLATE_MONITOR_HEIGHT, 800)
  assert.match(displaySpaceSentence(), /Display is 1280×800/)
  assert.match(displaySpaceSentence({ width: 100, height: 50 }), /0\.\.99 × 0\.\.49/)
  assert.equal(SLATE_HIDDEN_PROMPT_MARKER, "[SLATE_HIDDEN_PROMPT]")
  assert.equal(SLATE_TRUSTED_AUTOMATION_PROMPT_MARKER, "[SLATE_TRUSTED_AUTOMATION_PROMPT]")
  // The quiet-work key is a context key: a context that does not carry it reads as nothing, and one that does
  // carries what it was given.
  assert.equal(createContext().get(slateQuietWorkOriginKey), undefined)
  assert.equal(new SlateLocalExecError("nope").message, "nope")
  assert.equal(new SlateToolInputError().name, "SlateToolInputError")
  createNoopSlateProductAnalytics().trackEvent("anything", { a: 1 })
})

test("a tool call's name is remembered until the update that carries it", () => {
  const updates: Array<Record<string, unknown>> = []
  const identity = createToolCallIdentity({ emitUpdate: update => updates.push(update as Record<string, unknown>) })

  // A name recorded before the update is filled into the update when it arrives.
  identity.recordModelToolName("call-1", "Shell")
  identity.stashSurfaceUnresolvedPending("call-1", { other: "field" })
  identity.recordModelToolName("call-1", "Shell")
  assert.deepEqual(updates, [{ other: "field", name: "Shell" }])
  // The name is handed over until the call completes, and then it is forgotten.
  assert.equal(identity.resolveModelToolName("toolCallDelta", "call-1", "outline"), "Shell")
  assert.equal(identity.resolveModelToolName("toolCallCompleted", "call-1", "outline"), "Shell")
  // A call nobody recorded falls back to what the caller already had.
  assert.equal(identity.resolveModelToolName("toolCallDelta", "call-2", "outline"), "outline")
})

test("a diagnostic is reported only to whoever is listening", () => {
  const hostReports: string[] = []
  pinHostDiagnosticsReporter(diagnostic => hostReports.push(diagnostic.kind))
  reportHostDiagnostic({ kind: "one" })
  pinHostDiagnosticsReporter(null)
  reportHostDiagnostic({ kind: "two" })
  assert.deepEqual(hostReports, ["one"])

  const boxReports: string[] = []
  pinBoxStoreDiagnosticsReporter(diagnostic => boxReports.push(String(diagnostic.kind)))
  reportBoxStoreDiagnostic({ kind: "sync" })
  assert.deepEqual(boxReports, ["sync"])
})

test("a crash is reported and the process is kept alive", () => {
  const reported: Array<{ message: string; kind: string }> = []
  const originalError = console.error
  console.error = () => {}
  try {
    handleProcessCrash({ scope: "test", onError: (error, kind) => reported.push({ message: error.message, kind }) }, "uncaughtException", "boom")
    // A reporter that throws does not become the crash it was reporting.
    handleProcessCrash({ scope: "test", onError: () => { throw new Error("reporter failed"); } }, "unhandledRejection", new Error("again"))
  } finally {
    console.error = originalError
  }
  assert.deepEqual(reported, [{ message: "boom", kind: "uncaughtException" }])
  assert.equal(toError("boom").message, "boom")
  assert.equal(toError(new Error("kept")).message, "kept")
})

test("writing an agent's state says whether it was written", () => {
  assert.deepEqual(stateWriteOk({ a: 1 }), { ok: true, detail: { a: 1 } })
  assert.deepEqual(stateWriteFailed("no room"), { ok: false, reason: "no room" })
})
