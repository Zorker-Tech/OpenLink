import {
  SpanKind,
  context as activeContext,
  trace,
  type AttributeValue,
  type Span,
  type SpanContext,
  type SpanOptions,
  type TimeInput,
} from "@opentelemetry/api"
import type {
  TelemetrySpan,
  TelemetrySpanContext,
  TelemetrySpanKind,
  TelemetrySpanOptions,
} from "../../../packages/context/telemetry.ts"

const SPAN_KIND_MAP: Record<TelemetrySpanKind, SpanKind> = {
  internal: SpanKind.INTERNAL,
  server: SpanKind.SERVER,
  client: SpanKind.CLIENT,
  producer: SpanKind.PRODUCER,
  consumer: SpanKind.CONSUMER,
}

function sdkOptions(options?: TelemetrySpanOptions): SpanOptions | undefined {
  if (options === undefined) return undefined
  return {
    ...(options.kind === undefined ? {} : { kind: SPAN_KIND_MAP[options.kind] }),
    ...(options.attributes === undefined ? {} : { attributes: options.attributes as AttributeValue[] & Record<string, AttributeValue> }),
    ...(options.startTime === undefined ? {} : { startTime: options.startTime as TimeInput }),
  }
}

export function createRuntimeSpan(
  name: string,
  options: TelemetrySpanOptions | undefined,
  parent: TelemetrySpan | undefined,
  tracerName: string,
): TelemetrySpan {
  const parentContext = parent === undefined
    ? undefined
    : trace.setSpan(activeContext.active(), parent as unknown as Span)
  return trace.getTracer(tracerName).startSpan(name, sdkOptions(options), parentContext) as unknown as TelemetrySpan
}

export function createRuntimeSpanFromRemoteContext(
  spanContext: Pick<TelemetrySpanContext, "traceId" | "spanId" | "traceFlags">,
  name: string,
  tracerName: string,
): TelemetrySpan {
  const remoteContext: SpanContext = { ...spanContext, isRemote: true }
  const parentContext = trace.setSpanContext(activeContext.active(), remoteContext)
  return trace.getTracer(tracerName).startSpan(name, { kind: SpanKind.INTERNAL }, parentContext) as unknown as TelemetrySpan
}

export function wrapRuntimeRemoteSpanContext(
  spanContext: Pick<TelemetrySpanContext, "traceId" | "spanId" | "traceFlags">,
): TelemetrySpan {
  const remoteContext: SpanContext = { ...spanContext, isRemote: true }
  return trace.wrapSpanContext(remoteContext) as unknown as TelemetrySpan
}

export function getRuntimeSpanContext(span: TelemetrySpan): TelemetrySpanContext {
  const context = (span as unknown as Span).spanContext()
  return {
    traceId: context.traceId,
    spanId: context.spanId,
    traceFlags: context.traceFlags,
    traceState: context.traceState?.toString(),
    isRemote: context.isRemote,
  }
}
