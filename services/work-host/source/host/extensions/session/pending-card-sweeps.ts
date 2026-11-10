/**
 * Settling the cards that were waiting for an answer when their session ended.
 *
 * An approval or a permission card that is still pending is expired — all of them, or just the one a caller names —
 * so an agent is not left waiting on a question nobody can answer any more.
 */
import { settledAutoReviewEntry, settledToolPermissionEntry } from "../../../shared/transcript.ts";
import type { PendingTranscriptCard, SessionCardDatabase } from "./pending-card-sweep-contracts.ts";
import { expirePendingCards } from "./pending-card-sweep-policy.ts";

export function expirePendingAutoReviewApprovalEntries(database: SessionCardDatabase, onlyRequestId?: string): string[] {
  return expirePendingCards(database, {
    messageType: "auto-review-approval",
    ...(onlyRequestId === undefined ? {} : { onlyRequestId }),
    statusOf: (entry) => entry.message?.approval?.status,
    requestIdOf: (entry) => entry.message?.approval?.requestId,
    settle: (entry, requestId) =>
      settledAutoReviewEntry(entry as never, "expired", requestId) as PendingTranscriptCard | null,
  });
}

export function expirePendingLocalToolPermissionAskEntries(
  database: SessionCardDatabase,
  options?: { readonly onlyRequestId?: string; readonly ifPendingBeforeMs?: number },
): string[] {
  return expirePendingCards(database, {
    messageType: "local-tool-permission",
    ...(options?.onlyRequestId === undefined ? {} : { onlyRequestId: options.onlyRequestId }),
    ...(options?.ifPendingBeforeMs === undefined ? {} : { ifPendingBeforeMs: options.ifPendingBeforeMs }),
    statusOf: (entry) => entry.message?.ask?.status,
    requestIdOf: (entry) => entry.message?.ask?.requestId,
    settle: (entry, requestId) =>
      settledToolPermissionEntry(entry as never, "expired", requestId) as PendingTranscriptCard | null,
  });
}
