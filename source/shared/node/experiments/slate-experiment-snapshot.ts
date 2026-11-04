import {
  DYNAMIC_CONFIGS,
  EXPERIMENTS,
  FLAGS,
  type DynamicConfigName,
  type ExperimentName,
  type FeatureFlagName,
} from "./experiment-config.gen.ts";
import { SLATE_MODEL_FILTER_CONFIG_NAME } from "./slate-model-config.ts";
import { isFlagName } from "./feature-flag-overrides.ts";
import type { ExperimentSnapshot, ExperimentSnapshotReaders } from "./slate-experiment-contracts.ts";

function collectFeatureGates(read: (name: FeatureFlagName) => boolean): Record<string, boolean> {
  const gates: Record<string, boolean> = {};
  for (const name of Object.keys(FLAGS)) {
    if (isFlagName(name)) gates[name] = read(name);
  }
  return gates;
}

function collectExperiments(read: (name: ExperimentName) => Record<string, unknown>): Record<string, Record<string, unknown>> {
  const values: Record<string, Record<string, unknown>> = {};
  for (const name of Object.keys(EXPERIMENTS) as ExperimentName[]) values[name] = read(name);
  return values;
}

function collectDynamicConfigs(read: (name: DynamicConfigName) => Record<string, unknown>): Record<string, Record<string, unknown>> {
  const values: Record<string, Record<string, unknown>> = {};
  for (const name of Object.keys(DYNAMIC_CONFIGS) as DynamicConfigName[]) values[name] = read(name);
  return values;
}

function readAllowedModelIds(
  readers: ExperimentSnapshotReaders,
  modelExperiment: unknown,
): string[] | undefined {
  if (!readers.hasAuthenticatedBootstrap || modelExperiment != null) return undefined;
  if (!Object.hasOwn(DYNAMIC_CONFIGS, SLATE_MODEL_FILTER_CONFIG_NAME)) return undefined;

  const raw = readers.readDynamicConfig(SLATE_MODEL_FILTER_CONFIG_NAME as DynamicConfigName).allowedModelIds;
  if (!Array.isArray(raw) || raw.length === 0 || !raw.every((id): id is string => typeof id === "string")) {
    return undefined;
  }
  return [...new Set(raw)];
}

function readFeatureFlagPanel(readers: ExperimentSnapshotReaders): ExperimentSnapshot["featureFlags"] {
  if (!readers.canUseOverrides) return undefined;

  const overrides = readers.readOverrides();
  const items = Object.keys(FLAGS)
    .filter(isFlagName)
    .map((name) => ({
      name,
      value: readers.readFeatureGate(name),
      defaultValue: FLAGS[name]?.default ?? false,
      override: overrides.get(name) ?? null,
    }));
  return { items, isLive: readers.isLiveBootstrap };
}

export function createExperimentSnapshot(readers: ExperimentSnapshotReaders): ExperimentSnapshot {
  const featureGates = collectFeatureGates(readers.readFeatureGate);
  const experiments = collectExperiments(readers.readExperiment);
  const dynamicConfigs = collectDynamicConfigs(readers.readDynamicConfig);
  const slateModelExperiment = readers.readModelExperimentState();
  const slateModelFilterAllowedIds = readAllowedModelIds(readers, slateModelExperiment);
  const featureFlags = readFeatureFlagPanel(readers);

  return {
    isInitialized: readers.isInitialized,
    featureGates,
    experiments,
    dynamicConfigs,
    ...(slateModelExperiment === undefined ? {} : { slateModelExperiment }),
    ...(slateModelFilterAllowedIds === undefined ? {} : { slateModelFilterAllowedIds }),
    ...(featureFlags === undefined ? {} : { featureFlags }),
  };
}
