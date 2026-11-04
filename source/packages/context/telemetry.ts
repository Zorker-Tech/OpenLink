import {
  createRuntimeSpan,
  createRuntimeSpanFromRemoteContext,
  getRuntimeSpanContext,
  wrapRuntimeRemoteSpanContext,
} from "../../adapters/interop/telemetry/trace-runtime-adapter.ts"
import { createContext, createKey, type Context } from "./context.ts"

export type TelemetryAttributeValue =
  | string
  | number
  | boolean
  | readonly (string | number | boolean)[]

export const TelemetrySpanKind = {
  INTERNAL: "internal",
  SERVER: "server",
  CLIENT: "client",
  PRODUCER: "producer",
  CONSUMER: "consumer",
} as const

export type TelemetrySpanKind = typeof TelemetrySpanKind[keyof typeof TelemetrySpanKind]

export const TelemetrySpanStatusCode = {
  UNSET: 0,
  OK: 1,
  ERROR: 2,
} as const

export interface TelemetrySpanStatus {
  readonly code: number
  readonly message?: string | undefined
}

export interface TelemetrySpanOptions {
  readonly kind?: TelemetrySpanKind | undefined
  readonly attributes?: Readonly<Record<string, TelemetryAttributeValue>> | undefined
  readonly startTime?: number | Date | undefined
}

export interface TelemetrySpanContext {
  readonly traceId: string
  readonly spanId: string
  readonly traceFlags: number
  readonly traceState?: string | undefined
  readonly isRemote?: boolean | undefined
}

export interface SerializableSpanContext {
  traceId: string
  spanId: string
  traceFlags: number
  traceState?: string | undefined
}

export interface TelemetrySpan {
  setAttribute(key: string, value: TelemetryAttributeValue): void
  recordException(error: unknown): void
  setStatus(status: TelemetrySpanStatus): void
  spanContext(): TelemetrySpanContext
  end(endTime?: number | Date): void
}

export interface TelemetryTracer {
  startSpan(name: string, options?: TelemetrySpanOptions, parent?: TelemetrySpan): TelemetrySpan
}

export const DEFAULT_TRACER_NAME = "work-context"

const SPAN_KEY = createKey<TelemetrySpan | undefined>(Symbol("slate.telemetry.span"), undefined)
const ROOT_SPAN_KEY = createKey<TelemetrySpan | undefined>(Symbol("slate.telemetry.root_span"), undefined)
const ROOT_SPAN_START_MS_KEY = createKey<number | undefined>(Symbol("slate.telemetry.root_start_ms"), undefined)
const SUPPRESS_CHILD_SPANS_KEY = createKey(Symbol("slate.telemetry.suppress_child_spans"), false)

export const INHERITABLE_SPAN_ATTRIBUTES_KEY = createKey<Record<string, TelemetryAttributeValue>>(
  Symbol("slate.telemetry.inheritable_attributes"),
  {},
)

export function getTracer(name: string = DEFAULT_TRACER_NAME): TelemetryTracer {
  return {
    startSpan: (spanName, options, parent) => createRuntimeSpan(spanName, options, parent, name),
  }
}

export function withSpan(ctx: Context, options?: TelemetrySpanOptions): Context {
  const parentSpan = ctx.get(SPAN_KEY)
  if (ctx.get(SUPPRESS_CHILD_SPANS_KEY) && parentSpan) return ctx

  const span = getTracer().startSpan(ctx.name || "anonymous-context", options, parentSpan)
  const inherited = ctx.get(INHERITABLE_SPAN_ATTRIBUTES_KEY)
  for (const [key, value] of Object.entries(inherited)) {
    span.setAttribute(key, value)
  }

  let child = ctx.with(SPAN_KEY, span)
  if (parentSpan === undefined) {
    child = child.with(ROOT_SPAN_KEY, span).with(ROOT_SPAN_START_MS_KEY, Date.now())
  }
  return child
}

export function getSpan(ctx: Context): TelemetrySpan | undefined {
  return ctx.get(SPAN_KEY)
}

export function withSuppressedChildSpans(ctx: Context): Context {
  return ctx.with(SUPPRESS_CHILD_SPANS_KEY, true)
}

export function withInheritableAttribute(
  ctx: Context,
  key: string,
  value: TelemetryAttributeValue,
): Context {
  const inherited = ctx.get(INHERITABLE_SPAN_ATTRIBUTES_KEY)
  getSpan(ctx)?.setAttribute(key, value)
  return ctx.with(INHERITABLE_SPAN_ATTRIBUTES_KEY, { ...inherited, [key]: value })
}

export function getSpanContextData(ctx: Context): SerializableSpanContext | undefined {
  try {
    const span = getSpan(ctx)
    if (span === undefined) return undefined
    const context = getRuntimeSpanContext(span)
    return {
      traceId: context.traceId,
      spanId: context.spanId,
      traceFlags: ctx.get(SUPPRESS_CHILD_SPANS_KEY) ? 0 : context.traceFlags,
      traceState: context.traceState,
    }
  } catch {
    return undefined
  }
}

type RemoteSpanContext = Pick<SerializableSpanContext, "traceId" | "spanId" | "traceFlags">

export function createContextFromSpanContext(
  spanContext: RemoteSpanContext,
  name?: string,
  existingContext?: Context,
): Context {
  const span = createRuntimeSpanFromRemoteContext(spanContext, name || "child.span", DEFAULT_TRACER_NAME)
  const parent = existingContext ?? createContext()
  const named = name ? parent.withName(name) : parent
  return named.with(SPAN_KEY, span)
}

export function createContextFromRemoteSpanContext(
  spanContext: RemoteSpanContext,
  name?: string,
  existingContext?: Context,
): Context {
  const span = wrapRuntimeRemoteSpanContext(spanContext)
  const parent = existingContext ?? createContext()
  const named = name ? parent.withName(name) : parent
  return named.with(SPAN_KEY, span)
}

export class DisposableSpan implements Disposable {
  readonly ctx: Context
  readonly span: TelemetrySpan
  private readonly shouldEnd: boolean

  constructor(ctx: Context, span: TelemetrySpan, shouldEnd = true) {
    this.ctx = ctx
    this.span = span
    this.shouldEnd = shouldEnd
  }

  [Symbol.dispose](): void {
    if (this.shouldEnd) this.span.end()
  }
}

export function createSpan(ctx: Context, options?: TelemetrySpanOptions): DisposableSpan {
  const parentSpan = getSpan(ctx)
  const suppressEnd = parentSpan !== undefined && ctx.get(SUPPRESS_CHILD_SPANS_KEY)
  const spanContext = withSpan(ctx, options)
  const span = getSpan(spanContext)
  if (span === undefined) throw new Error("createSpan produced a context without a span")
  return new DisposableSpan(spanContext, span, !suppressEnd)
}

export function recordCompletedSpanIfParented(
  ctx: Context,
  options?: TelemetrySpanOptions,
  endTime?: number | Date,
): TelemetrySpan | undefined {
  if (getSpan(ctx) === undefined || ctx.get(SUPPRESS_CHILD_SPANS_KEY)) return undefined
  const child = withSpan(ctx, options)
  const span = getSpan(child)
  if (span === undefined) return undefined
  span.end(endTime)
  return span
}

export function reportEvent(ctx: Context, name: string): void {
  try {
    const parent = getSpan(ctx)
    if (parent === undefined) return
    const event = getTracer().startSpan(name, undefined, parent)
    for (const [key, value] of Object.entries(ctx.get(INHERITABLE_SPAN_ATTRIBUTES_KEY))) {
      event.setAttribute(key, value)
    }
    const rootStart = ctx.get(ROOT_SPAN_START_MS_KEY)
    const elapsedMs = typeof rootStart === "number" ? Date.now() - rootStart : 0
    const key = "event." + name
    const root = ctx.get(ROOT_SPAN_KEY) ?? parent
    root.setAttribute(key, elapsedMs)
    event.setAttribute(key, elapsedMs)
    event.end()
  } catch {
    // Diagnostics are best-effort by design.
  }
}
