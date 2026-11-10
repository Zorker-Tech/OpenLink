import type { HostBundleSource } from "./host-bundle-source.ts";

export const SLATE_SUPERVISOR_DIR = "/tmp/slate-supervisor";
export const SLATE_SUPERVISOR_COMMAND_PATH = `${SLATE_SUPERVISOR_DIR}/command.json`;
export const SLATE_SUPERVISOR_COMMAND_PART_PATH = `${SLATE_SUPERVISOR_COMMAND_PATH}.part`;
export const SLATE_SUPERVISOR_ACKS_DIR = `${SLATE_SUPERVISOR_DIR}/acks`;
export const SLATE_SUPERVISOR_STAGED_BUNDLE_PATH = `${SLATE_SUPERVISOR_DIR}/incoming-host-bundle.tgz`;
export const SLATE_SUPERVISOR_STAGED_BUNDLE_PART_PATH = `${SLATE_SUPERVISOR_STAGED_BUNDLE_PATH}.part`;
export const SLATE_BOX_HOST_VERSION_PATH = "/home/box/slate-host/version";
export const MAX_FAILED_SWAP_RESTAGE_RETRIES = 2;
export const POST_SWAP_CRASH_LOOP_ERROR_CLASS = "post-swap-crash-loop";
export const HOST_BUNDLE_WATCH_INTERVAL_MS = 24 * 60 * 60_000;
export const HOST_BUNDLE_WATCH_JITTER_RATIO = 0.5;

export interface SlateSupervisorUpgradeCommand {
  id: string;
  kind: "upgrade";
  issuedAtMs: number;
  mode?: string;
  version?: string;
  bundlePath?: string;
  reason?: string;
  forceNow?: true;
}

export interface HostBundleUpdateState {
  stagedVersion: string | null;
  lastFailedVersion: string | undefined;
  swapRetryAttempts: Map<string, number>;
}

export interface SupervisorUpgradeInput {
  readonly id: string;
  readonly kind: "upgrade";
  readonly nowMs: number;
  readonly mode?: string;
  readonly version?: string;
  readonly bundlePath?: string;
  readonly reason?: string;
  readonly forceNow?: boolean;
}

export interface StageHostBundleInput {
  readonly version: string;
  readonly bytes: Uint8Array;
  readonly reason?: string;
  readonly forceNow?: boolean;
  readonly nowMs?: number;
  readonly dir?: string;
  readonly stagedBundlePath?: string;
  readonly stagedBundlePartPath?: string;
  readonly commandPath?: string;
  readonly commandPartPath?: string;
}

export interface FetchStageHostBundleDependencies {
  readonly source: HostBundleSource;
  readonly fromVersion: string | null;
  readonly trigger: string;
  readonly state: HostBundleUpdateState;
  stage(bytes: Uint8Array): Promise<void>;
  reportUpgrade(metadata: Record<string, string | undefined>): void;
  log?(level: "info" | "warn", message: string): void;
}
