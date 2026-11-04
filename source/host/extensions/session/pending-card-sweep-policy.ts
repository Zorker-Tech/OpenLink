import type {
  PendingCardSweepPlan,
  PendingTranscriptCard,
  SessionCardDatabase,
} from "./pending-card-sweep-contracts.ts";

export function expirePendingCards<Card extends PendingTranscriptCard>(
  database: SessionCardDatabase,
  plan: PendingCardSweepPlan<Card>,
): string[] {
  const expiredRequestIds: string[] = [];
  for (const rawEntry of database.getTranscriptEntries()) {
    const entry = rawEntry as Card;
    if (
      entry.kind !== "send-message"
      || entry.message?.type !== plan.messageType
      || plan.statusOf(entry) !== "pending"
    ) continue;

    if (
      plan.ifPendingBeforeMs != null
      && entry.timestampMs != null
      && entry.timestampMs >= plan.ifPendingBeforeMs
    ) continue;

    const requestId = plan.requestIdOf(entry);
    if (requestId === undefined) continue;
    const settled = plan.settle(entry, plan.onlyRequestId ?? requestId);
    if (settled === null) continue;

    database.updateTranscriptEntry(entry.id, () => settled as unknown as Record<string, unknown>);
    expiredRequestIds.push(requestId);
  }
  return expiredRequestIds;
}
