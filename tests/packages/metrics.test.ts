import { test } from "node:test"
import assert from "node:assert/strict"

import { createContext } from "../../source/packages/context/context.ts"
import {
  createCounter,
  createGauge,
  createHistogram,
  getMetricsBackend,
  metricsKey,
  type MetricHandle,
  type MetricLabels,
  type MetricsBackend,
} from "../../source/packages/metrics/index.ts"

interface Recorded {
  readonly kind: "record" | "increment" | "gauge" | "histogram"
  readonly handle: MetricHandle
  readonly value: number
  readonly labels: MetricLabels | undefined
}

/** A backend that keeps every call, so the tests can assert what a metric reported. */
function recording(): { backend: MetricsBackend; calls: Recorded[] } {
  const calls: Recorded[] = []
  const keep = (kind: Recorded["kind"]) => (
    _context: Parameters<MetricsBackend["record"]>[0],
    handle: MetricHandle,
    value: number,
    labels?: MetricLabels,
  ): void => {
    calls.push({ kind, handle, value, labels })
  }
  return {
    calls,
    backend: {
      record: keep("record"),
      increment: keep("increment"),
      gauge: keep("gauge"),
      histogram: keep("histogram"),
    },
  }
}

test("nothing is emitted until a process installs a backend", () => {
  const context = createContext()
  assert.equal(getMetricsBackend(context), getMetricsBackend(createContext()), "one shared default")

  const counter = createCounter("work.commands")
  assert.doesNotThrow(() => {
    counter.increment(context)
    counter.record(context, 5)
  })
})

test("a counter defaults to one and passes the handle, value and labels through", () => {
  const { backend, calls } = recording()
  const context = createContext().with(metricsKey, backend)
  const counter = createCounter("work.commands", { description: "commands handled", labelNames: ["command"] })

  counter.increment(context)
  counter.increment(context, 3, { command: "work.agent.list" })
  counter.record(context, 12)

  assert.deepEqual(calls, [
    {
      kind: "increment",
      handle: { name: "work.commands", type: "counter", description: "commands handled", labelNames: ["command"] },
      value: 1,
      labels: undefined,
    },
    {
      kind: "increment",
      handle: { name: "work.commands", type: "counter", description: "commands handled", labelNames: ["command"] },
      value: 3,
      labels: { command: "work.agent.list" },
    },
    {
      kind: "record",
      handle: { name: "work.commands", type: "counter", description: "commands handled", labelNames: ["command"] },
      value: 12,
      labels: undefined,
    },
  ])
})

test("a handle keeps its optional keys even when no options were given", () => {
  const { backend, calls } = recording()
  const context = createContext().with(metricsKey, backend)
  createGauge("work.queue_depth").gauge(context, 4)

  const handle = calls[0]?.handle
  assert.equal(handle?.name, "work.queue_depth")
  assert.equal(handle?.type, "gauge")
  assert.deepEqual(Object.keys(handle ?? {}), ["name", "type", "description", "labelNames"])
  assert.equal(handle?.description, undefined)
  assert.equal(handle?.labelNames, undefined)
})

test("gauges and histograms report through their own method and through record", () => {
  const { backend, calls } = recording()
  const context = createContext().with(metricsKey, backend)

  createGauge("work.boxes_ready").gauge(context, 2)
  createGauge("work.boxes_ready").record(context, 2)
  createHistogram("work.run_duration_ms").histogram(context, 150, { phase: "boot" })
  createHistogram("work.run_duration_ms").record(context, 150, { phase: "boot" })

  assert.deepEqual(calls.map(call => call.kind), ["gauge", "record", "histogram", "record"])
  assert.equal(calls[0]?.handle.type, "gauge")
  assert.equal(calls[2]?.handle.type, "histogram")
  assert.deepEqual(calls[2]?.labels, { phase: "boot" })
})

test("the backend is read from the context, so one subtree can report somewhere else", () => {
  const parent = recording()
  const nested = recording()
  const root = createContext().with(metricsKey, parent.backend)
  const child = root.with(metricsKey, nested.backend)
  const counter = createCounter("work.runs")

  counter.increment(root)
  counter.increment(child)
  counter.increment(child.withName("deeper"))

  assert.equal(parent.calls.length, 1)
  assert.equal(nested.calls.length, 2, "a backend installed on a context covers what descends from it")
})

test("a metric declared at module scope is reusable across contexts", () => {
  const { backend, calls } = recording()
  const declaration = createCounter("work.agents_created")
  declaration.increment(createContext().with(metricsKey, backend))
  declaration.increment(createContext().with(metricsKey, backend), 2)

  assert.deepEqual(calls.map(call => call.value), [1, 2])
  assert.equal(calls[0]?.handle, calls[1]?.handle, "the handle is the same object for one declaration")
})
