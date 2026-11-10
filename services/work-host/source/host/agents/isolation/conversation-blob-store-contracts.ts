export interface ConversationBlobStoreOptions {
  readonly agentId: string;
  readonly blobDbPath: string;
  readonly busyTimeoutMs: number;
  readonly legacyBlobDbPath?: string;
  readonly log?: (message: string) => void;
}

export interface ConversationBlobIndexRow {
  readonly id?: unknown;
  readonly len?: unknown;
}

export interface ConversationBlobGarbageCollectionOptions {
  readonly retainedRootIdHex: string;
  readonly pendingWriteRetentionMs: number;
}

export interface ConversationBlobGarbageCollectionResult {
  readonly outcome: "skipped" | "collected";
  readonly reason?: "no-root" | "root-undecodable" | "unresolved-refs";
  readonly unresolvedProtoRefs?: number;
  readonly deletedRows?: number;
  readonly deletedBytes?: number;
  readonly liveRows?: number;
  readonly liveBytes?: number;
  readonly retainedPendingRows?: number;
  readonly vacuumed?: boolean;
}
