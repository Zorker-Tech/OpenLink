import { mintTraceparent, parseTraceparent, shouldSampleSend } from "../shared/observability/send-trace.ts";
import { currentHostTraceFactory } from "./send-trace-registry.ts";
import type { HostTrace } from "./send-trace-contracts.ts";

export function adoptRemoteParent(traceparent: string | undefined, spanName: string): HostTrace | undefined {
  if (typeof traceparent !== "string" || parseTraceparent(traceparent) == null) return undefined;
  try {
    return currentHostTraceFactory()?.({ name: spanName, traceparent });
  } catch {
    return undefined;
  }
}

export function beginSendTrace(traceparent?: string): HostTrace | undefined {
  return adoptRemoteParent(traceparent, "slate.send");
}

export function beginGatewayCommandTrace(options: { traceparent?: string; method: string }): HostTrace | undefined {
  return adoptRemoteParent(options.traceparent, `slate.gateway.${options.method}`);
}
