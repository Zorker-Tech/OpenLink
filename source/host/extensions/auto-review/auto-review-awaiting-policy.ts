export const AUTO_REVIEW_AWAITING_TAB_ID = "auto-review";

export function awaitingReasonFor(summary: string): string {
  return `Approval needed: ${summary}`;
}

export function mostRecentAwaitingReason(pending: ReadonlyMap<string, string>): string | undefined {
  return [...pending.values()].at(-1);
}
