import type { HostBundleSource } from "./host-bundle-source.ts";
import type { HostBundleUpdateState } from "./host-bundle-upgrade.ts";
import type { HostUpgradeMetadata } from "./host-upgrade-marker.ts";

export interface HostUpgradeDisposable {
  dispose(): void;
}

export interface HostUpgradeWakePolicy {
  start(callback: () => Promise<void>): HostUpgradeDisposable;
}

export interface HostUpgradeServiceDependencies {
  readonly automations: { suspendWakes(): Promise<void> };
  readonly sharing: { prepareForUpgrade(): void };
  readonly transcript: { quiesceForUpgrade(): Promise<unknown>; resumeInterruptedUpgradeTurns(): Promise<void> };
  readonly telemetry: {
    reportHostUpgrade(metadata: Record<string, string | undefined>): void;
    reportHostUpgradeConfirmed(metadata: HostUpgradeMetadata): Promise<boolean>;
  };
  readonly markerStore: { readRaw(): Promise<string | null>; deleteMarker(): Promise<void> };
  readonly markerForwardPolicy: HostUpgradeWakePolicy;
  readonly createUpdateWatchDelayPolicy: (delayMs: number) => HostUpgradeWakePolicy;
  readonly clock: { now(): number };
  readonly random: () => number;
  readonly isInBox: boolean;
  readonly isAutoUpdateEnabled: boolean;
  readonly updateWatchIntervalMs: number;
  readonly updateWatchJitterRatio: number;
  readonly resolveBundleSource: () => Promise<HostBundleSource | undefined>;
  readonly readLocalVersion: () => Promise<string | null>;
  readonly isVersionSwapVetoed: (args: { version: string; localVersion: string | null }) => Promise<boolean>;
  readonly stageUpgrade: (args: { version: string; bytes: Uint8Array; forceNow: boolean; reason: string }) => Promise<unknown>;
  readonly log: (level: "info" | "warn", message: string) => void;
}

export type HostUpdateNowResult =
  | { started: true; version: string }
  | { started: false; reason: string; version?: string };

export interface HostUpgradeWatchOptions {
  readonly isBoxAutoUpdateEnabled: boolean;
  runRootUpdateTick(): Promise<void>;
}

export interface HostUpgradeUpdateState extends HostBundleUpdateState {}
