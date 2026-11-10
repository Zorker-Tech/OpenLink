import { mintTraceparent, shouldSampleSend } from "../shared/observability/send-trace.ts";
import { currentHostTraceFactory } from "./send-trace-registry.ts";
import { SLATE_TURN_ROOT_SPAN_NAME, type HostTrace } from "./send-trace-contracts.ts";
import { resolveTurnTraceSampleRatio } from "./send-trace-turn-policy.ts";

interface TurnRootRequest {
  conversationId: string;
  turnType: string;
  parentCtx?: unknown;
  startTime?: number;
  sampleRatio?: number;
}

function turnSpanFields(request: TurnRootRequest) {
  const conversation = request.conversationId;
  const category = request.turnType;
  return {
    name: SLATE_TURN_ROOT_SPAN_NAME,
    ...(request.startTime == null ? {} : { startTime: request.startTime }),
    inheritableAttributes: {
      "slate.conversation_id": conversation,
      "slate.turn_type": category,
    },
  };
}

function inheritCurrentTrace(request: TurnRootRequest, fields: ReturnType<typeof turnSpanFields>): HostTrace | undefined {
  if (request.parentCtx === undefined) return undefined;
  return currentHostTraceFactory()?.({ ...fields, parentCtx: request.parentCtx });
}

function startSampledTrace(request: TurnRootRequest, fields: ReturnType<typeof turnSpanFields>): HostTrace | undefined {
  const ratio = request.sampleRatio ?? resolveTurnTraceSampleRatio();
  if (!shouldSampleSend(ratio)) return undefined;

  const rootParent = mintTraceparent(true);
  if (rootParent == null) return undefined;
  return currentHostTraceFactory()?.({ ...fields, traceparent: rootParent.traceparent });
}

export function acquireTurnRootTrace(request: TurnRootRequest): HostTrace | undefined {
  const fields = turnSpanFields(request);
  return inheritCurrentTrace(request, fields) ?? startSampledTrace(request, fields);
}
