import type { DbExtras } from "./session-summaries.ts";

export interface SessionRosterHost {
  readonly rootDir: string;
  isAgentBeingDeleted(id: string): boolean;
  readonly memory: { agentHasContent(directory: string): boolean };
  loadCachedExtras(args: { readonly dirName: string; readonly dbPath: string; readonly dbStats: { readonly size: number; readonly mtimeMs: number } }): Promise<DbExtras | null>;
  recoverAgentWithMissingDb(args: { readonly dbPath: string; readonly dirName: string; readonly activeAgentId?: string }): Promise<Record<string, unknown> | null>;
  pruneExtrasCache(ids: Set<string>): void;
}
