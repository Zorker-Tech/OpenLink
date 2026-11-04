/** Configuration and public values for the host's own persistent box service. */
import type { Context } from "../../../packages/context/context.ts";
import type { DeadlinePolicy, ExpiryPolicy, PollingPolicy, RetryPolicy } from "../../extensions/scheduling.ts";
import type { BoxStatus, HostBox } from "./host-box.ts";

export const RECREATE_UNAVAILABLE_MESSAGE = "Couldn't reach the service that updates this computer. It is unchanged. Try again in a moment; if it keeps failing, the backend may need to be updated.";
export const FOREVER_BOX_MIGRATION_TTL_MS = 5 * 60_000;
export const FOREVER_BOX_SCREENSHOT_TIMEOUT_MS = 5_000;
export const FOREVER_BOX_RECREATE_FLUSH_WAIT_MS = 10_000;
export const FOREVER_BOX_IMAGE_WATCH_INTERVAL_MS = 24 * 60 * 60_000;
export const FOREVER_BOX_IMAGE_CHECK_TIMEOUT_MS = 30_000;

export interface ForeverBoxOptions {
  box: HostBox;
  lifecycleClient: {
    recreateInBox(options: { preserveData: boolean; force?: boolean }): Promise<{ started: boolean; reason?: string }>;
    fetchImageUpdateAvailable(signal: AbortSignal): Promise<boolean | undefined>;
  };
  trays: { pushError(value: { agentId: string; title: string; detail: string }): void };
  telemetry: {
    reportBoxRecreateDecided(value: Record<string, string>): void;
    reportBoxImageCheck(value: Record<string, unknown>): void;
  };
  imagePolling: PollingPolicy;
  imagePollingStartDelay: RetryPolicy;
  imageSeedRetry: RetryPolicy;
  imageCheckDeadline: DeadlinePolicy;
  migrationExpiry: ExpiryPolicy;
  screenshotDeadline: DeadlinePolicy;
  recreateFlushWaitDeadline: DeadlinePolicy;
  flushPendingUploads(): Promise<void>;
  autoUpdateEnabled: boolean;
  hostBundleAutoUpdateEnabled: boolean;
  isInBox(): boolean;
  log(message: string): void;
  captureScreenshot?(connection: Awaited<ReturnType<HostBox["ensureReady"]>>, signal: AbortSignal): Promise<Uint8Array | null>;
  ctx?: Context;
  now?: () => number;
}

export type ForeverBoxRecreateRequest = { preserveData: boolean; force?: boolean };
export type ForeverBoxRecreateResult = { started: boolean; reason?: string };
export type ForeverBoxImageCheckResult = { outcome: string; available?: boolean };
export type ForeverBoxDecoratedStatus = BoxStatus;
