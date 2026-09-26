/**
 * Reporting which model-experiment arm a turn was exposed to.
 *
 * What is reported waits until the experiment's statistics have hydrated, and is only reported once per conversation
 * and arm, so an exposure is counted once however many turns follow it.
 */
import { readSlateModelExperimentEnvOverride } from "../../shared/node/experiments/slate-model-experiment.ts";
export const HYDRATION_WAIT_MS = 60_000;
export interface ModelExperimentExposureDeps {
  experiments: {
    hasHydratedStatsigUserId(): boolean;
    waitForHydratedStatsigUserId(timeoutMs: number): Promise<boolean>;
    getSlateModelExperimentState():
      { active: boolean; arm: string } | null | undefined;
    logSlateModelExperimentExposure(): boolean;
  };
  analytics: {
    canRecordEvents(): boolean;
    trackEvent(name: string, properties: { arm: string }): void;
  };
  env?: NodeJS.ProcessEnv;
}
export function createModelExperimentExposureLatch(
  deps: ModelExperimentExposureDeps,
) {
  let logged = false;
  async function flush() {
    if (logged) return;
    const envOverride = readSlateModelExperimentEnvOverride(
      deps.env ?? process.env,
    );
    if (envOverride == null && !deps.experiments.hasHydratedStatsigUserId()) {
      const ready =
        await deps.experiments.waitForHydratedStatsigUserId(HYDRATION_WAIT_MS);
      if (logged || !ready) return;
    }
    const state = envOverride ?? deps.experiments.getSlateModelExperimentState();
    if (state == null || !state.active) return;
    const sdkExposed = deps.experiments.logSlateModelExperimentExposure();
    if (!sdkExposed) {
      if (envOverride == null || !deps.analytics.canRecordEvents()) return;
    }
    logged = true;
    if (deps.analytics.canRecordEvents())
      deps.analytics.trackEvent("slate.model_experiment.exposure", {
        arm: state.arm,
      });
  }
  return {
    note: () => {
      if (!logged) void flush();
    },
  };
}
