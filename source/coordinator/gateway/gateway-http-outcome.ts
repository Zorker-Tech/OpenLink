import type { GatewayReachabilityOutcome } from "./gateway-reachability-contracts.ts";

export function outcomeForHttpStatus(status: number): GatewayReachabilityOutcome | undefined {
  if (status >= 500) return "http_5xx";
  if (status === 401 || status === 403) return "access_denied";
  return undefined;
}
