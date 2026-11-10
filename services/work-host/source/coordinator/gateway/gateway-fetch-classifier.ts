import { DeadlineExceededError } from "../../host/extensions/scheduling.ts";
import {
  GATEWAY_ACCESS_DENIED_MESSAGE_MARKER,
  GATEWAY_NO_STORAGE_MESSAGE_MARKER,
  hasBoxBlockedMarker,
} from "../../shared/gateway-reachability.ts";
import { findSystemErrno } from "../../shared/system-errno.ts";
import {
  SlateGatewayUnreachableError,
  type GatewayFetchFailureClassification,
  type GatewayFailureClassification,
  type GatewayReachabilityOutcome,
} from "./gateway-reachability-contracts.ts";

function causeChainMatches(error: unknown, matches: (value: object) => boolean): boolean {
  const seen = new Set<object>();
  let current = error;
  while (current != null && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if (matches(current)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function messageIncludes(marker: string): (value: object) => boolean {
  return (value) => {
    const message = (value as { message?: unknown }).message;
    return typeof message === "string" && message.includes(marker);
  };
}

function fetchTimedOut(error: unknown): boolean {
  return causeChainMatches(error, (value) => {
    if (value instanceof DeadlineExceededError) return true;
    const signal = value as { name?: unknown; code?: unknown };
    const timeoutName = typeof signal.name === "string"
      && (signal.name === "AbortError" || signal.name === "TimeoutError" || /TimeoutError$/.test(signal.name));
    return timeoutName || (typeof signal.code === "string" && /TIMEOUT/.test(signal.code));
  });
}

const markerOutcomes: ReadonlyArray<{
  outcome: GatewayReachabilityOutcome;
  matches: (value: object) => boolean;
}> = [
  { outcome: "no_storage", matches: messageIncludes(GATEWAY_NO_STORAGE_MESSAGE_MARKER) },
  {
    outcome: "box_blocked",
    matches: (value) => {
      const message = (value as { message?: unknown }).message;
      return typeof message === "string" && hasBoxBlockedMarker(message);
    },
  },
  { outcome: "access_denied", matches: messageIncludes(GATEWAY_ACCESS_DENIED_MESSAGE_MARKER) },
];

function outcomeFromCauseMarkers(error: unknown): GatewayReachabilityOutcome | undefined {
  for (const rule of markerOutcomes) {
    if (causeChainMatches(error, rule.matches)) return rule.outcome;
  }
  return undefined;
}

function outcomeFromNetworkSignals(errno: string | undefined, error: unknown): GatewayReachabilityOutcome {
  if (errno === "ECONNREFUSED") return "refused";
  if (errno === "ENOTFOUND" || errno === "EAI_AGAIN") return "dns";
  if (errno === "ETIMEDOUT" || fetchTimedOut(error)) return "timeout";
  return "network";
}

export function classifyGatewayFetchFailure(error: unknown): GatewayFetchFailureClassification {
  const errno = findSystemErrno(error);
  const name = error instanceof Error ? error.name : "";
  const causeSummary = [name, errno].filter((part) => part != null && part.length > 0).join("/") || "unknown";
  const outcome = outcomeFromCauseMarkers(error) ?? outcomeFromNetworkSignals(errno, error);
  return { outcome, causeSummary };
}

export function classifyGatewayError(
  error: unknown,
): GatewayFailureClassification & { httpStatus?: number } {
  if (error instanceof SlateGatewayUnreachableError) {
    return {
      outcome: error.kind,
      ...(error.causeSummary === undefined ? {} : { causeSummary: error.causeSummary }),
      ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }),
    };
  }
  return classifyGatewayFetchFailure(error);
}
