import type { DebouncePolicy } from "../../extensions/scheduling.ts";
import type { ManifestStoreDependencies } from "./box-store-manifest.ts";
import type { BoxStoreTransferCategory, CategoryTransferSummary } from "./box-store-transfer.ts";
import type { StoreDbCaptureOutcome } from "./store-db-capture.ts";

export type BoxStoreCategory = BoxStoreTransferCategory;
export type CategorySummary = CategoryTransferSummary;

export interface BoxStoreCycleSummary {
  ok: boolean;
  reason?: string;
  storeId: string | null;
  durationMs: number;
  categories: CategorySummary[];
  manifestEntries: number;
  storeDbEntries: number;
  storeDbComplete: boolean;
  agentDirEntries: number;
  totalFilesUploaded: number;
  totalBytesUploaded: number;
  totalFailures: number;
  metadataFailures: number;
}

export interface BoxStoreCaptureSummary extends Record<string, unknown> {
  trigger: "flush" | "turn_end";
  outcome: StoreDbCaptureOutcome;
  agentCount: number;
  filesScanned: number;
  filesUploaded: number;
  bytes: number;
  durationMs: number;
  queueDurationMs: number;
  captureDurationMs: number;
  blobUploadDurationMs: number;
  manifestCommitDurationMs: number;
  isCommitted: boolean;
  failurePhase?: string | undefined;
  storeId?: string | null;
}

export interface BoxStoreSyncDependencies extends ManifestStoreDependencies {
  categories: readonly BoxStoreCategory[];
  maxObjectBytes?: number;
  downloadConcurrency?: number;
  uploadConcurrency?: number;
  largeObjectThresholdBytes?: number;
  downloadInFlightByteBudgetBytes?: number;
  now?: () => number;
  log?: (message: string) => void;
  readFreeDiskBytes?(path: string): Promise<number | undefined>;
  hasLiveHandle?(dbPath: string): boolean;
  vacuumInto?(args: { srcPath: string; destPath: string }): Promise<void>;
  getWriteGeneration?(dbPath: string): number;
  lockPath?: string;
  acquireWriterLock?(args: { lockPath: string; windowId: string }): Promise<{ release(): Promise<void> } | null>;
  storeDbDebounce: DebouncePolicy;
  onCycle?(summary: BoxStoreCycleSummary): void;
  onStoreDbCapture?(summary: BoxStoreCaptureSummary): void;
}

export interface SnapshotOptions {
  includeIdleOnly?: boolean;
  includeStoreDbs?: boolean;
  skipLiveHandleStoreDbs?: boolean;
  chromeSessionOnly?: boolean;
  waitForInFlight?: boolean;
  acceptMatchingCanonicalOnConflict?: boolean;
  includePacks?: boolean;
}
