import assert from "node:assert/strict"
import test from "node:test"
import { SlateHostEventBus } from "../../source/host/host-event-bus.ts"

interface HostNotice {
  readonly kind: "saved"
  readonly path: string
}

test("broadcast subscribers receive each event until they unsubscribe", () => {
  const bus = new SlateHostEventBus<HostNotice>()
  const received: string[] = []
  const stop = bus.subscribe(event => received.push(event.path))

  bus.emit({ kind: "saved", path: "/one" })
  stop()
  bus.emit({ kind: "saved", path: "/two" })

  assert.deepEqual(received, ["/one"])
})

test("a throwing broadcast listener is reported without stopping its peers", () => {
  const failures: Readonly<Record<string, unknown>>[] = []
  const bus = new SlateHostEventBus<HostNotice>(failure => failures.push(failure))
  const received: string[] = []
  bus.subscribe(() => { throw new Error("listener offline") })
  bus.subscribe(event => received.push(event.path))

  bus.emit({ kind: "saved", path: "/repo" })

  assert.deepEqual(received, ["/repo"])
  assert.deepEqual(failures, [{ kind: "listener_failed", errorClass: "Error" }])
})

test("topic subscribers all run and each failure is reported", async () => {
  const failures: Readonly<Record<string, unknown>>[] = []
  const bus = new SlateHostEventBus(failure => failures.push(failure))
  const received: unknown[] = []
  bus.on("box.ready", () => { throw new Error("first failed") })
  bus.on("box.ready", payload => { received.push(payload) })
  bus.on("box.ready", async () => { throw new Error("third failed") })

  await bus.emit("box.ready", { boxId: "box-1" })

  assert.deepEqual(received, [{ boxId: "box-1" }])
  assert.deepEqual(failures, [
    { kind: "subscriber_failed", topic: "box.ready", errorClass: "Error" },
    { kind: "subscriber_failed", topic: "box.ready", errorClass: "Error" },
  ])
})

test("a topic can reject after every subscriber has had a chance to run", async () => {
  const failures: Readonly<Record<string, unknown>>[] = []
  const bus = new SlateHostEventBus(failure => failures.push(failure))
  const received: unknown[] = []
  const firstFailure = new Error("first failed")
  bus.on("turn.done", () => { throw firstFailure })
  bus.on("turn.done", payload => { received.push(payload) })
  bus.on("turn.done", async () => { throw new Error("also failed") })

  await assert.rejects(bus.emit("turn.done", "turn-1", { failureMode: "reject" }), firstFailure)

  assert.deepEqual(received, ["turn-1"])
  assert.equal(failures.length, 2)
})

test("publishing to a topic without subscribers is a successful no-op", async () => {
  const bus = new SlateHostEventBus()
  await assert.doesNotReject(bus.emit("unused", undefined))
})
