/**
 * The codebase telemetry, declared as a host extension.
 *
 * The platform's own computer reports what its codebases are doing through a helper that ships beside the host. When
 * that helper is not there to run — or is there but cannot be executed — there is no telemetry at all, and the host is
 * told which of the two it was rather than left thinking it works; the surface the extension hands back is the same
 * either way, so a caller may flush a host that never had anything to flush.
 *
 * When it can run, everything the service needs is built here and named: where the helper keeps what it knows, which
 * backend it talks to, how often it uploads, and the four policies the privacy lookup, the restarts and the shutdown
 * run under.
 */

import { join } from "node:path";
import { getSlateInferenceBackendUrl } from "../../../adapters/interop/slate-backend/slate-backend-client.ts";
import { createCodebaseTelemetryUploadCredentialsAdapter } from "../../../adapters/interop/telemetry/codebase-telemetry-upload-credentials-adapter.ts";
import { getSlateRootDir } from "../../host-paths.ts";
import { defineHostExtension } from "../host-extensions.ts";
import { HostExtensions } from "../extension-ids.generated.ts";
import { createDeadlinePolicy, createRealPollingPolicy, createRealRetryPolicy, realClock } from "../scheduling.ts";
import { CsnapsCodebaseTelemetryAdapter } from "./codebase-telemetry-adapter.ts";
import { csnapsAvailability } from "./csnaps-capability.ts";
import { createCodebaseTelemetryService, createSlateCodebaseTelemetryLogger } from "./codebase-telemetry-service.ts";
import { spawnCsnaps } from "./csnaps-process.ts";
import { createSlatePrivacyModeLoader, isRetryablePrivacyModeLookupError, type TelemetryAuth } from "./privacy-mode.ts";

export { csnapsPath, csnapsAvailability } from "./csnaps-capability.ts";

/** Where the host keeps what the helper knows: the account's codebase identities, and its snapshots. */
export const CODEBASE_UUID_STATE_FILENAME = "telemetry/codebase-uuids.json";
export const SNAPSHOTS_BASE_DIR = "/var/lib/slate/telemetry/codebase";
export const SNAPSHOT_UPLOAD_INTERVAL_MS = 5 * 60_000;
export const PRIVACY_REFRESH_INTERVAL_MS = 5 * 60_000;

interface CodebaseTelemetryHost {
  log(message: string): void;
  events: Parameters<typeof createCodebaseTelemetryService>[0]["events"];
}

type ExtensionAuth = Parameters<typeof createCodebaseTelemetryService>[0]["auth"] & { getMachineId(): Promise<string> };

/** What the helper is started with: where it keeps what it knows, who it talks to, and how its uploads are paced. */
export function codebaseTelemetryAdapterOptions(options: {
  readonly credentials: TelemetryAuth;
  readonly signal: AbortSignal;
  readonly executablePath: string;
  readonly auth: ExtensionAuth;
  readonly logger: Parameters<typeof createCodebaseTelemetryService>[0]["logger"];
}) {
  return {
    credentials: options.credentials,
    paths: { codebaseUuidStatePath: join(getSlateRootDir(), CODEBASE_UUID_STATE_FILENAME), snapshotsBaseDir: SNAPSHOTS_BASE_DIR },
    backendUrl: getSlateInferenceBackendUrl(),
    csnapsBinPath: options.executablePath,
    spawnCsnaps,
    uploadPolling: createRealPollingPolicy({ name: "codebase-snapshot-upload", intervalMs: SNAPSHOT_UPLOAD_INTERVAL_MS }),
    // Every upload carries the account's own credential and the headers the backend expects of this host.
    createUploadCredentials: () => createCodebaseTelemetryUploadCredentialsAdapter(options),
    logger: options.logger,
    signal: options.signal,
  };
}

/** The policies the service runs on: how long a privacy lookup may take and how often it is refreshed, how long a
 * restart waits before it is tried again, and how long a shutdown has before it is called overdue. */
export function createCodebaseTelemetryPolicies() {
  return {
    privacyLookupDeadline: createDeadlinePolicy(realClock, { name: "codebase-telemetry-privacy-lookup", timeoutMs: 3_000 }),
    privacyLookupRetry: createRealRetryPolicy({ name: "codebase-telemetry-privacy-lookup-retry", maxAttempts: 2, initialDelayMs: 10_000, maxDelayMs: 10_000, shouldRetry: isRetryablePrivacyModeLookupError }),
    privacyRefreshPolling: createRealPollingPolicy({ name: "codebase-telemetry-privacy-refresh", intervalMs: PRIVACY_REFRESH_INTERVAL_MS }),
    sessionRestartDelay: createRealRetryPolicy({ name: "codebase-telemetry-session-restart", maxAttempts: 2, initialDelayMs: 30_000, maxDelayMs: 30_000 }),
    shutdownDeadline: createDeadlinePolicy(realClock, { name: "codebase-telemetry-shutdown", timeoutMs: 30_000 }),
  };
}

/** What the host is handed when there is nothing to run: the same surface, answering that there is nothing. */
function createUnavailableTelemetryApi(): { flushPendingUploads(): Promise<void> } {
  return {
    async flushPendingUploads(): Promise<void> {},
  };
}

export const codebaseTelemetryExtension = defineHostExtension({
  id: HostExtensions.CodebaseTelemetry,
  // What it follows is the account, and whether the feature is on at all.
  dependencies: [HostExtensions.Auth, HostExtensions.Experiments],
  start: (context) => {
    const host = context.host as CodebaseTelemetryHost;
    const deps = context.deps as {
      auth: Parameters<typeof createCodebaseTelemetryService>[0]["auth"] & { getMachineId(): Promise<string> };
      experiments: Parameters<typeof createCodebaseTelemetryService>[0]["experiments"];
    };
    const logger = createSlateCodebaseTelemetryLogger(host.log);
    const capability = csnapsAvailability();
    if (!capability.available) {
      // Not there and not runnable are told apart, because only one of them is a mistake to fix.
      logger.warn(`Codebase Telemetry unavailable: csnaps ${capability.reason} at ${capability.executablePath}`);
      return createUnavailableTelemetryApi();
    }
    const service = createCodebaseTelemetryService({
      auth: deps.auth,
      experiments: deps.experiments,
      events: host.events,
      createAdapter: ({ credentials, signal }) => CsnapsCodebaseTelemetryAdapter.create(codebaseTelemetryAdapterOptions({ credentials, signal, executablePath: capability.executablePath, auth: deps.auth, logger })),
      loadPrivacyMode: createSlatePrivacyModeLoader(deps.auth),
      policies: createCodebaseTelemetryPolicies(),
      logger,
    });
    context.onStop(() => service.dispose());
    return service.api;
  },
});
