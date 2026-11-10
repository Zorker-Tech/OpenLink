/**
 * What the platform may say about a codebase, as the account's privacy mode decides it.
 *
 * A privacy mode is read from the backend and cached, and it is what tells the host whether anything at all about a
 * codebase may leave the machine.
 */

import { createSlatePrivacyModeDashboardReader } from "../../../adapters/interop/telemetry/privacy-mode-dashboard-adapter.ts";
import { PrivacyMode as SlatePrivacyMode, type PrivacyMode as SlatePrivacyModeValue } from "../../../packages/redaction/privacy-mode.ts";
import type { DeadlinePolicy, PollingPolicy, RetryPolicy } from "../scheduling.ts";
import { createWatchChannel, type WatchReceiver } from "./watch-channel.ts";

export type { WatchReceiver };

/** The modes the platform knows. Anything else it is told is read as unspecified. */
export const PrivacyModes = {
  Unspecified: SlatePrivacyMode.UNSPECIFIED,
  NoStorage: SlatePrivacyMode.NO_STORAGE,
  NoTraining: SlatePrivacyMode.NO_TRAINING,
  UsageDataTrainingAllowed: SlatePrivacyMode.USAGE_DATA_TRAINING_ALLOWED,
  UsageCodebaseTrainingAllowed: SlatePrivacyMode.USAGE_CODEBASE_TRAINING_ALLOWED,
} as const;
export type PrivacyMode = SlatePrivacyModeValue;

/** The account a telemetry lookup is made for. */
export interface TelemetryAuth {
  readonly authId: string;
  readonly authToken: string;
}

/** Reads the account's privacy mode from the backend. */
export function createSlatePrivacyModeLoader(authApi: { getMachineId(): Promise<string> }) {
  return createSlatePrivacyModeDashboardReader(authApi) as (args: { auth: TelemetryAuth; signal: AbortSignal }) => Promise<PrivacyMode>;
}

/** The mode the platform understands; everything else is unspecified. */
export function toPrivacyMode(value: unknown): PrivacyMode {
  switch (value) {
    case PrivacyModes.NoStorage:
    case PrivacyModes.NoTraining:
    case PrivacyModes.UsageDataTrainingAllowed:
    case PrivacyModes.UsageCodebaseTrainingAllowed:
      return value;
    default:
      return PrivacyModes.Unspecified;
  }
}

/** Whether a lookup is worth trying again: a timeout always, a refusal only when the backend said it would pass. */
export function isRetryablePrivacyModeLookupError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "DeadlineExceededError") return true;
  if (error.name !== "ConnectError") return false;
  const refusal = error as Error & { code?: unknown; metadata?: { has(name: string): boolean } };
  return refusal.code === 4 || (refusal.code === 14 && refusal.metadata?.has("retry-after") !== true);
}

export interface CodebaseTelemetryPrivacyMode {
  readonly receiver: WatchReceiver<PrivacyMode>;
  setAuth(auth: TelemetryAuth): void;
  clearAuth(): void;
  dispose(): void;
}

export function createCodebaseTelemetryPrivacyMode(options: {
  readonly load: (args: { auth: TelemetryAuth; signal: AbortSignal }) => Promise<PrivacyMode>;
  readonly lookupDeadline: DeadlinePolicy;
  readonly lookupRetry: RetryPolicy;
  readonly refreshPolling: PollingPolicy;
  readonly logger: { error(message: string, error?: unknown): void; warn(message: string, error?: unknown): void };
}): CodebaseTelemetryPrivacyMode {
  const channel = createWatchChannel<PrivacyMode>(PrivacyModes.Unspecified, (error) => options.logger.error("Privacy mode subscriber failed", error));
  let activeAuth: TelemetryAuth | undefined;
  let activeLookup: AbortController | undefined;
  // Bumped whenever the answer in flight stops being the one that matters: only the reading it was started for is published.
  let generation = 0;
  let disposed = false;

  const refresh = async (): Promise<void> => {
    const auth = activeAuth;
    if (auth == null || disposed) return;
    const asked = ++generation;
    activeLookup?.abort();
    const lookup = new AbortController();
    activeLookup = lookup;
    try {
      const mode = await options.lookupRetry.runWithRetry((_attempt, retrySignal) => options.lookupDeadline.run((signal) => options.load({ auth, signal }), retrySignal), lookup.signal);
      if (!disposed && asked === generation) channel.publish(toPrivacyMode(mode));
    } catch (error) {
      if (!disposed && asked === generation) options.logger.warn("Privacy mode lookup failed", error);
    } finally {
      if (activeLookup === lookup) activeLookup = undefined;
    }
  };

  const refreshPolling = options.refreshPolling.start(refresh);

  return {
    receiver: channel.receiver,
    setAuth(auth) {
      const accountChanged = activeAuth?.authId !== auth.authId;
      activeAuth = auth;
      if (accountChanged) {
        generation += 1;
        channel.publish(PrivacyModes.Unspecified);
      }
      void refresh();
    },
    clearAuth() {
      activeAuth = undefined;
      generation += 1;
      activeLookup?.abort();
      activeLookup = undefined;
      channel.publish(PrivacyModes.Unspecified);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      generation += 1;
      activeLookup?.abort();
      activeLookup = undefined;
      refreshPolling.dispose();
      channel.stop();
    },
  };
}
