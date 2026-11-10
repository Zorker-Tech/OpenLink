import type { BoxObjectStoreProvider } from "./box-object-store.ts";
import type { BoxStoreManifestStore } from "./box-store-manifest.ts";
import type { WorkspaceIgnore } from "./workspace-ignore.ts";

export type FileOutcome = "uploaded" | "unchanged" | "oversize" | "metadata-error" | "error";

export interface TransferSummary {
  filesUploaded: number;
  bytesUploaded: number;
  skippedUnchanged: number;
  oversize: number;
  failures: number;
  metadataFailures: number;
}

export interface CategoryTransferSummary extends TransferSummary {
  name: string;
  filesScanned: number;
  removed: number;
  excludedFiles?: number;
  excludedBytes?: number;
  prunedDirs?: number;
}

export interface BoxStoreStagedFiles {
  readonly files: readonly { readonly absPath: string; readonly relPath: string; readonly mode?: number }[];
  readonly skipped: number;
  cleanup(): Promise<void>;
}

export interface BoxStoreTransferCategory {
  readonly name: string;
  readonly absRoot: string;
  readonly relPrefix: string;
  readonly stageOnly?: boolean;
  readonly idleOnly?: boolean;
  readonly containsAgentStoreDbs?: boolean;
  readonly excludes?: readonly string[];
  ignore?(): WorkspaceIgnore;
  stage?(): Promise<BoxStoreStagedFiles>;
}

export interface BoxStoreTransferDependencies {
  readonly categories: readonly BoxStoreTransferCategory[];
  readonly objectStoreProvider: BoxObjectStoreProvider;
  resolveStoreId(): Promise<string>;
  readFreeDiskBytes?(path: string): Promise<number | undefined>;
  readonly hydrationHandoffMarkerPath?: string;
}

export interface BoxStoreTransferOptions {
  readonly deps: BoxStoreTransferDependencies;
  readonly now: () => number;
  readonly log: (message: string) => void;
  readonly manifestStore: BoxStoreManifestStore;
  readonly maxObjectBytes: number;
  readonly downloadConcurrency: number;
  readonly uploadConcurrency: number;
  readonly largeObjectThreshold: number;
  readonly downloadByteBudget: number;
  readonly getFlushWaiters: () => number;
}
