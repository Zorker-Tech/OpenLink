import type { SlateAgentProfile } from "../../agents/agent-profile.ts";
import type { DbExtras } from "./session-summaries.ts";

export interface SessionProfileDatabase {
  get(key: string): unknown;
  getTranscriptEntries(): Record<string, unknown>[];
  getUnreadState(): DbExtras["unreadState"];
  getAwaitingUserResponse?(): unknown;
  getAgentOrigin?(): unknown;
  getAgentPurpose?(): unknown;
  getConversationPartnerIds?(): string[];
  getSlateProfile?(): { description: string; avatarPath: string | null };
}

export interface SessionProfileUpdateHost {
  readonly memory: { agentHasContent(directory: string): boolean };
  withAgentDb<T>(id: string, action: (db: SessionProfileDatabase, dbPath: string) => Promise<T>): Promise<T>;
  statOpenDb(args: { readonly dbPath: string; readonly agentId: string }): Promise<{ readonly size: number; readonly mtimeMs: number } | undefined>;
  writeAgentProfileFile(id: string, profile: Partial<SlateAgentProfile> & { readonly name: string; readonly description: string }): void;
}

export interface SessionAvatarHost {
  agentExists(id: string): boolean;
  getAgentDir(id: string): string;
  withAgentDb<T>(id: string, action: (db: { getSlateProfile(): { avatarPath: string | null } }) => Promise<T>): Promise<T>;
}

export interface SessionProfileTextHost {
  getAgentDir(id: string): string;
}
