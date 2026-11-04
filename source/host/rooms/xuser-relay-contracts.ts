import type { Clock, PollingPolicy } from "../extensions/scheduling.ts";

export const XUSER_RELAY_POLL_INTERVAL_MS = 4_000;
export const XUSER_RELAY_ERROR_BACKOFF_MS = 30_000;

export class SlateXuserRelayHttpError extends Error {
  constructor(readonly status: number, readonly path: string) {
    super(`slate sharing ${path} returned ${status}`);
    this.name = "SlateXuserRelayHttpError";
  }
}

export interface XuserRelayClientDependencies {
  readonly getBackendUrl: () => string;
  readonly getAccessToken: (options: { backendUrl: string }) => Promise<string>;
  readonly onEvent: (event: Record<string, unknown>) => Promise<boolean>;
  readonly pollPolicy: PollingPolicy;
  readonly clock: Pick<Clock, "now">;
  readonly fetchImpl?: typeof fetch;
  readonly isNotifyConnected?: () => boolean;
  readonly isNotifySafetyPollEnabled?: () => boolean;
  readonly onPollError?: (error: unknown) => void;
}
