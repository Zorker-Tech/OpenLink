/**
 * Tracing a call to the backend.
 *
 * The span is opened with the caller's context, the traceparent travels with the request, and what the backend answers
 * with is recorded on the span — so a call can be followed from the host to the far side.
 */
import { createExpiryPolicy, realClock, type ExpiryPolicy } from "../../../host/extensions/scheduling.ts";
import type { Interceptor } from "@connectrpc/connect";

export const UNTRACED_SERVICE_TYPE_NAMES = new Set(["aiserver.v1.AnalyticsService"]);
export const SLATE_RPC_TRACE_WINDOW_DURATION_MS = 2 * 60 * 1_000;

export interface RpcSpanContext { readonly traceId: string; readonly spanId: string; readonly traceFlags: number }
export interface RpcSpan {
  spanContext(): RpcSpanContext;
  setAttribute(name: string, value: string | number | boolean): void;
  setStatus(status: { readonly code: "ERROR"; readonly message: string }): void;
  end(): void;
}
export interface RpcTracer {
  startSpan(name: string, options: { readonly kind?: "CLIENT"; readonly attributes: Readonly<Record<string, string | number | boolean>> }, parentContext?: unknown): RpcSpan;
}
export interface RpcTracingOptions {
  readonly getTracer: (sampler: "always-on") => RpcTracer | undefined;
  readonly getPolicy?: () => { readonly enabled: boolean; readonly sampleRatio: number };
  readonly sessionId?: string;
  readonly random?: () => number;
  readonly randomUUID?: () => string;
  readonly setSpanContext?: (span: RpcSpan) => unknown;
  readonly expiryPolicy?: ExpiryPolicy;
  readonly connectErrorCode?: (error: unknown) => string | undefined;
}
export interface RpcHeader { get(name: string): string | null; set(name: string, value: string): void }
export interface RpcRequest {
  readonly service: { readonly typeName: string };
  readonly method: { readonly name: string };
  readonly stream: boolean;
  readonly header: RpcHeader;
}
export interface RpcResponse { readonly stream: boolean }
export type RpcNext<Request extends RpcRequest = RpcRequest, Response extends RpcResponse = RpcResponse> = (request: Request) => Promise<Response>;

let configured: RpcTracingOptions | undefined;
let activeTraceWindow: { rootSpan: RpcSpan; parentContext: unknown; expiry: { dispose(): void } } | undefined;
const defaultExpiry = createExpiryPolicy(realClock, { name: "slate-rpc-trace-window", ttlMs: SLATE_RPC_TRACE_WINDOW_DURATION_MS });

export function configureSlateRpcTracing(options: RpcTracingOptions | undefined): void { configured = options; }

export function startSlateRpcTraceWindow(): boolean {
  if (configured === undefined) return false;
  try {
    const tracer = configured.getTracer("always-on");
    if (tracer === undefined) return false;
    endSlateRpcTraceWindow();
    const rootSpan = tracer.startSpan("slate.rpc.trace_window", { attributes: { "slate.trace_window.duration_ms": SLATE_RPC_TRACE_WINDOW_DURATION_MS, ...(configured.sessionId === undefined ? {} : { "slate.session_id": configured.sessionId }) } });
    activeTraceWindow = {
      rootSpan,
      parentContext: configured.setSpanContext?.(rootSpan) ?? rootSpan,
      expiry: (configured.expiryPolicy ?? defaultExpiry).arm("slate-rpc-trace-window", endSlateRpcTraceWindow),
    };
    return true;
  } catch { return false; }
}

export function endSlateRpcTraceWindow(): void {
  const window = activeTraceWindow;
  if (window === undefined) return;
  activeTraceWindow = undefined;
  window.expiry.dispose();
  window.rootSpan.end();
}

export function isValidSpanContext(context: RpcSpanContext): boolean {
  return /^[0-9a-f]{32}$/i.test(context.traceId) && !/^0+$/.test(context.traceId)
    && /^[0-9a-f]{16}$/i.test(context.spanId) && !/^0+$/.test(context.spanId);
}
export function spanTraceparent(span: RpcSpan): string | undefined {
  const context = span.spanContext();
  if (!isValidSpanContext(context)) return undefined;
  const flags = (context.traceFlags & 1) === 1 ? "01" : "00";
  return `00-${context.traceId}-${context.spanId}-${flags}`;
}
export function getSlateRpcTraceWindowTraceparent(): string | undefined { return activeTraceWindow === undefined ? undefined : spanTraceparent(activeTraceWindow.rootSpan); }

function resolveTraceDecision(): { tracer: RpcTracer; parentContext?: unknown } | undefined {
  if (configured === undefined) return undefined;
  try {
    if (activeTraceWindow !== undefined) {
      const tracer = configured.getTracer("always-on");
      return tracer === undefined ? undefined : { tracer, parentContext: activeTraceWindow.parentContext };
    }
    const policy = configured.getPolicy?.() ?? { enabled: true, sampleRatio: 1 };
    if (!policy.enabled || (configured.random ?? Math.random)() >= policy.sampleRatio) return undefined;
    const tracer = configured.getTracer("always-on");
    return tracer === undefined ? undefined : { tracer };
  } catch { return undefined; }
}

export function pinRequestId(header: RpcHeader): string {
  const pinned = header.get("x-request-id");
  if (pinned != null && pinned !== "") return pinned;
  const minted = configured?.randomUUID?.() ?? globalThis.crypto.randomUUID();
  header.set("x-request-id", minted);
  return minted;
}
export function injectTraceparent(header: RpcHeader, span: RpcSpan): void { const traceparent = spanTraceparent(span); if (traceparent !== undefined) header.set("traceparent", traceparent); }

export function createSlateRpcTracingInterceptor(): Interceptor {
  return (next) => async (request) => {
    if (UNTRACED_SERVICE_TYPE_NAMES.has(request.service.typeName)) return await next(request);
    const decision = resolveTraceDecision();
    if (decision === undefined) return await next(request);
    const requestId = pinRequestId(request.header);
    const span = decision.tracer.startSpan(`${request.service.typeName}/${request.method.name}`, {
      kind: "CLIENT",
      attributes: {
        "rpc.system": "connectrpc",
        "rpc.service": request.service.typeName,
        "rpc.method": request.method.name,
        "slate.rpc.request_streaming": request.stream,
        "slate.request_id": requestId,
        ...(configured?.sessionId === undefined ? {} : { "slate.session_id": configured.sessionId }),
      },
    }, decision.parentContext);
    injectTraceparent(request.header, span);
    try {
      const response = await next(request);
      span.setAttribute("slate.rpc.bounded_at", response.stream ? "response-stream-start" : "response-complete");
      span.end();
      return response;
    } catch (error) {
      const connectLabel = configured?.connectErrorCode?.(error);
      const label = connectLabel ?? (error instanceof Error ? error.name : typeof error);
      if (connectLabel !== undefined) span.setAttribute("rpc.connect_rpc.error_code", label);
      span.setStatus({ code: "ERROR", message: label });
      span.end();
      throw error;
    }
  };
}
