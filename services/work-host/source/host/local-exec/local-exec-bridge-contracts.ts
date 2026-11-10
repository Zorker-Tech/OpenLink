/** Slate-owned frame, provider and telemetry shapes for the local-exec bridge. */
import type { Clock, IdleWatchdogPolicy } from "../extensions/scheduling.ts";

export const SUPERVISED_RANK = 4;
export const VARIANT_RANKS: Readonly<Record<string, number>> = { slate: 2, "slate-lab": 1 };
export const TELEMETRY_VARIANTS = new Set(["slate", "slate-lab", "slate-dev"]);
export const DEFAULT_SLATE_COMPUTER_ID = "this-computer";

export interface LocalExecBridgeContext {
  readonly signal: AbortSignal;
  readonly agentId?: string;
}

export interface LocalExecComputer {
  readonly id: string;
  readonly label: string;
  readonly connected: boolean;
}

export interface LocalExecProviderInfo {
  readonly localRoot: string;
  readonly terminalsFolder: string;
}

export interface LocalExecBridgeFrame {
  readonly kind: string;
  readonly requestId?: string;
  readonly [key: string]: unknown;
}

export interface LocalExecProviderReport {
  readonly phase: "registered" | "detached" | "hello";
  readonly providerId: string;
  readonly providerCount: number;
  readonly [key: string]: unknown;
}

export interface LocalExecRefusedReport {
  readonly cause: "no_providers" | "computer_unknown" | "stale_heartbeat";
  readonly site: string;
  readonly providerCount: number;
  readonly liveProviderCount: number;
  readonly everRegistered: boolean;
  readonly [key: string]: unknown;
}

export interface LocalExecBridgeDeps {
  readonly clock: Clock;
  readonly responseWatchdog: IdleWatchdogPolicy;
  readonly blockedReason: () => string | undefined;
  readonly report?: {
    readonly provider?: (report: LocalExecProviderReport) => void;
    readonly refused?: (report: LocalExecRefusedReport) => void;
  };
  readonly randomId?: () => string;
}

export function localExecProviderRank(signals: { readonly supervised?: boolean; readonly variant?: string }): number {
  const trust = signals.supervised === true ? SUPERVISED_RANK : 0;
  const variant = signals.variant == null ? 0 : VARIANT_RANKS[signals.variant] ?? 0;
  return trust + variant;
}

export function boundedLocalExecVariant(variant: string | undefined): string | undefined {
  if (variant === undefined) return undefined;
  return TELEMETRY_VARIANTS.has(variant) ? variant : "unknown";
}
