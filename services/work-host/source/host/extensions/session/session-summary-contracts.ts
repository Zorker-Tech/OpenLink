export interface DbExtras {
  agentId: string;
  createdAt: number;
  updatedAt: number;
  hasTranscript: boolean;
  lastEntry: Record<string, unknown> | null;
  lastMessage: { id: string; preview: string } | null;
  newestEntryId: unknown;
  unreadState: {
    lastActivityAt: number;
    lastViewedAt: number;
    isManuallyUnread: boolean;
    unreadCount: number;
  };
  awaitingUserResponse: unknown;
  origin: unknown;
  purpose: unknown;
  conversationPartnerIds: string[];
  legacyAvatarPath: string | null;
}

export interface SummaryDb {
  get(key: string): unknown;
  getTranscriptEntries(): Record<string, unknown>[];
  getUnreadState(): DbExtras["unreadState"];
  getAwaitingUserResponse?(): unknown;
  getAgentOrigin?(): unknown;
  getAgentPurpose?(): unknown;
  getConversationPartnerIds?(): string[];
  getSlateProfile?(): { description: string; avatarPath: string | null };
}

export interface SummaryStats {
  readonly mtimeMs: number;
}

export interface BuildSummaryArgs {
  readonly extras?: DbExtras | null;
  readonly dbPath: string;
  readonly dirName: string;
  readonly dbStats?: SummaryStats;
  readonly activeAgentId?: string;
  readonly includeBlank: boolean;
  readonly agentHasMemory?: (dir: string) => boolean;
  readonly readAvatar?: (dir: string, legacy: string | null) => Promise<{ dataUrl: string; version: string } | null>;
  readonly isGroup?: boolean;
  readonly memberIds?: string[];
  readonly remoteRoom?: Record<string, unknown> | null;
}
