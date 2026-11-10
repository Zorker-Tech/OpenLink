/** The conversation blob store facade, delegating adoption and maintenance decisions to their own rules. */
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { decodeInteropAgentConversationCheckpoint } from "../../../adapters/interop/agent/agent-conversation-protobuf-adapter.ts";
import { findLatestRootBlobIdInDatabase } from "../../extensions/session/conversation-recovery.ts";
import { openConversationBlobDb } from "./conversation-blob-db.ts";
import { collectConversationBlobs } from "./conversation-blob-collector.ts";
import { conversationBlobHexId } from "./conversation-blob-identifiers.ts";
import { adoptLegacyConversationBlobs } from "./conversation-blob-legacy-adoption.ts";
import type { ConversationBlobGarbageCollectionOptions, ConversationBlobStoreOptions } from "./conversation-blob-store-contracts.ts";
import { clearStaleConversationRoots } from "./conversation-blob-stale-roots.ts";
import { MAX_TRACKED_RECENT_WRITES, recordRecentBlobWrite } from "./conversation-blob-write-history.ts";
import { verifyLegacyBlobRetirement } from "./legacy-blob-retirement.ts";

export { MAX_TRACKED_RECENT_WRITES } from "./conversation-blob-write-history.ts";
export type {
  ConversationBlobGarbageCollectionOptions,
  ConversationBlobGarbageCollectionResult,
  ConversationBlobStoreOptions,
} from "./conversation-blob-store-contracts.ts";

export class ConversationBlobStoreDb {
  readonly db: DatabaseSync;
  readonly getBlobStmt: StatementSync;
  readonly setBlobStmt: StatementSync;
  readonly clearBlobsStmt: StatementSync;
  readonly scanBlobIndexStmt: StatementSync;
  readonly recentWriteMsByHexId = new Map<string, number>();
  isClosed = false;

  constructor(readonly options: ConversationBlobStoreOptions) {
    const log = options.log ?? ((message: string) => console.error(message));
    this.db = openConversationBlobDb({
      dbPath: options.blobDbPath,
      agentId: options.agentId,
      busyTimeoutMs: options.busyTimeoutMs,
      log,
    });
    if (options.legacyBlobDbPath != null) adoptLegacyConversationBlobs(this.db, options.legacyBlobDbPath, log);
    this.getBlobStmt = this.db.prepare("SELECT data FROM blobs WHERE id = ?");
    this.setBlobStmt = this.db.prepare("INSERT INTO blobs (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data");
    this.clearBlobsStmt = this.db.prepare("DELETE FROM blobs");
    this.scanBlobIndexStmt = this.db.prepare("SELECT id, length(data) AS len FROM blobs");
  }

  getBlob(id: Uint8Array): Uint8Array | undefined {
    if (this.isClosed) return undefined;
    const row = this.getBlobStmt.get(conversationBlobHexId(id)) as { data?: unknown } | undefined;
    return row?.data instanceof Uint8Array ? row.data : undefined;
  }

  setBlob(id: Uint8Array, data: Uint8Array): void {
    if (this.isClosed) return;
    const hexId = conversationBlobHexId(id);
    this.setBlobStmt.run(hexId, data);
    recordRecentBlobWrite(this.recentWriteMsByHexId, hexId, Date.now());
  }

  clearBlobs(): void {
    if (!this.isClosed) this.clearBlobsStmt.run();
  }

  findLatestRootBlobId(): Uint8Array | undefined {
    if (this.isClosed) return undefined;
    return findLatestRootBlobIdInDatabase(this.db) ?? undefined;
  }

  clearStaleCheckpointRoots(retainedRootIdHex: string): number {
    return clearStaleConversationRoots({
      isClosed: this.isClosed,
      db: this.db,
      getBlob: this.getBlobStmt,
      scanBlobIndex: this.scanBlobIndexStmt,
      retainedRootIdHex,
      decodeState: decodeInteropAgentConversationCheckpoint,
    });
  }

  collectGarbage(options: ConversationBlobGarbageCollectionOptions) {
    return collectConversationBlobs({
      isClosed: this.isClosed,
      db: this.db,
      getBlob: this.getBlobStmt,
      scanBlobIndex: this.scanBlobIndexStmt,
      recentWriteAtMsById: this.recentWriteMsByHexId,
      ...options,
    });
  }

  verifyLegacyBlobRetirement(root: string, legacy: string) {
    return this.isClosed
      ? { isRetirable: false as const, reason: "store-closed" as const, legacyRows: 0 as const, legacyBytes: 0 as const }
      : verifyLegacyBlobRetirement({ db: this.db, legacyBlobDbPath: legacy, retainedRootIdHex: root });
  }

  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.db.close();
  }
}
