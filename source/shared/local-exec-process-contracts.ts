export const LOCAL_EXEC_IDENTITY_ENV_KEY = "SLATE_LOCAL_EXEC_GENERATION_TOKEN";
export const LOCAL_EXEC_IDENTITY_ARGUMENT_PREFIX = "--slate-local-exec-generation=";
export const DAEMON_DISCOVERY_PUBLICATION_WINDOW_MS = 60_000;

export interface LocalExecProcessIdentity {
  readonly pid: number;
  readonly startEpochMs: number;
  readonly command: string;
  readonly entryRealpath: string;
  readonly generationToken: string;
}

export interface ExpectedLocalExecProcessIdentity {
  readonly pid: number;
  readonly entryRealpath: string;
  readonly generationToken: string;
  readonly startEpochMs?: number;
  readonly command?: string;
  readonly discoveryStartedAt?: number;
}
