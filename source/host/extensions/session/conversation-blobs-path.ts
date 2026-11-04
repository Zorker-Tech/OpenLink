/** Resolve the companion blob database next to a conversation's primary store. */
import { dirname, join } from "node:path";
import { CONVERSATION_BLOBS_FILENAME } from "./session-paths.ts";

export function resolveConversationBlobStorePath(primaryStorePath: string): string {
  const containingDirectory = dirname(primaryStorePath);
  return join(containingDirectory, CONVERSATION_BLOBS_FILENAME);
}
