interface ApprovalIdentity {
  eventType: string;
  conversationId: string;
  approvalId: string;
}

interface ApprovalDecision {
  surface: string;
  status: string;
}

interface ApprovalTiming {
  ageMs: number;
  ttlMs?: number;
  cause?: string;
}

export interface AutoReviewApprovalReport extends ApprovalIdentity, ApprovalDecision, ApprovalTiming {}

const AUTO_REVIEW_APPROVAL_EVENT = "slate.auto_review.approval";

function durationMetadata(milliseconds: number): string {
  return String(Math.max(0, Math.round(milliseconds)));
}

function lifecycleMetadata(report: AutoReviewApprovalReport): Record<string, string> {
  const metadata: Record<string, string> = {
    event_type: report.eventType,
    conversation_id: report.conversationId,
    approval_id: report.approvalId,
    surface: report.surface,
    status: report.status,
    age_ms: durationMetadata(report.ageMs),
  };

  if (report.ttlMs !== undefined) metadata.ttl_ms = durationMetadata(report.ttlMs);
  if (report.cause !== undefined) metadata.cause = report.cause;
  return metadata;
}

export function autoReviewApprovalTelemetry(report: AutoReviewApprovalReport) {
  return {
    event: AUTO_REVIEW_APPROVAL_EVENT,
    metadata: lifecycleMetadata(report),
  };
}
