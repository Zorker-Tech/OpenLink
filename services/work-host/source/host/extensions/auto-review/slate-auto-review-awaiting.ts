/**
 * An agent whose review is waiting for an answer.
 *
 * The waiting state is what the panel shows: which review, what it is about and how long it may still wait, kept in
 * the tab the platform uses for it.
 */
import type { SlateAutoReviewEvent } from "../../runner/slate-auto-review.ts";
import type { ReviewAwaitingSink, ReviewAwaitingState } from "./auto-review-awaiting-contracts.ts";
import {
  AUTO_REVIEW_AWAITING_TAB_ID,
  awaitingReasonFor,
  mostRecentAwaitingReason,
} from "./auto-review-awaiting-policy.ts";

export { AUTO_REVIEW_AWAITING_TAB_ID } from "./auto-review-awaiting-policy.ts";
export { awaitingReasonFor } from "./auto-review-awaiting-policy.ts";
export type { ReviewAwaitingSink, ReviewAwaitingState } from "./auto-review-awaiting-contracts.ts";

export class ReviewAwaitingBridge {
  private readonly pendingByAgent = new Map<string, Map<string, string>>();

  constructor(private readonly sink: ReviewAwaitingSink, private readonly now: () => number = Date.now) {}

  handleEvent(event: SlateAutoReviewEvent): void {
    const { agentId, id, summary } = event.approval;
    if (event.type === "created") {
      const approvals = this.pendingByAgent.get(agentId) ?? new Map<string, string>();
      this.pendingByAgent.set(agentId, approvals);
      approvals.set(id, awaitingReasonFor(summary));
      this.publishLatest(agentId, approvals);
      return;
    }

    const approvals = this.pendingByAgent.get(agentId);
    if (approvals === undefined || !approvals.delete(id)) return;
    if (approvals.size === 0) {
      this.pendingByAgent.delete(agentId);
      this.sink.clearForTab(agentId, AUTO_REVIEW_AWAITING_TAB_ID);
      return;
    }
    this.publishLatest(agentId, approvals);
  }

  pendingAwaitingState(agentId: string): ReviewAwaitingState | null {
    const approvals = this.pendingByAgent.get(agentId);
    const reason = approvals === undefined ? undefined : mostRecentAwaitingReason(approvals);
    return reason === undefined
      ? null
      : { tabId: AUTO_REVIEW_AWAITING_TAB_ID, reason, since: this.now() };
  }

  private publishLatest(agentId: string, approvals: ReadonlyMap<string, string>): void {
    const reason = mostRecentAwaitingReason(approvals);
    if (reason === undefined) return;
    this.sink.trySetForTab(agentId, {
      tabId: AUTO_REVIEW_AWAITING_TAB_ID,
      reason,
      since: this.now(),
    });
  }
}
