import assert from "node:assert/strict"
import { test } from "node:test"

import { createNotifyBusHandlers } from "../../source/host/extensions/notify-bus/notify-bus-handlers.ts"
import {
  observeNotifyBusGates,
  type NotifyBusBooleanGate,
  type NotifyBusGateName,
} from "../../source/host/extensions/notify-bus/notify-bus-gate-runtime.ts"

function booleanGate(initial: boolean) {
  let current = initial
  const listeners = new Set<(value: boolean) => void>()
  const gate: NotifyBusBooleanGate & { set(value: boolean): void; subscriberCount(): number } = {
    get: () => current,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    set(value) {
      current = value
      for (const listener of [...listeners]) listener(value)
    },
    subscriberCount: () => listeners.size,
  }
  return gate
}

test("topic subscribers are isolated, removable and cleared at teardown", () => {
  const failures: string[] = []
  const calls: string[] = []
  const handlers = createNotifyBusHandlers(message => failures.push(message))
  const remove = handlers.subscribe("automation-fires", () => calls.push("first"))
  handlers.subscribe("automation-fires", () => { throw new Error("listener failed") })
  handlers.subscribe("automation-fires", () => calls.push("last"))

  assert.doesNotThrow(() => handlers.dispatch("automation-fires"))
  assert.deepEqual(calls, ["first", "last"])
  assert.equal(failures.length, 1)
  assert.match(failures[0] ?? "", /automation-fires drain handler failed/)

  remove()
  handlers.dispatch("automation-fires")
  assert.deepEqual(calls, ["first", "last", "last"])
  handlers.clear()
  handlers.dispatch("automation-fires")
  assert.deepEqual(calls, ["first", "last", "last"])
})

test("feature gates wait for background readiness and start or stop only on transitions", async () => {
  let resolveReady!: () => void
  const ready = new Promise<void>(resolve => { resolveReady = resolve })
  const bus = booleanGate(true)
  const safety = booleanGate(false)
  const gateNames: NotifyBusGateName[] = []
  const cleanup: Array<() => void> = []
  const safetyValues: boolean[] = []
  let stopped = false
  let starts = 0
  let stops = 0

  observeNotifyBusGates({
    whenBackgroundWorkReady: ready,
    getGate(name) {
      gateNames.push(name)
      return name === "slate_notify_bus" ? bus : safety
    },
    isStopped: () => stopped,
    onStop: disposer => cleanup.push(disposer),
    startClient: () => { starts += 1 },
    stopClient: () => { stops += 1 },
    setSafetyPollEnabled: value => safetyValues.push(value),
  })

  assert.deepEqual(gateNames, [])
  assert.deepEqual([starts, stops, safetyValues.length], [0, 0, 0])
  resolveReady()
  await ready
  await Promise.resolve()

  assert.deepEqual(gateNames, ["slate_notify_bus", "slate_notify_safety_poll"])
  assert.deepEqual([starts, stops], [1, 0])
  assert.deepEqual(safetyValues, [false])
  bus.set(true)
  bus.set(false)
  bus.set(false)
  bus.set(true)
  safety.set(true)
  assert.deepEqual([starts, stops], [2, 1])
  assert.deepEqual(safetyValues, [false, true])
  assert.deepEqual([bus.subscriberCount(), safety.subscriberCount()], [1, 1])

  for (const dispose of cleanup) dispose()
  assert.deepEqual([bus.subscriberCount(), safety.subscriberCount()], [0, 0])
  stopped = true
  bus.set(false)
  bus.set(true)
  assert.deepEqual([starts, stops], [2, 1])
})

test("readiness that resolves after shutdown installs no gate listeners", async () => {
  let resolveReady!: () => void
  const ready = new Promise<void>(resolve => { resolveReady = resolve })
  const cleanup: Array<() => void> = []
  const gateNames: NotifyBusGateName[] = []
  let starts = 0

  observeNotifyBusGates({
    whenBackgroundWorkReady: ready,
    getGate(name) {
      gateNames.push(name)
      return booleanGate(true)
    },
    isStopped: () => true,
    onStop: dispose => cleanup.push(dispose),
    startClient: () => { starts += 1 },
    stopClient: () => {},
    setSafetyPollEnabled: () => {},
  })

  resolveReady()
  await ready
  await Promise.resolve()
  assert.deepEqual(gateNames, [])
  assert.deepEqual(cleanup, [])
  assert.equal(starts, 0)
})
