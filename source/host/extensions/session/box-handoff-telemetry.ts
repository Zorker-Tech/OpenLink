import { MAX_DOMAIN_LENGTH, type HandoffRequest, type BoxHandoffDeps } from "./box-handoff-contracts.ts";

const knownHelpReasons = new Set(["auth", "captcha", "payment"]);

function shortDomain(value: string | undefined): string | undefined {
  return value === undefined ? undefined : value.slice(0, MAX_DOMAIN_LENGTH);
}

export function reportHandoffCapture(
  deps: BoxHandoffDeps,
  request: HandoffRequest,
  captured: boolean,
): void {
  const reason = request.telemetry?.reason;
  const domain = shortDomain(request.telemetry?.domain);
  const idpDomain = shortDomain(request.telemetry?.idpDomain);

  deps.telemetry?.reportBoxHelp({
    conversationId: request.agentId,
    snapshotCaptured: captured,
    reason,
  });

  const properties: Record<string, unknown> = {
    agent_id: request.agentId,
    snapshot_captured: captured,
  };
  if (reason !== undefined) properties.reason = knownHelpReasons.has(reason) ? reason : "other";
  if (domain !== undefined) properties.domain = domain;
  if (idpDomain !== undefined) properties.idp_domain = idpDomain;
  deps.telemetry?.trackEvent("slate.box_help", properties);
  deps.report?.({ outcome: captured ? "ready" : "no_snapshot", agentId: request.agentId });
}
