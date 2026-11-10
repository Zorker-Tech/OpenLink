import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  MAX_FAILED_SWAP_RESTAGE_RETRIES,
  POST_SWAP_CRASH_LOOP_ERROR_CLASS,
  SLATE_BOX_HOST_VERSION_PATH,
  SLATE_SUPERVISOR_ACKS_DIR,
  type HostBundleUpdateState,
} from "./host-bundle-upgrade-contracts.ts";
import type { HostUpgradeMarker } from "./host-upgrade-marker.ts";

export function isSlateHostUpgradeAvailable(current: string | null, target: string | null | undefined): boolean {
  return target != null && target.length > 0 && current !== target;
}

export async function readLocalHostVersion(versionPath = SLATE_BOX_HOST_VERSION_PATH): Promise<string | null> {
  try {
    const contents = (await readFile(versionPath, "utf8")).trim();
    return contents.length > 0 ? contents : null;
  } catch {
    return null;
  }
}

function acknowledgementName(version: string): string {
  return `upgrade-${version}`.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

export async function isHostVersionSwapVetoed(args: {
  version: string;
  localVersion: string | null;
  acksDir?: string;
}): Promise<boolean> {
  if (!args.version || args.localVersion === args.version) return false;
  try {
    await access(join(args.acksDir ?? SLATE_SUPERVISOR_ACKS_DIR, acknowledgementName(args.version)));
    return true;
  } catch {
    return false;
  }
}

function canRestageFailedBundle(state: HostBundleUpdateState, marker: HostUpgradeMarker): boolean {
  return marker.outcome === "failed"
    && marker.mode === "bundle"
    && Boolean(marker.toVersion)
    && marker.swapError !== POST_SWAP_CRASH_LOOP_ERROR_CLASS
    && state.stagedVersion === marker.toVersion;
}

export function noteFailedSwapMarkerForRetry(
  state: HostBundleUpdateState,
  marker: HostUpgradeMarker,
  maxRetries = MAX_FAILED_SWAP_RESTAGE_RETRIES,
): boolean {
  if (!canRestageFailedBundle(state, marker)) return false;
  const version = marker.toVersion!;
  const previousAttempts = state.swapRetryAttempts.get(version) ?? 0;
  if (previousAttempts >= maxRetries) return false;

  state.swapRetryAttempts.set(version, previousAttempts + 1);
  state.stagedVersion = null;
  return true;
}
