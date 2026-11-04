import type { SlateMcpAccountDisplay, SlateMcpDisplayRow } from "./mcp-display-runtime.ts";

export interface McpAccountSlotLifecycleDependencies {
  readonly backendMcpExec: {
    logoutAccount(args: unknown): Promise<void>;
    renameAccount(args: unknown): Promise<void>;
    deleteAccount(args: unknown): Promise<void>;
  };
  resolveDisplayServer(id: string): Promise<SlateMcpDisplayRow | undefined>;
  reloadServers(): Promise<any>;
  clearPendingAuthWatch(id: string, key: string): any;
  notifyWatchCancelled(watch: any): void;
  lastAccountDisplayConfig(): SlateMcpAccountDisplay | null;
  setLastAccountDisplayConfig(display: SlateMcpAccountDisplay): void;
  lastListedState(): any;
  setLastListedState(state: any): void;
  readonly definitionSource: { adoptAccountConfig(config: any): void };
  invalidateToolsCache(): void;
  resetPushState(): void;
}

export type AccountSlotAccounts = NonNullable<SlateMcpDisplayRow["accounts"]>;
