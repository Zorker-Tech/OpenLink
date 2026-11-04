import type { GithubTrigger, SlackTrigger } from "../../shared/automations.ts";
import type { PollingPolicy } from "../extensions/scheduling.ts";
import type { ListenerScopeIssue } from "./listener-platforms.ts";

export const DEFAULT_REGISTER_INTERVAL_MS = 5 * 60_000;
export const DEGRADED_REGISTER_INTERVAL_MS = 60_000;
export const ERROR_BACKOFF_MS = 30_000;

export interface RelayWireEvent extends Record<string, unknown> {
  readonly source: "slack" | "github";
  readonly kind?: unknown;
  readonly timestampMs?: number;
}

export interface RelayStatus {
  readonly state: string;
  readonly detail?: string;
  readonly scopeIssues?: readonly ListenerScopeIssue[];
}

export interface BackendRelaySourceOptions {
  readonly getAccessToken: (args: { backendUrl: string }) => Promise<string>;
  readonly getBackendUrl: () => string;
  readonly polling: PollingPolicy;
  readonly fetchImpl?: typeof fetch;
  readonly registerIntervalMs?: number;
  readonly degradedRegisterIntervalMs?: number;
  readonly isNotifyConnected?: () => boolean;
  readonly isNotifySafetyPollEnabled?: () => boolean;
}

export type SlackRelaySink = (event: Record<string, unknown>) => boolean;
export type GithubRelaySink = (event: Record<string, unknown>) => boolean;
export type ListenerHubSource<TListener, TSink> = {
  readonly kind: string;
  start(sink: TSink | null): Promise<void>;
  setListeners(listeners: readonly TListener[]): void;
  stop(): Promise<void>;
  getStatus(): RelayStatus;
};
export type RelaySourceBundle = {
  readonly slack: ListenerHubSource<SlackTrigger, SlackRelaySink>;
  readonly github: ListenerHubSource<GithubTrigger, GithubRelaySink>;
  requestDrain(): void;
};
