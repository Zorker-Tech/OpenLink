/**
 * The codebase-telemetry host, wired as the extension's own host side.
 *
 * It follows the signed-in account and the codebase-telemetry gate: the account's credential is pushed into the
 * privacy mode and republished as it renews, a gate reading that changed tells subscribers the feature is on, and the
 * two codebases the platform's computer always has — the workspace root and the home directory — are what the
 * adapter is asked to track.
 */

import type { TelemetryAuth } from "./privacy-mode.ts";
import { createListenerSet, createWatchChannel, type WatchReceiver } from "./watch-channel.ts";

export const SLATE_CODEBASE_TELEMETRY_FEATURE_GATE = "slate_codebase_telemetry";
export const CodebaseTelemetryFeatureGate = { MAIN: "main", GIT_HISTORY: "git-history", AGENT_DOT_DIRS: "agent-dot-dirs" } as const;
export const CodebaseKind = { WORKSPACE_ROOT: 1, HOME_DIRECTORY: 2 } as const;
export const SLATE_BOX_WORKSPACE_ROOT = "/workspace";
export const SLATE_BOX_HOME_DIR = "/home/box";

/** The subject claim of a credential, when it carries one we can use. */
function credentialSubject(token: string): string | undefined {
  try {
    const encodedPayload = token.split(".")[1];
    if (encodedPayload == null) return undefined;
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as { sub?: unknown };
    return typeof payload.sub === "string" ? payload.sub : undefined;
  } catch {
    return undefined;
  }
}

export interface AuthSourceOptions {
  auth: { peekAccessToken(): string | null; subscribeToRenewal(listener: (event: { outcome: string }) => void): () => void };
  logger: { warn(message: string): void; error(message: string, error?: unknown): void };
  privacyMode: { setAuth(auth: TelemetryAuth): void; clearAuth(): void };
}

export interface AuthSource {
  readonly receiver: WatchReceiver<TelemetryAuth | undefined>;
  dispose(): void;
}

/** The credential of the account that is signed in, as a value the privacy mode and the adapter can follow. */
export function createAuthSource(options: AuthSourceOptions): AuthSource {
  const channel = createWatchChannel<TelemetryAuth | undefined>(undefined, (error) => options.logger.error("Authentication subscriber failed", error));
  const clear = (): void => {
    // Nothing was ever handed over, so there is nothing to take back.
    if (channel.current == null) return;
    options.privacyMode.clearAuth();
    channel.publish(undefined);
  };
  const publishCredential = (): void => {
    const token = options.auth.peekAccessToken();
    if (!token) {
      clear();
      return;
    }
    const authId = credentialSubject(token);
    if (!authId) {
      options.logger.warn("Credential has no usable subject claim");
      clear();
      return;
    }
    const current = channel.current;
    if (current?.authId === authId && current.authToken === token) return;
    const next = { authId, authToken: token };
    options.privacyMode.setAuth(next);
    channel.publish(next);
  };
  const stopListening = options.auth.subscribeToRenewal(({ outcome }) => {
    // A renewal is worth acting on, and so is any outcome that left no credential behind.
    if (outcome === "renewed" || !options.auth.peekAccessToken()) publishCredential();
  });
  publishCredential();
  return {
    receiver: channel.receiver,
    dispose() {
      stopListening();
      channel.stop();
    },
  };
}

export interface FeatureGateSourceOptions {
  experiments: { checkFeatureGate(name: string): boolean; checkGate(name: string): boolean | Promise<boolean>; subscribe(listener: () => void): () => void };
  logger: { error(message: string, error?: unknown): void };
}

export interface FeatureGateSource {
  readonly receiver: {
    changes: { subscribe(listener: (value: { kind: "some"; gates: readonly string[] }) => void): { dispose(): void } };
    check(gate: string): Promise<boolean>;
  };
  dispose(): void;
}

export function createFeatureGateSource(options: FeatureGateSourceOptions): FeatureGateSource {
  let lastReading = options.experiments.checkFeatureGate(SLATE_CODEBASE_TELEMETRY_FEATURE_GATE);
  const listeners = createListenerSet<{ kind: "some"; gates: readonly string[] }>((error) => options.logger.error("Feature gate subscriber failed", error));
  const stopListening = options.experiments.subscribe(() => {
    const reading = options.experiments.checkFeatureGate(SLATE_CODEBASE_TELEMETRY_FEATURE_GATE);
    if (reading === lastReading) return;
    lastReading = reading;
    listeners.notify({ kind: "some", gates: [CodebaseTelemetryFeatureGate.MAIN] });
  });
  return {
    receiver: {
      changes: { subscribe: listeners.subscribe },
      check: async (gate) => (gate === CodebaseTelemetryFeatureGate.MAIN ? await options.experiments.checkGate(SLATE_CODEBASE_TELEMETRY_FEATURE_GATE) : false),
    },
    dispose() {
      stopListening();
      listeners.clear();
    },
  };
}

export interface CodebaseTelemetryHostOptions {
  auth: AuthSourceOptions["auth"];
  experiments: FeatureGateSourceOptions["experiments"];
  privacyMode: { receiver: WatchReceiver<unknown>; setAuth(auth: TelemetryAuth): void; clearAuth(): void };
  createAdapter: (options: unknown) => Promise<unknown>;
  logger: AuthSourceOptions["logger"];
}

export function createSlateCodebaseTelemetryHost(options: CodebaseTelemetryHostOptions) {
  const auth = createAuthSource({ auth: options.auth, logger: options.logger, privacyMode: options.privacyMode });
  const featureGates = createFeatureGateSource({ experiments: options.experiments, logger: options.logger });
  return {
    logger: options.logger,
    auth: auth.receiver,
    privacyMode: options.privacyMode.receiver,
    featureGates: featureGates.receiver,
    desiredCodebases: {
      // The platform's own computer always has exactly these two: what it was asked to work on, and where the
      // account keeps its dotfiles.
      get: () => [
        { path: SLATE_BOX_WORKSPACE_ROOT, kind: CodebaseKind.WORKSPACE_ROOT },
        { path: SLATE_BOX_HOME_DIR, kind: CodebaseKind.HOME_DIRECTORY },
      ],
      changes: { subscribe: () => ({ dispose() {} }) },
    },
    createAdapter: options.createAdapter,
    dispose() {
      auth.dispose();
      featureGates.dispose();
    },
  };
}
