export const SLATE_SENTRY_DSN = "";
export const SLATE_SENTRY_CONVERSATION_TAG = "slate.conversation_id";
export const SENTRY_EVENT_ID_PATTERN = /^[0-9a-f]{32}$/;
export const MAX_SPOOL_PURGE_SHIFTS = 64;

export type SlateSentryEnvelope = [
  Record<string, unknown>,
  Array<[Record<string, unknown>, unknown]>,
];

export interface SlateSentrySpoolStore {
  push(envelope: unknown): unknown;
  unshift(envelope: unknown): Promise<unknown>;
  shift(): Promise<unknown | undefined>;
}
