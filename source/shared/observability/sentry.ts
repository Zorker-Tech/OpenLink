/** Public privacy and spool boundaries for crash-report delivery. */

export {
  SLATE_SENTRY_DSN,
  SLATE_SENTRY_CONVERSATION_TAG,
  SENTRY_EVENT_ID_PATTERN,
  MAX_SPOOL_PURGE_SHIFTS,
} from "./sentry-contracts.ts";
export type { SlateSentryEnvelope, SlateSentrySpoolStore } from "./sentry-contracts.ts";

export {
  isUnknownProcessEnvelope,
  envelopeAccount,
  SlateSentryPrivacyGate,
} from "./sentry-envelope-policy.ts";
export { gateEnvelopeSend, gateTransport } from "./sentry-send-gate.ts";
export { purgeableSpoolStore, captureOfflineSpoolStore } from "./sentry-spool-store.ts";
export { SlateSentryAccountPrivacySync } from "./sentry-account-sync.ts";
export { SlateSentryEventIdRing } from "./sentry-event-id-ring.ts";
