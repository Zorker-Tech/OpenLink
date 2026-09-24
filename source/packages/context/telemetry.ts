/**
 * The context-to-span bridge.
 *
 * Work does not start spans at module scope: a span is attached to the context an operation
 * carries, so nesting follows the call graph, attributes travel down the chain, and a whole
 * subtree can be flattened into one span when the fan-out would be noise (Box polling, tight
 * loops) instead of drowning the trace.
 */

import {
  SpanKind,
  context as otelContext,
  trace,
  type AttributeValue,
  type Span,
  type SpanContext,
  type SpanOptions,
  type TimeInput,
  type Tracer,
} from "@opentelemetry/api"

import { createContext, createKey, type Context } from "./context.ts"

/** Span identity in a form that can cross a process boundary and be restored later. */
interface SerializableSpanContext {
  traceId: string
  spanId: string
  traceFlags: number
  traceState?: string | undefined
}

const SPAN_KEY = createKey<Span | undefined>(Symbol("otel.span"), undefined)
const ROOT_SPAN_KEY = createKey<Span | undefined>(Symbol("otel.root_span"), undefined)
const ROOT_SPAN_START_MS_KEY = createKey<number | undefined>(Symbol("otel.root_start_ms"), undefined)
const SUPPRESS_CHILD_SPANS_KEY = createKey(Symbol("otel.suppress_child_spans"), false)

/** Attributes applied to every span started below the context holding them. */
export const INHERITABLE_SPAN_ATTRIBUTES_KEY = createKey<Record<string, AttributeValue>>(
  Symbol("otel.inheritable_span_attributes"),
  {},
)

/** Every span this package starts comes from here, so exporters can recognize the platform's own. */
export const DEFAULT_TRACER_NAME = "work-context"

export function getTracer(name: string = DEFAULT_TRACER_NAME): Tracer {
  return trace.getTracer(name)
}

/** A child context carrying a span — a child of the current span, or a root one if there is none. */
export function withSpan(ctx: Context, options?: SpanOptions): Context {
  const tracer = getTracer()
  const parentSpan = ctx.get(SPAN_KEY)
  if (ctx.get(SUPPRESS_CHILD_SPANS_KEY) && parentSpan) return ctx

  const spanName = ctx.name || "anonymous-context"
  const span = parentSpan
    ? tracer.startSpan(spanName, options, trace.setSpan(otelContext.active(), parentSpan))
    : tracer.startSpan(spanName, options)

  const inherited = ctx.get(INHERITABLE_SPAN_ATTRIBUTES_KEY)
  for (const key in inherited) {
    const value = inherited[key]
    if (value !== undefined) span.setAttribute(key, value)
  }

  let ctxWith = ctx.with(SPAN_KEY, span)
  if (!parentSpan) {
    ctxWith = ctxWith.with(ROOT_SPAN_KEY, span).with(ROOT_SPAN_START_MS_KEY, Date.now())
  }
  return ctxWith
}

export function getSpan(ctx: Context): Span | undefined {
  return ctx.get(SPAN_KEY)
}

/** Flattens this subtree: contexts derived from the result start no spans of their own. */
export function withSuppressedChildSpans(ctx: Context): Context {
  return ctx.with(SUPPRESS_CHILD_SPANS_KEY, true)
}

/** Adds an attribute to the current span and to every span started below this context. */
export function withInheritableAttribute(ctx: Context, key: string, value: AttributeValue): Context {
  const existing = ctx.get(INHERITABLE_SPAN_ATTRIBUTES_KEY)
  const span = getSpan(ctx)
  if (span) span.setAttribute(key, value)
  return ctx.with(INHERITABLE_SPAN_ATTRIBUTES_KEY, { ...existing, [key]: value })
}

/**
 * The current span's identity for a remote peer. A suppressed context reports trace flags 0, so
 * the peer starts an unlinked span instead of joining a trace that decided not to record.
 */
export function getSpanContextData(ctx: Context): SerializableSpanContext | undefined {
  try {
    const span = getSpan(ctx)
    if (!span) return undefined
    const spanContext = span.spanContext()
    return {
      traceId: spanContext.traceId,
      spanId: spanContext.spanId,
      traceFlags: ctx.get(SUPPRESS_CHILD_SPANS_KEY) ? 0 : spanContext.traceFlags,
      traceState: spanContext.traceState?.toString(),
    }
  } catch {
    return undefined
  }
}

type RemoteSpanContext = Pick<SpanContext, "traceId" | "spanId" | "traceFlags">

/** Continues a remote trace: the new span is a child of the peer's span. */
export function createContextFromSpanContext(
  spanContext: RemoteSpanContext,
  name?: string,
  existingContext?: Context,
): Context {
  const tracer = getTracer()
  const remoteSpanContext: SpanContext = { ...spanContext, isRemote: true }
  const parentOtelContext = trace.setSpanContext(otelContext.active(), remoteSpanContext)
  const span = tracer.startSpan(name || "child.span", { kind: SpanKind.INTERNAL }, parentOtelContext)
  const parentContext = existingContext ?? createContext()
  const ctx = name ? parentContext.withName(name) : parentContext
  return ctx.with(SPAN_KEY, span)
}

/** Adopts a remote span as this context's span without starting a new one. */
export function createContextFromRemoteSpanContext(
  spanContext: RemoteSpanContext,
  name?: string,
  existingContext?: Context,
): Context {
  const span = trace.wrapSpanContext({ ...spanContext, isRemote: true })
  const parentContext = existingContext ?? createContext()
  const ctx = name ? parentContext.withName(name) : parentContext
  return ctx.with(SPAN_KEY, span)
}

/** Ends its span on dispose — `using span = createSpan(...)` covers the error path too. */
export class DisposableSpan implements Disposable {
  readonly ctx: Context
  readonly span: Span
  private readonly shouldEnd: boolean

  constructor(ctx: Context, span: Span, shouldEnd = true) {
    this.ctx = ctx
    this.span = span
    this.shouldEnd = shouldEnd
  }

  [Symbol.dispose](): void {
    if (this.shouldEnd) this.span.end()
  }
}

export function createSpan(ctx: Context, options?: SpanOptions): DisposableSpan {
  const parentSpan = getSpan(ctx)
  const isSuppressed = parentSpan !== undefined && ctx.get(SUPPRESS_CHILD_SPANS_KEY)
  const ctxWithSpan = withSpan(ctx, options)
  const span = getSpan(ctxWithSpan)
  if (span === undefined) throw new Error("createSpan produced a context without a span")
  return new DisposableSpan(ctxWithSpan, span, !isSuppressed)
}

/** A span that is started and ended in one call: for work that is worth recording, not observing. */
export function recordCompletedSpanIfParented(
  ctx: Context,
  options?: SpanOptions,
  endTime?: TimeInput,
): Span | undefined {
  if (!getSpan(ctx) || ctx.get(SUPPRESS_CHILD_SPANS_KEY)) return undefined
  const ctxWithSpan = withSpan(ctx, options)
  const span = getSpan(ctxWithSpan)
  if (span === undefined) return undefined
  span.end(endTime)
  return span
}

/**
 * Records that `name` happened, as an attribute on the trace's root span plus a point-in-time
 * span, so a long run's internal milestones can be read off a single timeline. Telemetry must
 * never fail a caller's operation, so every error here is swallowed.
 */
export function reportEvent(ctx: Context, name: string): void {
  try {
    const tracer = getTracer()
    const parentSpan = getSpan(ctx)
    if (!parentSpan) return
    const parentOtelContext = trace.setSpan(otelContext.active(), parentSpan)
    const eventSpan = tracer.startSpan(name, undefined, parentOtelContext)
    const inherited = ctx.get(INHERITABLE_SPAN_ATTRIBUTES_KEY)
    for (const key in inherited) {
      const value = inherited[key]
      if (value !== undefined) eventSpan.setAttribute(key, value)
    }
    const rootStart = ctx.get(ROOT_SPAN_START_MS_KEY)
    const elapsedMs = typeof rootStart === "number" ? Date.now() - rootStart : 0
    const attributeKey = `event.${name}`
    const rootSpan = ctx.get(ROOT_SPAN_KEY) ?? parentSpan
    rootSpan.setAttribute(attributeKey, elapsedMs)
    eventSpan.setAttribute(attributeKey, elapsedMs)
    eventSpan.end()
  } catch {
    // Diagnostics are best-effort by design.
  }
}
