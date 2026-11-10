/**
 * Where a conversation's transcript file is, relative to the transcripts folder.
 *
 * A conversation's transcript is one file per conversation, and a subagent's is one file inside its
 * parent's directory, which is what keeps a subagent's history next to the conversation that spawned it.
 * The id is encoded on the way in, so an id that contains a slash cannot address another directory.
 */

import { getSafeConversationId, TRANSCRIPTS_SUBDIR } from "../../../packages/utils/conversation-paths.ts"

export interface TranscriptFileAddress {
  readonly conversationId: string;
  readonly kind: string;
  readonly parentConversationId?: string | undefined;
  readonly ext: string;
}

export function transcriptFilePath(address: TranscriptFileAddress): string {
  const conversationFolder = getSafeConversationId(address.conversationId);
  const fileName = `${conversationFolder}.${address.ext}`;
  const parentId = address.kind === "subagent" ? address.parentConversationId : undefined;

  return parentId
    ? [TRANSCRIPTS_SUBDIR, getSafeConversationId(parentId), "subagents", fileName].join("/")
    : [TRANSCRIPTS_SUBDIR, conversationFolder, fileName].join("/");
}
