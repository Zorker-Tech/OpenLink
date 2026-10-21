/**
 * The box store as a host extension.
 *
 * The extension does three things and nothing else: it gives the store the diagnostics sink, it builds the store with the
 * host's own policies (polling, debounce, retry, clock — all resolved here so the store never reads the environment), and
 * it hands back the API the rest of the platform asks for. Stopping the host disposes the store through the extension's
 * own stop hook, so the poll and the watcher stop with it.
 */
import { defineHostExtension } from "../../extensions/host-extensions.ts";
import { createDebouncePolicy, createPollingPolicy, createRetryPolicy, realClock } from "../../extensions/scheduling.ts";
import { HostExtensions } from "../../extensions/extension-ids.generated.ts";
import type { AgentStoreClientDependencies } from "./agent-store-slate-files.ts";
import { pinBoxStoreDiagnosticsReporter } from "./box-store-diagnostics.ts";
import { CHROME_SESSION_STAGE_MAX_ATTEMPTS, CHROME_SESSION_STAGE_RETRY_DELAY_MS, isChromeSessionStageRetryable } from "./chrome-session-stage.ts";
import {
  BOX_STORE_DB_DEBOUNCE_MS,
  BOX_STORE_MANIFEST_RETRY_ATTEMPTS,
  BOX_STORE_MANIFEST_RETRY_DELAY_MS,
  BOX_STORE_SYNC_INTERVAL_MS,
  CHROME_SESSION_CHANGE_DEBOUNCE_MS,
  createBoxStoreSyncService,
  type BoxStoreTelemetry,
} from "./box-store-sync-service.ts";
import { BoxStoreCanonicalWriteConflictError } from "./object-store-port.ts";

interface BoxStoreHost {
  isIdle(): boolean;
  log(message: string): void;
}

type BoxStoreAuth = AgentStoreClientDependencies;

interface BoxStoreSourceMap {
  getOrCreateBoxStore(): Promise<{ sourceId: string }>;
}

interface BoxStoreLogs extends BoxStoreTelemetry {
  reportHostExtensionDiagnostic(diagnostic: Record<string, unknown>): void;
}

export const boxStoreSyncExtension = defineHostExtension<unknown, BoxStoreHost>({
  id: HostExtensions.BoxStoreSync,
  dependencies: [HostExtensions.Auth, HostExtensions.Mcp, HostExtensions.SourceMap, HostExtensions.Telemetry],
  start: (context) => {
    const auth = context.deps[HostExtensions.Auth] as BoxStoreAuth;
    const sourceMap = context.deps[HostExtensions.SourceMap] as BoxStoreSourceMap;
    const telemetry = context.deps[HostExtensions.Telemetry] as { logs: BoxStoreLogs };
    pinBoxStoreDiagnosticsReporter((diagnostic) => telemetry.logs.reportHostExtensionDiagnostic(diagnostic));
    const service = createBoxStoreSyncService({
      auth,
      sourceMap,
      telemetry: telemetry.logs,
      isIdle: context.host.isIdle,
      polling: createPollingPolicy(realClock, { name: "box-store-sync-cycle", intervalMs: BOX_STORE_SYNC_INTERVAL_MS }),
      storeDbDebounce: createDebouncePolicy(realClock, { name: "box-store-sync-store-db", delayMs: BOX_STORE_DB_DEBOUNCE_MS }),
      chromeSessionDebounce: createDebouncePolicy(realClock, { name: "box-store-sync-chrome-session", delayMs: CHROME_SESSION_CHANGE_DEBOUNCE_MS }),
      // A manifest conflict is the one failure that is worth retrying here: it means another host wrote, and the next
      // attempt is written against what that host left.
      manifestRetry: createRetryPolicy(realClock, {
        name: "box-store-sync-manifest-cas",
        maxAttempts: BOX_STORE_MANIFEST_RETRY_ATTEMPTS,
        initialDelayMs: BOX_STORE_MANIFEST_RETRY_DELAY_MS,
        maxDelayMs: BOX_STORE_MANIFEST_RETRY_DELAY_MS,
        shouldRetry: (error) => error instanceof BoxStoreCanonicalWriteConflictError,
      }),
      chromeStageRetry: createRetryPolicy(realClock, {
        name: "box-store-sync-chrome-stage",
        maxAttempts: CHROME_SESSION_STAGE_MAX_ATTEMPTS,
        initialDelayMs: CHROME_SESSION_STAGE_RETRY_DELAY_MS,
        maxDelayMs: CHROME_SESSION_STAGE_RETRY_DELAY_MS,
        shouldRetry: isChromeSessionStageRetryable,
      }),
      clock: realClock,
      log: context.host.log,
    });
    context.onStop(() => service.dispose());
    service.start();
    return service.api;
  },
});
