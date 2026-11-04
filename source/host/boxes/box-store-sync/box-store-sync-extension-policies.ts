import { createDebouncePolicy, createPollingPolicy, createRetryPolicy, realClock } from "../../extensions/scheduling.ts"
import {
  CHROME_SESSION_STAGE_MAX_ATTEMPTS,
  CHROME_SESSION_STAGE_RETRY_DELAY_MS,
  isChromeSessionStageRetryable,
} from "./chrome-session-stage.ts"
import { BoxStoreCanonicalWriteConflictError } from "./object-store-port.ts"
import {
  BOX_STORE_DB_DEBOUNCE_MS,
  BOX_STORE_MANIFEST_RETRY_ATTEMPTS,
  BOX_STORE_MANIFEST_RETRY_DELAY_MS,
  BOX_STORE_SYNC_INTERVAL_MS,
  CHROME_SESSION_CHANGE_DEBOUNCE_MS,
} from "./box-store-sync-service.ts"

export function createBoxStoreSyncExtensionPolicies() {
  return {
    polling: createPollingPolicy(realClock, {
      name: "box-store-sync-cycle",
      intervalMs: BOX_STORE_SYNC_INTERVAL_MS,
    }),
    storeDbDebounce: createDebouncePolicy(realClock, {
      name: "box-store-sync-store-db",
      delayMs: BOX_STORE_DB_DEBOUNCE_MS,
    }),
    chromeSessionDebounce: createDebouncePolicy(realClock, {
      name: "box-store-sync-chrome-session",
      delayMs: CHROME_SESSION_CHANGE_DEBOUNCE_MS,
    }),
    manifestRetry: createRetryPolicy(realClock, {
      name: "box-store-sync-manifest-cas",
      maxAttempts: BOX_STORE_MANIFEST_RETRY_ATTEMPTS,
      initialDelayMs: BOX_STORE_MANIFEST_RETRY_DELAY_MS,
      maxDelayMs: BOX_STORE_MANIFEST_RETRY_DELAY_MS,
      shouldRetry: error => error instanceof BoxStoreCanonicalWriteConflictError,
    }),
    chromeStageRetry: createRetryPolicy(realClock, {
      name: "box-store-sync-chrome-stage",
      maxAttempts: CHROME_SESSION_STAGE_MAX_ATTEMPTS,
      initialDelayMs: CHROME_SESSION_STAGE_RETRY_DELAY_MS,
      maxDelayMs: CHROME_SESSION_STAGE_RETRY_DELAY_MS,
      shouldRetry: isChromeSessionStageRetryable,
    }),
    clock: realClock,
  }
}
