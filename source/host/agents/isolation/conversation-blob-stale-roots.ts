import { createHash } from "node:crypto";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { conversationBlobHexId } from "./conversation-blob-identifiers.ts";
import type { ConversationBlobIndexRow } from "./conversation-blob-store-contracts.ts";

const MAX_STALE_ROOT_SCAN_BYTES = 64 * 1024 * 1024;

export function clearStaleConversationRoots(args: {
  readonly isClosed: boolean;
  readonly db: DatabaseSync;
  readonly getBlob: StatementSync;
  readonly scanBlobIndex: StatementSync;
  readonly retainedRootIdHex: string;
  readonly decodeState: (bytes: Uint8Array) => { readonly turns: readonly Uint8Array[] };
}): number {
  if (args.isClosed) return 0;
  const presentIds = new Set<string>();
  const candidateIds: string[] = [];
  for (const row of args.scanBlobIndex.iterate()) {
    const entry = row as ConversationBlobIndexRow;
    if (typeof entry.id !== "string") continue;
    presentIds.add(entry.id);
    if (entry.id !== args.retainedRootIdHex
      && typeof entry.len === "number"
      && entry.len > 0
      && entry.len <= MAX_STALE_ROOT_SCAN_BYTES) candidateIds.push(entry.id);
  }

  const staleIds: string[] = [];
  for (const id of candidateIds) {
    const bytes = (args.getBlob.get(id) as { data?: unknown } | undefined)?.data;
    if (!(bytes instanceof Uint8Array) || createHash("sha256").update(bytes).digest("hex") !== id) continue;
    let conversationState: { readonly turns: readonly Uint8Array[] };
    try {
      conversationState = args.decodeState(bytes);
    } catch {
      continue;
    }
    const everyTurnExists = conversationState.turns.length > 0
      && conversationState.turns.every((turn) => turn.length === 32 && presentIds.has(conversationBlobHexId(turn)));
    if (everyTurnExists) staleIds.push(id);
  }
  if (staleIds.length === 0) return 0;

  const removeBlob = args.db.prepare("DELETE FROM blobs WHERE id = ?");
  let deletedRows = 0;
  let transactionOpen = false;
  try {
    args.db.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    for (const id of staleIds) deletedRows += Number(removeBlob.run(id).changes);
    args.db.exec("COMMIT");
  } catch (error) {
    if (transactionOpen) args.db.exec("ROLLBACK");
    throw error;
  }
  return deletedRows;
}
