import type { HostTrace } from "./send-trace-contracts.ts";
import { acquireTurnRootTrace } from "./send-trace-turn-context.ts";

let hostBundleVersion: string | undefined;

export function setTurnTraceHostBundleVersion(version?: string): void {
  const cleaned = version?.trim();
  hostBundleVersion = cleaned ? cleaned : undefined;
}

export function beginTurnTrace(options: {
  conversationId: string;
  turnType: string;
  parentCtx?: unknown;
  startTime?: number;
  sampleRatio?: number;
  attributes?: Record<string, unknown>;
}): HostTrace | undefined {
  try {
    const trace = acquireTurnRootTrace(options);
    if (trace == null) return undefined;

    trace.span.setAttribute("slate.conversation_id", options.conversationId);
    trace.span.setAttribute("slate.turn_type", options.turnType);
    if (hostBundleVersion !== undefined) trace.span.setAttribute("slate.host_bundle_version", hostBundleVersion);
    for (const [key, value] of Object.entries(options.attributes ?? {})) trace.span.setAttribute(key, value);
    return trace;
  } catch {
    return undefined;
  }
}

export function setTurnTraceAttributes(trace: HostTrace | undefined, attributes: Record<string, unknown>): void {
  try {
    for (const [key, value] of Object.entries(attributes)) trace?.span.setAttribute(key, value);
  } catch {
    // Tracing is best-effort and must not interrupt the turn.
  }
}

export function markTurnTraceError(trace: HostTrace | undefined, error: unknown): void {
  try {
    trace?.span.recordException(error instanceof Error ? error : new Error(String(error)));
    trace?.span.setStatus({ code: 2 });
    trace?.span.setAttribute("slate.outcome", "error");
  } catch {
    // A broken span must not replace the original turn error.
  }
}
