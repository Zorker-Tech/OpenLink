import { classifyGatewayFetchFailure } from "./gateway-fetch-classifier.ts";

export function classifyStreamDown(input: {
  clientPaused: boolean;
  stalled: boolean;
  forced: boolean;
  devInducedOffline: boolean;
  error: unknown;
}): { reason: string; cause: string | null } {
  if (input.clientPaused) return { reason: "box_blocked", cause: "client-paused" };
  if (input.stalled) return { reason: "stall-timeout", cause: null };
  if (input.forced || input.devInducedOffline) {
    return { reason: "forced-reconnect", cause: input.devInducedOffline ? "dev-induced-offline" : null };
  }
  const failure = classifyGatewayFetchFailure(input.error);
  return { reason: failure.outcome, cause: failure.causeSummary };
}
