/**
 * Calling the backend with the context a request carries.
 *
 * The client is built from a transport, each call is traced with the span its own kind implies, and the context —
 * values, deadline and traceparent — travels with the call rather than being re-derived on the far side.
 */
import {
  createClient,
  createContextKey,
  createContextValues,
  type CallOptions,
  type Client,
  type Transport,
} from "@connectrpc/connect";
import type { Context } from "../context/context.ts";
import {
  getSpan,
  getSpanContextData,
  TelemetrySpanKind,
  TelemetrySpanStatusCode,
  withSpan,
  type TelemetrySpan,
} from "../context/telemetry.ts";

type ConnectService = Parameters<typeof createClient>[0];

export type ContextPropagatingClient<Service extends ConnectService> = {
  [Method in keyof Client<Service>]: Client<Service>[Method] extends (
    ...args: infer Args
  ) => infer Result
    ? (ctx: Context, ...args: Args) => Result
    : Client<Service>[Method];
};

/** The shape of the headers a call may be given — the transport's own, spelled here so the module does not need a DOM lib. */
type HeadersInit = Headers | Record<string, string> | ReadonlyArray<[string, string]>;

export interface ContextPropagationOptions {
  readonly injectTraceHeaders?: boolean;
  readonly extractHeaders?: (ctx: Context) => HeadersInit | undefined;
  readonly enableAbortSignal?: boolean;
}

const requestContextKey = createContextKey<Context | undefined>(undefined, {
  description: "slate.callerContext",
});

function isAsyncIterable(headerText: unknown): headerText is AsyncIterable<unknown> {
  return headerText !== null && typeof headerText === "object" && Symbol.asyncIterator in headerText;
}

function isPromiseLike(headerText: unknown): headerText is PromiseLike<unknown> {
  return headerText !== null
    && typeof headerText === "object"
    && "then" in headerText
    && typeof headerText.then === "function";
}

function wrapAsyncIterableWithSpan<T>(
  sourceStream: AsyncIterable<T>,
  span: TelemetrySpan | undefined,
  releaseSignalListener?: () => void,
): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      const sourceIterator = sourceStream[Symbol.asyncIterator]();
      let isFinished = false;
      const closeStream = (failure?: unknown): void => {
        if (isFinished) return;
        isFinished = true;
        if (failure) {
          span?.recordException(failure instanceof Error ? failure : new Error(String(failure)));
          span?.setStatus({
            code: TelemetrySpanStatusCode.ERROR,
            message: failure instanceof Error ? failure.message : "Stream failed",
          });
        } else {
          span?.setStatus({ code: TelemetrySpanStatusCode.OK });
        }
        span?.end();
        releaseSignalListener?.();
      };
      return {
        async next() {
          try {
            const callResult = await sourceIterator.next();
            if (callResult.done) closeStream();
            return callResult;
          } catch (failure) {
            closeStream(failure);
            throw failure;
          }
        },
        async return(headerText?: T) {
          closeStream();
          if (sourceIterator.return) return await sourceIterator.return(headerText);
          return { done: true, value: undefined };
        },
        async throw(failure?: unknown) {
          closeStream(failure);
          if (sourceIterator.throw) return await sourceIterator.throw(failure);
          throw failure;
        },
      };
    },
  };
}

function extractTraceHeaders(ctx: Context): Headers {
  const traceHeaders = new Headers();
  try {
    const spanContext = getSpanContextData(ctx);
    if (spanContext?.traceId && spanContext.spanId) {
      const traceFlags = spanContext.traceFlags ?? 0;
      const traceHeader = `00-${spanContext.traceId}-${spanContext.spanId}-${traceFlags.toString(16).padStart(2, "0")}`;
      traceHeaders.set("traceparent", traceHeader);
      traceHeaders.set("backend-traceparent", traceHeader);
      if (spanContext.traceState) traceHeaders.set("tracestate", spanContext.traceState);
    }
  } catch {}
  return traceHeaders;
}

function mergeHeaders(...headerSources: (HeadersInit | undefined)[]): Headers {
  const allHeaders = new Headers();
  for (const headerSource of headerSources) {
    if (!headerSource) continue;
    if (headerSource instanceof Headers) {
      headerSource.forEach((headerText, headerName) => allHeaders.set(headerName, headerText));
    } else {
      for (const [headerName, headerText] of Object.entries(headerSource)) {
        allHeaders.set(headerName, headerText as string);
      }
    }
  }
  return allHeaders;
}

function mergeContextSignal(
  contextSignal: AbortSignal,
  callerSignal?: AbortSignal,
): { signal: AbortSignal; cleanup?: () => void } {
  if (callerSignal === undefined || callerSignal === contextSignal) {
    return { signal: contextSignal };
  }
  const abortController = new AbortController();
  const abortFromContext = () => abortController.abort(contextSignal.reason);
  const abortFromProvided = () => abortController.abort(callerSignal.reason);
  contextSignal.addEventListener("abort", abortFromContext, { once: true });
  callerSignal.addEventListener("abort", abortFromProvided, { once: true });
  if (contextSignal.aborted) abortFromContext();
  else if (callerSignal.aborted) abortFromProvided();
  return {
    signal: abortController.signal,
    cleanup() {
      contextSignal.removeEventListener("abort", abortFromContext);
      callerSignal.removeEventListener("abort", abortFromProvided);
    },
  };
}

function addContextPropagation<Service extends ConnectService>(
  baseClient: Client<Service>,
  settings: ContextPropagationOptions,
): ContextPropagatingClient<Service> {
  const { injectTraceHeaders = true, extractHeaders } = settings;
  return new Proxy(baseClient, {
    get(targetClient, property) {
      const originalMethod: unknown = Reflect.get(targetClient, property);
      if (typeof originalMethod !== "function") return originalMethod;
      return (ctx: Context, input: unknown, callSettings: CallOptions = {}) => {
        const callSpanContext = withSpan(ctx.withName(`rpc.${String(property)}`), {
          kind: TelemetrySpanKind.CLIENT,
          attributes: {
            "rpc.method": String(property),
            "rpc.system": "connect",
          },
        });
        const span = getSpan(callSpanContext);
        let releaseSignalListener: (() => void) | undefined;
        try {
          let propagationHeaders: Headers | undefined;
          if (injectTraceHeaders) propagationHeaders = extractTraceHeaders(callSpanContext);
          if (extractHeaders) {
            const extraHeaders = extractHeaders(callSpanContext);
            if (extraHeaders) propagationHeaders = mergeHeaders(propagationHeaders, extraHeaders);
          }
          const headersForCall = mergeHeaders(callSettings.headers, propagationHeaders);
          const { signal, cleanup } = settings.enableAbortSignal === true
            ? mergeContextSignal(callSpanContext.signal, callSettings.signal)
            : { signal: callSettings.signal, cleanup: undefined };
          releaseSignalListener = cleanup;
          const contextValues = (callSettings.contextValues ?? createContextValues())
            .set(requestContextKey, callSpanContext);
          const enhancedCallSettings: CallOptions = {
            ...callSettings,
            headers: headersForCall,
            signal: signal!,
            contextValues,
          };
          const callResult: unknown = (originalMethod as (
            input: unknown,
            settings: CallOptions,
          ) => unknown).call(targetClient, input, enhancedCallSettings);
          if (isAsyncIterable(callResult)) {
            return wrapAsyncIterableWithSpan(callResult, span, releaseSignalListener);
          }
          if (isPromiseLike(callResult)) {
            return (callResult as Promise<unknown>).then((callResponse) => {
              if (isAsyncIterable(callResponse)) {
                return wrapAsyncIterableWithSpan(callResponse, span, releaseSignalListener);
              }
              span?.setStatus({ code: TelemetrySpanStatusCode.OK });
              span?.end();
              releaseSignalListener?.();
              return callResponse;
            }).catch((failure: unknown) => {
              span?.recordException(failure instanceof Error ? failure : new Error(String(failure)));
              span?.setStatus({
                code: TelemetrySpanStatusCode.ERROR,
                message: failure instanceof Error ? failure.message : "RPC call failed",
              });
              span?.end();
              releaseSignalListener?.();
              throw failure;
            });
          }
          span?.setStatus({ code: TelemetrySpanStatusCode.OK });
          span?.end();
          releaseSignalListener?.();
          return callResult;
        } catch (failure) {
          span?.recordException(failure instanceof Error ? failure : new Error(String(failure)));
          span?.setStatus({
            code: TelemetrySpanStatusCode.ERROR,
            message: failure instanceof Error ? failure.message : "RPC call failed",
          });
          span?.end();
          releaseSignalListener?.();
          throw failure;
        }
      };
    },
  }) as ContextPropagatingClient<Service>;
}

export function createContextPropagatingClient<Service extends ConnectService>(
  serviceDefinition: Service,
  rpcTransport: Transport,
  settings: ContextPropagationOptions = {},
): ContextPropagatingClient<Service> {
  return addContextPropagation(createClient(serviceDefinition, rpcTransport), settings);
}
