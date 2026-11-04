import type { RetryPolicy } from "../../extensions/scheduling.ts";
import type { SqliteSnapshotFailure } from "./sqlite-snapshot.ts";

export const CHROME_SESSION_CATEGORY_NAME = "chrome-session";
export const CHROME_SESSION_DB_DIR = "/home/box/chrome-profile/Default";
export const CHROME_SESSION_DB_REL_DIR = "home/box/chrome-profile/Default";
export const CHROME_SESSION_DB_NAMES = ["Cookies", "Login Data", "Login Data For Account", "Web Data"] as const;
export const CHROME_AUTH_STATE_REL_DIRS = ["Local Storage", "Session Storage", "IndexedDB", "Service Worker"] as const;
export const CHROME_AUTH_STATE_CACHE_EXCLUDE_NAMES = ["CacheStorage", "ScriptCache"] as const;
export const CHROME_SESSION_STAGE_MAX_ATTEMPTS = 1;
export const CHROME_SESSION_STAGE_RETRY_DELAY_MS = 150;
export const CHROME_SESSION_STAGE_VACUUM_BUSY_TIMEOUT_MS = 100;

export interface StagedChromeFile {
  relPath: string;
  absPath: string;
  mode: number;
}

export interface ChromeStageReport {
  staged: number;
  skipped: number;
  skippedDbNames: string[];
  errorClass: string | null;
  failure?: { db: string; phase: string } & SqliteSnapshotFailure;
}

export interface ChromeSessionStageDependencies {
  retry: RetryPolicy;
  sessionDbDir?: string;
  sessionDbRelDir?: string;
  sessionDbNames?: readonly string[];
  fileExists?: (path: string) => boolean;
  vacuum?: (src: string, dest: string) => void;
  copyLockedDb?: (request: {
    srcPath: string;
    destPath: string;
    onFailure?(failure: SqliteSnapshotFailure): void;
  }) => boolean;
  log?: (message: string) => void;
  report?(report: ChromeStageReport): void;
}

export interface ChromeSessionStageResult {
  files: StagedChromeFile[];
  skipped: number;
  cleanup(): Promise<void>;
}
