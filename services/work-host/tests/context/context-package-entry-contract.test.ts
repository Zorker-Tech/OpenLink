import assert from "node:assert/strict"
import { test } from "node:test"

import * as ContextEntry from "../../source/packages/context/index.ts"
import type {
  AbortReasonSummary,
  Context,
  ContextKey,
  ContextLogEntry,
  ContextLogger,
  ContextLoggerBackend,
  ContextLogLevel,
  InlineSerializerContext,
  PrettyTerminalLoggerOptions,
  SerializableSpanContext,
  TelemetryAttributeValue,
  TelemetrySpan,
  TelemetrySpanContext,
  TelemetrySpanKind,
  TelemetrySpanOptions,
  TelemetrySpanStatus,
  TelemetryTracer,
} from "../../source/packages/context/index.ts"

type PublicTypeContract = {
  abort: AbortReasonSummary
  context: Context
  key: ContextKey<number>
  logEntry: ContextLogEntry
  logger: ContextLogger
  loggerBackend: ContextLoggerBackend
  logLevel: ContextLogLevel
  inlineSerializer: InlineSerializerContext
  terminalOptions: PrettyTerminalLoggerOptions
  serializableSpanContext: SerializableSpanContext
  attribute: TelemetryAttributeValue
  span: TelemetrySpan
  spanContext: TelemetrySpanContext
  spanKind: TelemetrySpanKind
  spanOptions: TelemetrySpanOptions
  spanStatus: TelemetrySpanStatus
  tracer: TelemetryTracer
}

const typeContract: PublicTypeContract | undefined = undefined
void typeContract

test("the context package entry exposes only its named runtime API", () => {
  assert.deepEqual(Object.keys(ContextEntry).sort(), [
    "createContext",
    "createContextFromRemoteSpanContext",
    "createContextFromSpanContext",
    "createKey",
    "createLogger",
    "createPrettyTerminalLoggerBackend",
    "createSpan",
    "deadlineExceededError",
    "DEFAULT_TRACER_NAME",
    "DisposableSpan",
    "getLoggerBackend",
    "getSpan",
    "getSpanContextData",
    "getTracer",
    "INHERITABLE_SPAN_ATTRIBUTES_KEY",
    "loggerKey",
    "recordCompletedSpanIfParented",
    "reportEvent",
    "summarizeAbortReason",
    "TelemetrySpanKind",
    "TelemetrySpanStatusCode",
    "withInheritableAttribute",
    "withLogAttributes",
    "withSpan",
    "withSuppressedChildSpans",
  ].sort())
})
