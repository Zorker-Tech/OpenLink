/**
 * Where a conversation's blobs live.
 *
 * One file beside the session's store holds them, and the path is built here so that every reader and writer agrees on
 * where it is.
 */
import { dirname, join } from "node:path";

import { CONVERSATION_BLOBS_FILENAME } from "./session-paths.ts";

/**
 */
export function conversationBlobsPath(dbPath: string): string {
  return join(dirname(dbPath), CONVERSATION_BLOBS_FILENAME);
}
