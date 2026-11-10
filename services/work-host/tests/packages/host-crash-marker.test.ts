import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  HOST_CRASH_EXIT_SIGNALS,
  createHostCrashMarkerStore,
  deleteIfUnchanged,
  forwardHostCrashMarkerWith,
  hostCrashMarkerMetadata,
  isFatalExitSignal,
  isNonNegativeFinite,
  parseHostCrashMarker,
  parseJson,
  readCommonTimes,
  type HostCrashMarker,
  type HostCrashMarkerRead,
  type HostCrashMarkerStore,
} from "../../source/host/telemetry/host-crash-marker.ts"

const marker = (overrides: Partial<HostCrashMarker> = {}): HostCrashMarker => ({
  schemaVersion: 1,
  errorClass: "signal_exit",
  exitSignal: "SIGSEGV",
  crashedAtMs: 200,
  startedAtMs: 100,
  uptimeMs: 100,
  ...overrides,
})

/** A store that answers in order and writes down what it was asked. */
function scriptedStore(reads: HostCrashMarkerRead[], deleteResult: "deleted" | "unavailable" = "deleted") {
  const calls: string[] = []
  let index = 0
  const store: HostCrashMarkerStore = {
    async read() {
      const value = reads[Math.min(index, reads.length - 1)]!
      index += 1
      calls.push("read" + value.kind)
      return value
    },
    async delete() {
      calls.push("delete")
      return deleteResult
    },
  }
  return { store, calls }
}

test("a time is a non-negative finite number", () => {
  assert.equal(isNonNegativeFinite(0), true)
  assert.equal(isNonNegativeFinite(1.5), true)
  assert.equal(isNonNegativeFinite(-1), false)
  assert.equal(isNonNegativeFinite(Number.NaN), false)
  assert.equal(isNonNegativeFinite(Number.POSITIVE_INFINITY), false)
  assert.equal(isNonNegativeFinite("1"), false)
  assert.equal(isNonNegativeFinite(null), false)
  assert.equal(isNonNegativeFinite(undefined), false)
})

test("a fatal signal is none of the words and is one the platform names", () => {
  for (const signal of HOST_CRASH_EXIT_SIGNALS) {
    const fatal = signal !== "none" && signal !== "unknown"
    assert.equal(isFatalExitSignal(signal), fatal)
  }
  assert.equal(isFatalExitSignal("other"), true)
  assert.equal(isFatalExitSignal("SIGWEIRD"), false)
  assert.equal(isFatalExitSignal(7), false)
  assert.equal(isFatalExitSignal(undefined), false)
})

test("common times are read only when all three are usable", () => {
  assert.deepEqual(readCommonTimes({ startedAtMs: 1, crashedAtMs: 2, uptimeMs: 1 }), { startedAtMs: 1, crashedAtMs: 2, uptimeMs: 1 })
  assert.equal(readCommonTimes({ startedAtMs: 1, crashedAtMs: 2 }), null)
  assert.equal(readCommonTimes({ startedAtMs: -1, crashedAtMs: 2, uptimeMs: 1 }), null)
  assert.equal(readCommonTimes({ startedAtMs: 1, crashedAtMs: Number.NaN, uptimeMs: 1 }), null)
  assert.equal(readCommonTimes({ startedAtMs: "1", crashedAtMs: 2, uptimeMs: 1 }), null)
  assert.equal(readCommonTimes({}), null)
})

test("json is parsed or reported invalid", () => {
  assert.deepEqual(parseJson('{"a":1}'), { kind: "parsed", value: { a: 1 } })
  assert.deepEqual(parseJson("[1]"), { kind: "parsed", value: [1] })
  assert.deepEqual(parseJson("not json"), { kind: "invalid" })
})

test("a signal-exit marker is read when its signal is fatal", () => {
  assert.deepEqual(parseHostCrashMarker(JSON.stringify(marker())), marker())
  assert.equal(parseHostCrashMarker(JSON.stringify(marker({ errorClass: "signal_exit", exitSignal: "none" }))), null)
  assert.equal(parseHostCrashMarker(JSON.stringify(marker({ errorClass: "signal_exit", exitSignal: "SIGWEIRD" }))), null)
  assert.equal(parseHostCrashMarker(JSON.stringify({ schemaVersion: 1, errorClass: "signal_exit", exitSignal: "SIGSEGV", crashedAtMs: 200 })), null)
})

test("an exit marker is read only with the none signal", () => {
  const nonzero = { ...marker(), errorClass: "nonzero_exit", exitSignal: "none" }
  assert.deepEqual(parseHostCrashMarker(JSON.stringify(nonzero)), nonzero)
  const clean = { ...marker(), errorClass: "unexpected_clean_exit", exitSignal: "none" }
  assert.deepEqual(parseHostCrashMarker(JSON.stringify(clean)), clean)
  assert.equal(parseHostCrashMarker(JSON.stringify({ ...nonzero, exitSignal: "SIGTERM" })), null)
})

test("an unobserved marker needs only the crash time", () => {
  const baseMarker = { schemaVersion: 1, errorClass: "unobserved_exit", exitSignal: "unknown", crashedAtMs: 200 }
  assert.deepEqual(parseHostCrashMarker(JSON.stringify(baseMarker)), baseMarker)
  assert.deepEqual(parseHostCrashMarker(JSON.stringify({ ...baseMarker, startedAtMs: 100 })), { ...baseMarker, startedAtMs: 100 })
  assert.deepEqual(parseHostCrashMarker(JSON.stringify({ ...baseMarker, uptimeMs: 100 })), { ...baseMarker, uptimeMs: 100 })
  assert.equal(parseHostCrashMarker(JSON.stringify({ ...baseMarker, crashedAtMs: -1 })), null)
  assert.equal(parseHostCrashMarker(JSON.stringify({ ...baseMarker, startedAtMs: -1 })), null)
  assert.equal(parseHostCrashMarker(JSON.stringify({ ...baseMarker, uptimeMs: "1" })), null)
  // A marker that is not an unobserved exit is not read as one just because its signal is unknown.
  assert.equal(parseHostCrashMarker(JSON.stringify({ schemaVersion: 1, errorClass: "signal_exit", exitSignal: "unknown", crashedAtMs: 200 })), null)
  assert.equal(parseHostCrashMarker(JSON.stringify({ schemaVersion: 1, errorClass: "nonzero_exit", exitSignal: "unknown", crashedAtMs: 200 })), null)
})

test("a marker with another shape is not read", () => {
  assert.equal(parseHostCrashMarker(JSON.stringify({ ...marker(), schemaVersion: 2 })), null)
  assert.equal(parseHostCrashMarker(JSON.stringify({ ...marker(), errorClass: "something_else" })), null)
  assert.equal(parseHostCrashMarker("not json"), null)
  assert.equal(parseHostCrashMarker("null"), null)
  assert.equal(parseHostCrashMarker("[]"), null)
  assert.equal(parseHostCrashMarker("{}"), null)
})

test("the metadata spells every field", () => {
  assert.deepEqual(hostCrashMarkerMetadata(marker()), {
    kind: "process_exit",
    error_class: "signal_exit",
    exit_signal: "SIGSEGV",
    started_at_ms: "100",
    crashed_at_ms: "200",
    uptime_ms: "100",
  })
  assert.deepEqual(hostCrashMarkerMetadata({ schemaVersion: 1, errorClass: "unobserved_exit", exitSignal: "unknown", crashedAtMs: 250 }), {
    kind: "process_exit",
    error_class: "unobserved_exit",
    exit_signal: "unknown",
    crashed_at_ms: "250",
  })
  assert.deepEqual(hostCrashMarkerMetadata({ schemaVersion: 1, errorClass: "nonzero_exit", exitSignal: "none", crashedAtMs: 1.4, startedAtMs: 0.4, uptimeMs: 1.6 })["uptime_ms"], "2")
})

test("the store reads and deletes one file", async () => {
  const root = mkdtempSync(join(tmpdir(), "slate-crash-marker-"))
  try {
    const markerPath = join(root, "marker.json")
    const store = createHostCrashMarkerStore(markerPath)
    assert.deepEqual(await store.read(), { kind: "absent" })
    writeFileSync(markerPath, "marker-bytes")
    assert.deepEqual(await store.read(), { kind: "present", raw: "marker-bytes" })
    assert.equal(await store.delete(), "deleted")
    assert.deepEqual(await store.read(), { kind: "absent" })
    assert.equal(await store.delete(), "deleted")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("a marker is deleted only while it is unchanged", async () => {
  const same = scriptedStore([{ kind: "present", raw: "same" }])
  assert.equal(await deleteIfUnchanged(same.store, "same"), "deleted")
  assert.deepEqual(same.calls, ["readpresent", "delete"])
  const changed = scriptedStore([{ kind: "present", raw: "other" }])
  assert.equal(await deleteIfUnchanged(changed.store, "same"), "changed")
  assert.deepEqual(changed.calls, ["readpresent"])
  const absent = scriptedStore([{ kind: "absent" }])
  assert.equal(await deleteIfUnchanged(absent.store, "same"), "deleted")
  const unavailable = scriptedStore([{ kind: "unavailable" }])
  assert.equal(await deleteIfUnchanged(unavailable.store, "same"), "failed")
  const failedDelete = scriptedStore([{ kind: "present", raw: "same" }], "unavailable")
  assert.equal(await deleteIfUnchanged(failedDelete.store, "same"), "failed")
})

function forwarderWith(store: HostCrashMarkerStore, wasForwarded: (value: string) => boolean, emitResult = true) {
  const emitted: HostCrashMarker[] = []
  const marked: string[] = []
  return {
    emitted,
    marked,
    forwarder: {
      store,
      wasForwarded,
      markForwarded(value: string) { marked.push(value) },
      async emit(value: HostCrashMarker) { emitted.push(value); return emitResult },
    },
  }
}

test("a marker is forwarded once and forgotten only after it arrived", async () => {
  const raw = JSON.stringify(marker())
  const first = scriptedStore([{ kind: "present", raw }])
  const made = forwarderWith(first.store, () => false)
  assert.equal(await forwardHostCrashMarkerWith(made.forwarder), "delivered")
  assert.deepEqual(made.emitted, [marker()])
  assert.deepEqual(made.marked, [raw])
  assert.deepEqual(first.calls, ["readpresent", "readpresent", "delete"])

  const already = scriptedStore([{ kind: "present", raw }])
  const second = forwarderWith(already.store, () => true)
  assert.equal(await forwardHostCrashMarkerWith(second.forwarder), "delivered")
  assert.deepEqual(second.emitted, [])
  assert.deepEqual(already.calls, ["readpresent", "readpresent", "delete"])

  const cannotDelete = scriptedStore([{ kind: "present", raw }], "unavailable")
  const third = forwarderWith(cannotDelete.store, () => false)
  assert.equal(await forwardHostCrashMarkerWith(third.forwarder), "delete_deferred")
  assert.deepEqual(third.emitted, [marker()])
})

test("a marker is not delivered while the emitter refuses, and a bad marker is a parse error", async () => {
  const raw = JSON.stringify(marker())
  const refused = scriptedStore([{ kind: "present", raw }])
  const first = forwarderWith(refused.store, () => false, false)
  assert.equal(await forwardHostCrashMarkerWith(first.forwarder), "deferred")
  assert.deepEqual(first.marked, [])
  assert.deepEqual(refused.calls, ["readpresent"])

  const invalid = scriptedStore([{ kind: "present", raw: "not json" }])
  const second = forwarderWith(invalid.store, () => false)
  assert.equal(await forwardHostCrashMarkerWith(second.forwarder), "parse_error")
  assert.deepEqual(second.marked, ["not json"])
  assert.deepEqual(invalid.calls, ["readpresent", "readpresent", "delete"])
})

test("a store that cannot be read defers, and one with nothing to read is absent", async () => {
  const unavailable = scriptedStore([{ kind: "unavailable" }])
  assert.equal(await forwardHostCrashMarkerWith(forwarderWith(unavailable.store, () => false).forwarder), "deferred")
  const absent = scriptedStore([{ kind: "absent" }])
  assert.equal(await forwardHostCrashMarkerWith(forwarderWith(absent.store, () => false).forwarder), "absent")
})

test("a marker that changed under the forwarder is left pending", async () => {
  const raw = JSON.stringify(marker())
  let reads = 0
  const store: HostCrashMarkerStore = {
    async read() { reads += 1; return reads === 1 ? { kind: "present", raw } : { kind: "present", raw: "changed" } },
    async delete() { return "deleted" },
  }
  const made = forwarderWith(store, () => false)
  assert.equal(await forwardHostCrashMarkerWith(made.forwarder), "pending")
  assert.deepEqual(made.emitted, [marker()])
})
