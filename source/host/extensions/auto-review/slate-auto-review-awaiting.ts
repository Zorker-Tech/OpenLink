/**
 * An agent whose review is waiting for an answer.
 *
 * The waiting state is what the panel shows: which review, what it is about and how long it may still wait, kept in
 * the tab the platform uses for it.
 */
import type { SlateAutoReviewEvent } from "../../runner/slate-auto-review.ts";

export const SLATE_AUTO_REVIEW_AWAITING_TAB_ID = "auto-review";
export interface SlateAutoReviewAwaitingState { readonly tabId: string; readonly reason: string; readonly since: number }
export interface SlateAutoReviewAwaitingSink { trySetForTab(agentId: string, state: SlateAutoReviewAwaitingState): void; clearForTab(agentId: string, tabId: string, options?: { readonly ifSinceBefore?: number }): void }

export function buildSlateAutoReviewAwaitingReason(summary: string): string { return `Approval needed: ${summary}`; }

export class SlateAutoReviewAwaitingBridge {
  readonly #pendingByAgent = new Map<string, Map<string, string>>();
  constructor(private readonly sink: SlateAutoReviewAwaitingSink, private readonly now: () => number = Date.now) {}

  handleEvent(event: SlateAutoReviewEvent): void {
    const { agentId, id, summary } = event.approval;
    if (event.type === "created") { const pending = this.#pendingByAgent.get(agentId) ?? new Map<string, string>(); this.#pendingByAgent.set(agentId, pending); pending.set(id, buildSlateAutoReviewAwaitingReason(summary)); this.#assert(agentId, pending); return; }
    const pending = this.#pendingByAgent.get(agentId); if (pending == null || !pending.delete(id)) return;
    if (pending.size === 0) { this.#pendingByAgent.delete(agentId); this.sink.clearForTab(agentId, SLATE_AUTO_REVIEW_AWAITING_TAB_ID); return; }
    this.#assert(agentId, pending);
  }

  pendingAwaitingState(agentId: string): SlateAutoReviewAwaitingState | null { const reason = [...(this.#pendingByAgent.get(agentId)?.values() ?? [])].at(-1); return reason == null ? null : { tabId: SLATE_AUTO_REVIEW_AWAITING_TAB_ID, reason, since: this.now() }; }
  #assert(agentId: string, pending: ReadonlyMap<string, string>): void { const reason = [...pending.values()].at(-1); if (reason != null) this.sink.trySetForTab(agentId, { tabId: SLATE_AUTO_REVIEW_AWAITING_TAB_ID, reason, since: this.now() }); }
}
