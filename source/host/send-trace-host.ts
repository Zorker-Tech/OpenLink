export {
  SLATE_TURN_ROOT_SPAN_NAME,
  type HostTrace,
  type TraceFactory,
  type TraceSpan,
} from "./send-trace-contracts.ts";
export { setHostTraceFactory } from "./send-trace-registry.ts";
export { adoptRemoteParent, beginGatewayCommandTrace, beginSendTrace } from "./send-trace-remote-parent.ts";
export {
  resolveTurnTraceOutcome,
  resolveTurnTraceSampleRatio,
  resolveTurnTraceType,
} from "./send-trace-turn-policy.ts";
export {
  beginTurnTrace,
  markTurnTraceError,
  setTurnTraceAttributes,
  setTurnTraceHostBundleVersion,
} from "./send-trace-turn.ts";
export { traceSendPhase } from "./send-trace-phase.ts";
