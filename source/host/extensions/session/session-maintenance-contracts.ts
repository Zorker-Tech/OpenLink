/** Version markers and ports shared by session maintenance passes. */
import type { OutlineItem } from "./conversation-recovery.ts";
import type { SlateHydratedConversation } from "../../../packages/agent/conversation-transcript-state.ts";
import type { SlateConversationCheckpointV2 } from "../../../packages/agent/conversation-checkpoint-state.ts";

export const LEGACY_BLOB_RETIREMENT_VERSION = 1;
export const STALE_ROOT_CLEANUP_VERSION = 1;
export const HIDDEN_ENTRY_REPAIR_VERSION = 1;

let legacyBlobRetirementPinned = false;
let staleRootCleanupPinned = false;

export function pinLegacyStoreBlobRetirement(enabled: boolean): void {
  legacyBlobRetirementPinned = enabled;
}

export function isLegacyStoreBlobRetirementEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const setting = env.SLATE_RETIRE_LEGACY_STORE_BLOBS?.trim().toLowerCase();
  if (["1", "true", "on"].includes(setting ?? "")) return true;
  if (["0", "false", "off"].includes(setting ?? "")) return false;
  return legacyBlobRetirementPinned;
}

export function pinStaleRootGc(enabled: boolean): void {
  staleRootCleanupPinned = enabled;
}

export function isStaleRootGcEnabled(): boolean {
  return staleRootCleanupPinned;
}

export interface MaintenanceDb {
  get(key: string): Uint8Array | string;
  set(key: string, value: unknown): boolean;
  compareAndSetLatestRootBlobId(args: { expectedRoot: Uint8Array; nextRoot: Uint8Array }): boolean;
  getTranscriptEntries(): Array<Record<string, unknown>>;
  appendTranscriptEntries(entries: readonly (Record<string, unknown> & { id: string; kind: string })[]): boolean | number;
  deleteTranscriptEntry(id: string): boolean;
  getStaleRootCleanupVersion(): number;
  setStaleRootCleanupVersion(version: number): boolean;
  getHiddenEntryRepairVersion(): number;
  setHiddenEntryRepairVersion(version: number): boolean;
  hasLegacyConversationBlobs(): boolean;
  getLegacyBlobRetirementVersion(): number;
  retireLegacyConversationBlobs(version: number): boolean;
}

export interface MaintenanceStore {
  getConversationStateStructure(): SlateConversationCheckpointV2;
  getBlobStore(): { getBlob(ctx: unknown, id: Uint8Array): Promise<Uint8Array | null> };
  getFullConversation(ctx: unknown): Promise<SlateHydratedConversation>;
  resetFromDb(ctx: unknown): Promise<void>;
}

export interface MaintenanceWorkerPool {
  clearStaleCheckpointRoots(agentId: string, blobDbPath: string, rootHex: string, dbPath: string): Promise<number>;
  findLatestRootBlobId(args: { agentId: string; blobDbPath: string; legacyBlobDbPath: string }): Promise<Uint8Array | null>;
  verifyLegacyBlobRetirement(args: {
    agentId: string;
    blobDbPath: string;
    legacyBlobDbPath: string;
    retainedRootIdHex: string;
  }): Promise<{ isRetirable: boolean; reason?: string; legacyRows?: number; legacyBytes?: number }>;
}

export interface MaintenanceHost {
  rootDir: string;
  ctx: unknown;
  liveHandleCount?(path: string): number;
  writeGeneration?(path: string): number;
  resolveConversationState(structure: unknown, blobStore: unknown): Promise<{ turns: readonly { items: readonly OutlineItem[] }[] } | null>;
  deriveOutline?(state: SlateHydratedConversation): readonly OutlineItem[];
  report?(event: Record<string, unknown>): void;
  requireWorkerPool(): MaintenanceWorkerPool;
}
