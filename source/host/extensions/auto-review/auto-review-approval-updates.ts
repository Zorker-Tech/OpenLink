import type { SlateAutoReviewEvent } from "../../runner/slate-auto-review.ts";
import type { AutoReviewServiceDeps, AutoReviewUpdateSink } from "./auto-review-service-contracts.ts";

/** Translate one controller event into the telemetry record and runner update the host surfaces consume. */
export function publishAutoReviewApprovalEvent(args: {
  readonly event: SlateAutoReviewEvent;
  readonly onUpdate: AutoReviewUpdateSink;
  readonly telemetry: AutoReviewServiceDeps["telemetry"];
  readonly now: () => number;
}): void {
  const { event } = args;
  const approval = event.approval;

  args.telemetry.reportAutoReviewApproval({
    eventType: event.type,
    conversationId: approval.agentId,
    approvalId: approval.id,
    surface: approval.surface,
    status: approval.status,
    ageMs: args.now() - approval.createdAtMs,
    ...(approval.expiresAtMs === undefined ? {} : { ttlMs: approval.expiresAtMs - approval.createdAtMs }),
    ...(event.type === "expired" ? { cause: event.cause } : {}),
  });

  if (event.type === "created") {
    args.onUpdate({
      type: "send-message",
      message: {
        type: "auto-review-approval",
        approval: {
          requestId: approval.id,
          surface: approval.surface,
          summary: approval.summary,
          reason: approval.reason,
          status: "pending",
          ...(approval.command === undefined ? {} : { command: approval.command }),
          ...(approval.proposedRule === undefined ? {} : { proposedRule: approval.proposedRule }),
        },
      },
      timestampMs: args.now(),
    });
    return;
  }

  const shouldReportExpired = event.type === "expired" || approval.status === "pending";
  args.onUpdate({
    type: "auto-review-status",
    requestId: approval.id,
    status: shouldReportExpired ? "expired" : approval.status,
  });
}
