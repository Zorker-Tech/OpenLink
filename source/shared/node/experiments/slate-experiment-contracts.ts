import type {
  DynamicConfigName,
  ExperimentName,
  FeatureFlagName,
} from "./experiment-config.gen.ts";

export type RefreshTrigger = "startup" | "poll" | "auth_change" | "manual";

export interface FeatureFlagPanelItem {
  readonly name: FeatureFlagName;
  readonly value: boolean;
  readonly defaultValue: boolean;
  readonly override: boolean | null;
}

export interface FeatureFlagPanelSnapshot {
  readonly items: readonly FeatureFlagPanelItem[];
  readonly isLive: boolean;
}

export interface ExperimentSnapshot {
  readonly isInitialized: boolean;
  readonly featureGates: Record<string, boolean>;
  readonly experiments: Record<string, Record<string, unknown>>;
  readonly dynamicConfigs: Record<string, Record<string, unknown>>;
  readonly slateModelExperiment?: unknown;
  readonly slateModelFilterAllowedIds?: string[];
  readonly featureFlags?: FeatureFlagPanelSnapshot;
}

export interface ExperimentSnapshotReaders {
  readonly isInitialized: boolean;
  readonly hasAuthenticatedBootstrap: boolean;
  readonly isLiveBootstrap: boolean;
  readonly canUseOverrides: boolean;
  readonly readFeatureGate: (name: FeatureFlagName) => boolean;
  readonly readExperiment: (name: ExperimentName) => Record<string, unknown>;
  readonly readDynamicConfig: (name: DynamicConfigName) => Record<string, unknown>;
  readonly readModelExperimentState: () => unknown;
  readonly readOverrides: () => ReadonlyMap<FeatureFlagName, boolean>;
}
