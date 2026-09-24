import { after, beforeEach, test } from "node:test"
import assert from "node:assert/strict"
import { SpanKind } from "@opentelemetry/api"
import { InMemorySpanExporter, NodeTracerProvider, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-node"

import { createContext } from "../../source/packages/context/context.ts"
import {
  createContextFromRemoteSpanContext,
  createContextFromSpanContext,
  createSpan,
  DEFAULT_TRACER_NAME,
  DisposableSpan,
  getSpan,
  getSpanContextData,
  recordCompletedSpanIfParented,
  reportEvent,
  withInheritableAttribute,
  withSpan,
  withSuppressedChildSpans,
} from "../../source/packages/context/telemetry.ts"

// One provider for the whole file: the API's global registration is a one-shot for a process, so
// each test resets the exporter instead of installing its own provider.
const exporter = new InMemorySpanExporter()
const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] })
provider.register()

beforeEach(() => exporter.reset())
after(async () => {
  await provider.shutdown()
})

test("a span is named after its context and nested under the enclosing span", () => {
  const root = createContext().withName("agent-turn")
  const outer = withSpan(root)
  const inner = withSpan(outer.withName("tool-call"))
  const outerSpan = getSpan(outer)
  const innerSpan = getSpan(inner)
  assert.ok(outerSpan && innerSpan)
  assert.equal(outerSpan.spanContext().traceId, innerSpan.spanContext().traceId, "one trace")

  innerSpan.end()
  outerSpan.end()

  const spans = exporter.getFinishedSpans()
  const innerRecord = spans.find(span => span.name === "tool-call")
  const outerRecord = spans.find(span => span.name === "agent-turn")
  assert.equal(innerRecord?.parentSpanContext?.spanId, outerSpan.spanContext().spanId)
  assert.equal(outerRecord?.parentSpanContext, undefined, "the outermost span is the trace root")
})

test("an unnamed context still produces a span", () => {
  const ctx = withSpan(createContext())
  getSpan(ctx)?.end()
  assert.equal(exporter.getFinishedSpans()[0]?.name, "anonymous-context")
})

test("suppression flattens a subtree onto the enclosing span", () => {
  const ctx = withSpan(createContext().withName("poll"))
  const suppressed = withSuppressedChildSpans(ctx)
  const flattened = withSpan(suppressed.withName("poll-attempt"))

  assert.equal(getSpan(flattened), getSpan(ctx), "no new span is started below a suppressed context")
  assert.equal(getSpanContextData(suppressed)?.traceFlags, 0, "peers are told not to link into it")

  const disposable = createSpan(suppressed, { kind: SpanKind.INTERNAL })
  disposable[Symbol.dispose]()
  assert.equal(exporter.getFinishedSpans().length, 0, "disposing a suppressed span leaves its parent open")

  getSpan(ctx)?.end()
  assert.equal(exporter.getFinishedSpans().length, 1)
})

test("inheritable attributes reach the current span and everything below it", () => {
  const ctx = withInheritableAttribute(createContext(), "agent.id", "a1")
  const withMore = withInheritableAttribute(ctx, "box.id", "box-7").withName("run")
  const outer = withSpan(withMore)
  const inner = withSpan(outer.withName("child"))
  getSpan(inner)?.end()
  getSpan(outer)?.end()

  const spans = exporter.getFinishedSpans()
  assert.deepEqual(spans.find(span => span.name === "run")?.attributes, { "agent.id": "a1", "box.id": "box-7" })
  assert.deepEqual(spans.find(span => span.name === "child")?.attributes, { "agent.id": "a1", "box.id": "box-7" })
})

test("a disposable span ends itself on dispose, even when the scope throws", () => {
  const ctx = createContext().withName("scoped")
  try {
    using span = createSpan(ctx, { kind: SpanKind.INTERNAL })
    assert.equal(getSpan(span.ctx), span.span)
    assert.equal(exporter.getFinishedSpans().length, 0)
    throw new Error("work failed")
  } catch {
    // the span must be finished anyway
  }
  const spans = exporter.getFinishedSpans()
  assert.equal(spans.length, 1)
  assert.equal(spans[0]?.name, "scoped")
})

test("a completed span is only recorded when there is a parent to attach it to", () => {
  assert.equal(recordCompletedSpanIfParented(createContext(), { kind: SpanKind.INTERNAL }), undefined)
  assert.equal(exporter.getFinishedSpans().length, 0, "a bare context is not the start of a trace")

  const withParent = withSpan(createContext().withName("run"))
  const recorded = recordCompletedSpanIfParented(withParent.withName("milestone"))
  assert.equal(recorded?.spanContext().traceId, getSpan(withParent)?.spanContext().traceId)
  assert.equal(exporter.getFinishedSpans()[0]?.name, "milestone")
})

test("reportEvent marks the trace root and emits a span of its own", () => {
  const root = withSpan(createContext().withName("run"))
  const deeper = withSpan(root.withName("phase"))
  reportEvent(deeper, "checkpoint")
  getSpan(deeper)?.end()
  getSpan(root)?.end()

  const spans = exporter.getFinishedSpans()
  const rootSpan = spans.find(span => span.name === "run")
  const eventSpan = spans.find(span => span.name === "checkpoint")
  assert.equal(typeof rootSpan?.attributes["event.checkpoint"], "number")
  assert.equal(eventSpan?.attributes["event.checkpoint"], rootSpan?.attributes["event.checkpoint"])
  assert.equal(eventSpan?.parentSpanContext?.spanId, getSpan(deeper)?.spanContext().spanId)
})

test("reportEvent is a no-op without a parent span and never throws", () => {
  reportEvent(createContext(), "ignored")
  assert.equal(exporter.getFinishedSpans().length, 0, "a bare context has no trace to mark")

  const ctx = withSpan(createContext())
  reportEvent(ctx, "")
  getSpan(ctx)?.end()
  assert.equal(exporter.getFinishedSpans().filter(span => span.name === "").length, 1)
})

test("a derived context is unnamed, so names travel through the path", () => {
  const ctx = createContext().withName("run")
  const derived = ctx.with({ symbol: Symbol("k"), defaultValue: 0 }, 1)
  assert.equal(derived.name, undefined, "with() yields an unnamed context")
  assert.deepEqual(derived.getPath(), ["run"], "the chain still reports where it came from")
  assert.equal(ctx.withName("named").name, "named")
})

test("span identity can be handed to a peer and adopted back", () => {
  const ctx = withSpan(createContext().withName("local"))
  const data = getSpanContextData(ctx)
  assert.ok(data)
  assert.match(data.traceId, /^[0-9a-f]{32}$/)
  assert.match(data.spanId, /^[0-9a-f]{16}$/)

  const adopted = createContextFromRemoteSpanContext(data, "remote")
  assert.equal(getSpanContextData(adopted)?.traceId, data.traceId)
  assert.equal(getSpanContextData(adopted)?.spanId, data.spanId)
  assert.deepEqual(adopted.getPath(), ["remote"])

  const continued = createContextFromSpanContext(data, "continued")
  getSpan(continued)?.end()
  getSpan(ctx)?.end()
  const continuedSpan = exporter.getFinishedSpans().find(span => span.name === "continued")
  assert.equal(continuedSpan?.parentSpanContext?.spanId, data.spanId)
  assert.equal(continuedSpan?.kind, SpanKind.INTERNAL)
})

test("a remote span context is inherited by descendants of the adopting context", () => {
  const data = { traceId: "0af7651916cd43dd8448eb211c80319c", spanId: "b7ad6b7169203331", traceFlags: 1 }
  const adopted = createContextFromRemoteSpanContext(data, "adopted")
  const child = adopted.withName("child")
  assert.equal(getSpan(child), getSpan(adopted))
  assert.deepEqual(child.getPath(), ["adopted", "child"])
})

test("DisposableSpan can be told to leave its span open", () => {
  const ctx = withSpan(createContext().withName("keeper"))
  const span = getSpan(ctx)
  assert.ok(span)
  new DisposableSpan(ctx, span, false)[Symbol.dispose]()
  assert.equal(exporter.getFinishedSpans().length, 0)
  span.end()
  assert.equal(exporter.getFinishedSpans().length, 1)
})

test("spans are attributed to the platform's tracer", () => {
  const ctx = withSpan(createContext().withName("attributed"))
  getSpan(ctx)?.end()
  const finished = exporter.getFinishedSpans()[0] as unknown as {
    instrumentationScope?: { name?: string }
    instrumentationLibrary?: { name?: string }
  } | undefined
  const scope = finished?.instrumentationScope ?? finished?.instrumentationLibrary
  assert.equal(scope?.name, DEFAULT_TRACER_NAME, "exporters and samplers match on this name")
})
