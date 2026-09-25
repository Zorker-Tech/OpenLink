/**
 * Where a conversation's transcript file is, relative to the transcripts folder.
 *
 * A conversation's transcript is one file per conversation, and a subagent's is one file inside its
 * parent's directory, which is what keeps a subagent's history next to the conversation that spawned it.
 * The id is encoded on the way in, so an id that contains a slash cannot address another directory.
 */

import { getSafeConversationId, TRANSCRIPTS_SUBDIR } from "../../../packages/utils/conversation-paths.ts"

export function getTranscriptRelativePath(args: { conversationId: string; kind: string; parentConversationId?: string; ext: string }): string {
  const safeId = getSafeConversationId(args.conversationId)
  if (args.kind === "subagent" && args.parentConversationId) {
    const safeParentId = getSafeConversationId(args.parentConversationId)
    return `${TRANSCRIPTS_SUBDIR}/${safeParentId}/subagents/${safeId}.${args.ext}`
  }
  return `${TRANSCRIPTS_SUBDIR}/${safeId}/${safeId}.${args.ext}`
}
