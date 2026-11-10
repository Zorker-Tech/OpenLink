import { getLastEntryFromTranscript, getLastMessageFromTranscript, getSummaryUpdatedAt, seedActivityFromMtime } from "./session-projection.ts";
import { ensureAgentProfileDocument } from "./session-recovery.ts";
import type { DbExtras, SummaryDb, SummaryStats } from "./session-summary-contracts.ts";

/** Load the durable profile first, then read one consistent set of summary fields from the database. */
export function loadAgentDbExtras(db: SummaryDb, dbPath: string, directoryLabel: string, fileTime?: SummaryStats): DbExtras | null {
  ensureAgentProfileDocument(dbPath, db);
  return readDbExtras(db, directoryLabel, fileTime);
}

/** Read the transcript and database fields needed by the session-list projection. */
export function readDbExtras(db: SummaryDb, directoryLabel: string, fileTime?: SummaryStats): DbExtras | null {
  try {
    const storedAgentId = db.get("agentId");
    const resolvedAgentId = String(storedAgentId || directoryLabel);
    seedActivityFromMtime(db as never, resolvedAgentId, fileTime);

    const creationTime = Number(db.get("createdAt") || 0);
    const transcriptRows = db.getTranscriptEntries();
    const activityState = db.getUnreadState();
    const profileRecord = db.getSlateProfile?.();

    return {
      agentId: resolvedAgentId,
      createdAt: creationTime,
      updatedAt: getSummaryUpdatedAt({ createdAt: creationTime }, activityState),
      hasTranscript: transcriptRows.length > 0,
      lastEntry: getLastEntryFromTranscript(transcriptRows),
      lastMessage: getLastMessageFromTranscript(transcriptRows),
      newestEntryId: transcriptRows.at(-1)?.id ?? null,
      unreadState: activityState,
      awaitingUserResponse: db.getAwaitingUserResponse?.() ?? null,
      origin: db.getAgentOrigin?.() ?? "user",
      purpose: db.getAgentPurpose?.() ?? null,
      conversationPartnerIds: db.getConversationPartnerIds?.() ?? [],
      legacyAvatarPath: profileRecord?.avatarPath ?? null,
    };
  } catch {
    return null;
  }
}
