export interface ConversationSizeLimits {
  soft_limit_mb?: number;
  hard_limit_mb?: number;
}

export type ConversationGcVerdict =
  | null
  | { outcome: "failed" }
  | { outcome: "skipped"; reason: string; unresolvedProtoRefs?: number }
  | { outcome: "collected"; deletedRows: number; deletedBytes: number; liveRows: number; liveBytes: number; vacuumed: boolean };

export type ConversationGcReport = Record<string, unknown> & {
  trigger: string;
  agentId: string;
  outcome: string;
};

export interface ConversationGcDatabase {
  get(key: "latestRootBlobId"): Uint8Array;
}

export interface ConversationGcHost {
  requireWorkerPool(): {
    collectConversationGarbage(args: {
      agentId: string;
      blobDbPath: string;
      retainedRootIdHex: string;
      pendingWriteRetentionMs: number;
      legacyBlobDbPath: string;
    }): Promise<ConversationGcVerdict>;
  };
}
