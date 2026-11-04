import type { IdleWatchdogPolicy, RetryPolicy } from "../scheduling.ts";

export const SLATE_NOTIFY_TOPIC_FLAGS = {
  "automation-fires": true,
  "listener-events": true,
  "xuser-events": true,
} as const;

export type SlateNotifyTopic = keyof typeof SLATE_NOTIFY_TOPIC_FLAGS;
export const SLATE_NOTIFY_TOPICS = Object.keys(SLATE_NOTIFY_TOPIC_FLAGS) as SlateNotifyTopic[];
export const HEALTHY_CONNECTION_MIN_LIFETIME_MS = 30_000;

export type SlateNotifyFrame =
  | { readonly kind: "connected" }
  | { readonly kind: "notify"; readonly topic: SlateNotifyTopic }
  | { readonly kind: "ignored" };

export class SlateNotifyStreamError extends Error {
  constructor(readonly status: number) {
    super(`slate notify stream failed: ${status}`);
    this.name = "SlateNotifyStreamError";
  }
}

export interface SlateNotifyBusClientDependencies {
  readonly getBackendUrl: () => string;
  readonly getAccessToken: (options: { readonly backendUrl: string }) => Promise<string>;
  readonly onConnected: () => void;
  readonly onNotify: (topic: SlateNotifyTopic) => void;
  readonly onStreamError: (error: unknown) => void;
  readonly reconnectBackoff: RetryPolicy;
  readonly stallWatchdog: IdleWatchdogPolicy;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}
