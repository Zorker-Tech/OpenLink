import type { SlateAutoReviewController } from "../../runner/slate-auto-review.ts";
import { SETTLED_APPROVAL_MEMORY } from "./auto-review-service-contracts.ts";

/** Owns runner subscriptions and the bounded memory used to recognize recently answered cards. */
export class AutoReviewApprovalRegistry {
  readonly #controllers = new Map<SlateAutoReviewController, () => void>();
  readonly #settledIds = new Set<string>();

  track(controller: SlateAutoReviewController, unsubscribe: () => void): void {
    this.#controllers.set(controller, unsubscribe);
  }

  ownerOf(requestId: string): SlateAutoReviewController | undefined {
    for (const controller of this.#controllers.keys()) {
      if (controller.getPendingApprovals().some((approval) => approval.id === requestId)) return controller;
    }
    return undefined;
  }

  wasRecentlySettled(requestId: string): boolean {
    return this.#settledIds.has(requestId);
  }

  rememberSettled(requestId: string): void {
    this.#settledIds.add(requestId);
    if (this.#settledIds.size <= SETTLED_APPROVAL_MEMORY) return;
    const oldest = this.#settledIds.values().next();
    if (!oldest.done) this.#settledIds.delete(oldest.value);
  }

  releaseIfIdle(controller: SlateAutoReviewController): void {
    if (controller.getPendingApprovals().length === 0) this.#controllers.delete(controller);
  }

  pendingAgentIds(): string[] {
    const ids = new Set<string>();
    for (const controller of this.#controllers.keys()) {
      const approvals = controller.getPendingApprovals();
      if (approvals.length === 0) continue;
      ids.add(controller.agentId);
      for (const approval of approvals) ids.add(approval.agentId);
    }
    return [...ids];
  }

  expirePending(): void {
    for (const controller of [...this.#controllers.keys()]) controller.expire("session_end");
  }

  stop(): void {
    const subscriptions = [...this.#controllers.values()];
    this.expirePending();
    for (const unsubscribe of subscriptions) unsubscribe();
    this.#controllers.clear();
  }
}
