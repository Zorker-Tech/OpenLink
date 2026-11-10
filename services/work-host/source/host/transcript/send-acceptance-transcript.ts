import { raisesUserActivity } from "../../shared/transcript.ts"
import { SlateSendNotPersistedError } from "./send-not-persisted-error.ts"
import { getTranscript } from "./transcript-store.ts"
import type { TranscriptEntry, TranscriptManagerLike } from "./transcript-hub.ts"

/** Persist on the visible transcript path, or write directly to the addressed conversation after a switch. */
export function appendAddressedEcho(
  transcript: TranscriptManagerLike,
  session: any,
  isAddressedChatOnScreen: () => boolean,
  createEntry: (currentEntries: readonly TranscriptEntry[]) => TranscriptEntry,
  appendOptions: { onPersistOutcome(value: boolean): void },
): { entry: TranscriptEntry; isOnActiveTranscript: boolean } {
  if (!isAddressedChatOnScreen()) {
    const entry = createEntry(session.db.getTranscriptEntries())
    const persisted = session.db.appendTranscriptEntry(entry)
    appendOptions.onPersistOutcome(persisted)
    if (!persisted) throw new SlateSendNotPersistedError()
    if (raisesUserActivity(entry)) transcript.sessionStore.markSessionActivity(session)
    return { entry, isOnActiveTranscript: false }
  }

  const entry = transcript.appendEntry(createEntry(getTranscript()), {
    persistBeforeEmit: true,
    deferEmit: true,
    onPersistOutcome: appendOptions.onPersistOutcome,
  })
  return { entry, isOnActiveTranscript: true }
}
