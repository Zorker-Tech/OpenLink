import { dirname } from "node:path"
import { getSlateProfilePath, readSlateProfileFile, writeSlateProfileFile } from "../agents/agent-profile.ts"
import { SLATE_DEFAULT_AGENT_NAME, isSlateDefaultAgentName } from "../../shared/agents/agents.ts"
import type { TranscriptEntry, TranscriptManagerLike } from "./transcript-hub.ts"

function seedDefaultProfile(
  transcript: TranscriptManagerLike,
  session: any,
  prompt: string,
  readAddressedTranscript: () => readonly TranscriptEntry[],
): boolean {
  if (readAddressedTranscript().length !== 0) return false

  const profilePath = getSlateProfilePath(dirname(session.dbPath))
  const profile = readSlateProfileFile(profilePath)
  const displayedName = profile?.name.trim() || SLATE_DEFAULT_AGENT_NAME
  if (!isSlateDefaultAgentName(displayedName)) return false

  const seed = prompt.length === 0 ? "New conversation" : prompt
  const name = seed.replace(/\s+/g, " ").slice(0, 72)
  writeSlateProfileFile(profilePath, {
    name,
    description: profile?.description ?? "",
    title: profile?.title ?? "",
    avatarShape: profile?.avatarShape ?? "",
    avatarColor: profile?.avatarColor ?? "",
  })
  transcript.roster.lastKnownAgentNames.set(session.id, name)
  return true
}

/** Update the addressed row after a send; return whether the roster needs a fresh snapshot. */
export function applySendRosterSideEffects(
  transcript: TranscriptManagerLike,
  session: any,
  trimmedPrompt: string,
  readAddressedTranscript: () => readonly TranscriptEntry[],
): boolean {
  let refreshRoster = seedDefaultProfile(transcript, session, trimmedPrompt, readAddressedTranscript)
  transcript.trayErrors.clearForAgent(session.id)

  if (session.db.getAwaitingUserResponse() != null) {
    session.db.setAwaitingUserResponse(null)
    refreshRoster = true
  }
  return refreshRoster
}
